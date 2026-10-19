// SQLite persistence for the CCUsage sync server.
//
// One database serves every account; every row is scoped by account_id so a
// token can only ever reach its own account's data. The schema is created on
// start-up (CREATE TABLE IF NOT EXISTS), so pointing at a fresh path just works.
//
// node:sqlite's DatabaseSync is synchronous. That is deliberate: Node runs one
// request handler at a time, so a multi-statement write wrapped in a transaction
// cannot interleave with another request, and no async locking is needed.

import { DatabaseSync } from "node:sqlite";
import type {
  AccountInfo,
  CostBreakdown,
  DeviceInfo,
  PlanInfo,
  QuotaKind,
  QuotaObservation,
  ObservationSource,
  SyncSessionMeta,
  TokenCounts,
  UsageEntry,
} from "@ccusage/core";
import { classifyAuthSignals } from "@ccusage/core";

/** SQLite stores timestamps as INTEGER epoch milliseconds, like the app. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  app_version  TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_account ON devices (account_id);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_device ON tokens (account_id, device_id);

CREATE TABLE IF NOT EXISTS entries (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp  INTEGER NOT NULL,
  model      TEXT NOT NULL,
  tokens_json TEXT NOT NULL,
  cost_json   TEXT NOT NULL,
  is_fast    INTEGER NOT NULL,
  agent_id   TEXT,
  is_priced  INTEGER NOT NULL,
  UNIQUE (account_id, id)
);
CREATE INDEX IF NOT EXISTS entries_account_seq ON entries (account_id, seq);
CREATE INDEX IF NOT EXISTS entries_account_ts  ON entries (account_id, timestamp);

CREATE TABLE IF NOT EXISTS observations (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  observed_at     INTEGER NOT NULL,
  resets_at       INTEGER NOT NULL,
  used_percentage REAL NOT NULL,
  source          TEXT NOT NULL,
  session_id      TEXT,
  UNIQUE (account_id, kind, observed_at, resets_at, device_id)
);
CREATE INDEX IF NOT EXISTS observations_account_observed ON observations (account_id, observed_at);

-- Latest plan reported by any device (GET /sync returns it).
CREATE TABLE IF NOT EXISTS plan (
  account_id        TEXT PRIMARY KEY,
  tier              TEXT NOT NULL,
  organization_type TEXT,
  fetched_at        INTEGER NOT NULL
);

-- Append-only tier log, mirrors ~/.claude/plan-history.jsonl; planChanges() turns
-- consecutive different tiers into PlanChange[] for quota estimates.
CREATE TABLE IF NOT EXISTS plan_history (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT NOT NULL,
  tier              TEXT NOT NULL,
  organization_type TEXT,
  fetched_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_history_account ON plan_history (account_id, seq);

-- Session metadata reported by each device, so peers see real titles instead of
-- synthesized per-device labels.
CREATE TABLE IF NOT EXISTS sessions (
  account_id   TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  id           TEXT NOT NULL,
  title        TEXT NOT NULL,
  project_name TEXT NOT NULL,
  cwd          TEXT,
  start        INTEGER NOT NULL,
  end          INTEGER NOT NULL,
  auth_mode    TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS sessions_account_device ON sessions (account_id, device_id);
`;

export interface AccountRecord {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
}

/** What the bearer middleware needs after a token lookup. */
export interface AuthRecord {
  accountId: string;
  deviceId: string;
  account: AccountInfo;
}

export interface EntryWithSeq {
  seq: number;
  entry: UsageEntry;
}

export interface Totals {
  todayCost: number;
  todayRequests: number;
  weekCost: number;
}

export interface NewAccount {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
}

type SqlRow = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bool(value: unknown): boolean {
  return num(value) !== 0;
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toTokenCounts(raw: Record<string, unknown> | undefined): TokenCounts {
  return {
    input: num(raw?.input),
    output: num(raw?.output),
    cacheRead: num(raw?.cacheRead),
    cacheWrite5m: num(raw?.cacheWrite5m),
    cacheWrite1h: num(raw?.cacheWrite1h),
    webSearches: num(raw?.webSearches),
  };
}

function toCostBreakdown(raw: Record<string, unknown> | undefined): CostBreakdown {
  return {
    input: num(raw?.input),
    output: num(raw?.output),
    cacheRead: num(raw?.cacheRead),
    cacheWrite: num(raw?.cacheWrite),
    webSearch: num(raw?.webSearch),
  };
}

function costTotal(cost: CostBreakdown): number {
  return cost.input + cost.output + cost.cacheRead + cost.cacheWrite + cost.webSearch;
}

function isQuotaKind(value: string): value is QuotaKind {
  return value === "fiveHour" || value === "sevenDay";
}

function isObservationSource(value: string): value is ObservationSource {
  return value === "statusLine" || value === "limitMessage";
}

export class SyncStore {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // WAL keeps reads fast while a write transaction is open; busy_timeout makes
    // the second process (e.g. a second server instance on the same file) wait
    // rather than fail immediately.
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // In-memory or read-only filesystems do not support WAL.
    }
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    // Lightweight migration for databases created before session auth tracking.
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as SqlRow[];
    if (!sessionColumns.some((column) => str(column.name) === "auth_mode")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN auth_mode TEXT");
    }
  }

  close(): void {
    this.txDepth = 0;
    this.db.close();
  }

  /** Runs `fn` inside one write transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    } finally {
      this.txDepth--;
    }
  }

  // MARK: - Accounts

  /** Returns undefined when the username is already taken (no exception thrown). */
  createAccount(account: NewAccount): AccountRecord | undefined {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO accounts (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(account.id, account.username, account.passwordHash, account.salt, account.createdAt);
    if (Number(result.changes) === 0) return undefined;
    return {
      id: account.id,
      username: account.username,
      passwordHash: account.passwordHash,
      salt: account.salt,
      createdAt: account.createdAt,
    };
  }

  /** Every account, oldest first (no password material). */
  listAccounts(): Array<{ id: string; username: string; createdAt: number }> {
    const rows = this.db
      .prepare("SELECT id, username, created_at FROM accounts ORDER BY created_at")
      .all() as SqlRow[];
    return rows.map((row) => ({ id: str(row.id), username: str(row.username), createdAt: num(row.created_at) }));
  }

  accountByUsername(username: string): AccountRecord | undefined {
    const row = this.db
      .prepare("SELECT id, username, password_hash, salt, created_at FROM accounts WHERE username = ?")
      .get(username) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      id: str(row.id),
      username: str(row.username),
      passwordHash: str(row.password_hash),
      salt: str(row.salt),
      createdAt: num(row.created_at),
    };
  }

  /** Replaces an account's password hash/salt; false when the id is unknown. */
  updatePassword(accountId: string, passwordHash: string, salt: string): boolean {
    const result = this.db
      .prepare("UPDATE accounts SET password_hash = ?, salt = ? WHERE id = ?")
      .run(passwordHash, salt, accountId);
    return Number(result.changes) > 0;
  }

  accountById(id: string): AccountInfo | undefined {
    const row = this.db.prepare("SELECT id, username FROM accounts WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? { id: str(row.id), username: str(row.username) } : undefined;
  }

  /** True when `deviceId` is unused or already belongs to `accountId`. */
  canUseDeviceId(accountId: string, deviceId: string): boolean {
    const row = this.db.prepare("SELECT account_id FROM devices WHERE id = ?").get(deviceId) as SqlRow | undefined;
    return row === undefined || str(row.account_id) === accountId;
  }

  // MARK: - Devices

  /** Insert or update a device; last_seen_at only moves forward. */
  upsertDevice(accountId: string, device: Omit<DeviceInfo, "isSelf">): DeviceInfo {
    this.db
      .prepare(
        `INSERT INTO devices (id, account_id, name, platform, app_version, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             platform = excluded.platform,
             app_version = excluded.app_version,
             last_seen_at = MAX(devices.last_seen_at, excluded.last_seen_at)`
      )
      .run(device.id, accountId, device.name, device.platform, device.appVersion, device.lastSeenAt);
    return { ...device };
  }

  touchDevice(accountId: string, deviceId: string, lastSeenAt: number): void {
    this.db.prepare("UPDATE devices SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ? AND account_id = ?").run(lastSeenAt, deviceId, accountId);
  }

  devices(accountId: string): DeviceInfo[] {
    const rows = this.db
      .prepare("SELECT id, name, platform, app_version, last_seen_at FROM devices WHERE account_id = ? ORDER BY last_seen_at DESC")
      .all(accountId) as SqlRow[];
    return rows.map((row) => ({
      id: str(row.id),
      name: str(row.name),
      platform: str(row.platform),
      appVersion: str(row.app_version),
      lastSeenAt: num(row.last_seen_at),
    }));
  }

  /** Removes the device and its tokens; historical entries/observations are kept. */
  deleteDevice(accountId: string, deviceId: string): boolean {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM tokens WHERE account_id = ? AND device_id = ?").run(accountId, deviceId);
      const result = this.db.prepare("DELETE FROM devices WHERE id = ? AND account_id = ?").run(deviceId, accountId);
      return Number(result.changes) > 0;
    });
  }

  // MARK: - Tokens

  createToken(tokenHash: string, accountId: string, deviceId: string, createdAt: number): void {
    this.db.prepare("INSERT INTO tokens (token_hash, account_id, device_id, created_at) VALUES (?, ?, ?, ?)").run(tokenHash, accountId, deviceId, createdAt);
  }

  findAuth(tokenHash: string): AuthRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT t.account_id, t.device_id, a.username
           FROM tokens t JOIN accounts a ON a.id = t.account_id
           WHERE t.token_hash = ?`
      )
      .get(tokenHash) as SqlRow | undefined;
    if (!row) return undefined;
    const accountId = str(row.account_id);
    return { accountId, deviceId: str(row.device_id), account: { id: accountId, username: str(row.username) } };
  }

  revokeToken(tokenHash: string): boolean {
    const result = this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(tokenHash);
    return Number(result.changes) > 0;
  }

  revokeDeviceTokens(accountId: string, deviceId: string): number {
    const result = this.db.prepare("DELETE FROM tokens WHERE account_id = ? AND device_id = ?").run(accountId, deviceId);
    return Number(result.changes);
  }

  // MARK: - Entries

  /**
   * Inserts entries, ignoring ones whose id was already ingested for the account
   * (the same request can be reported by a local device and, later, a peer).
   */
  insertEntries(accountId: string, deviceId: string, entries: UsageEntry[]): { accepted: number; deduped: number } {
    return this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO entries
           (account_id, id, device_id, session_id, timestamp, model, tokens_json, cost_json, is_fast, agent_id, is_priced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let accepted = 0;
      for (const entry of entries) {
        const result = insert.run(
          accountId,
          entry.id,
          deviceId,
          entry.sessionId,
          Math.round(entry.timestamp),
          entry.model,
          JSON.stringify(entry.tokens),
          JSON.stringify(entry.cost),
          entry.isFast ? 1 : 0,
          entry.agentId ?? null,
          entry.isPriced ? 1 : 0
        );
        accepted += Number(result.changes);
      }
      return { accepted, deduped: entries.length - accepted };
    });
  }

  /**
   * Entries inside the quota lookback window, oldest first. The historical window
   * computation (QuotaCalculator.windows) walks entries in timestamp order.
   */
  entriesForQuota(accountId: string, minTimestamp: number): UsageEntry[] {
    const rows = this.db
      .prepare(
        "SELECT seq, account_id, id, device_id, session_id, timestamp, model, tokens_json, cost_json, is_fast, agent_id, is_priced FROM entries WHERE account_id = ? AND timestamp >= ? ORDER BY timestamp ASC, seq ASC"
      )
      .all(accountId, minTimestamp) as SqlRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  /** Entries written by other devices after the client's cursor (seq). */
  remoteEntries(accountId: string, deviceId: string, sinceSeq: number): EntryWithSeq[] {
    const rows = this.db
      .prepare(
        "SELECT seq, account_id, id, device_id, session_id, timestamp, model, tokens_json, cost_json, is_fast, agent_id, is_priced FROM entries WHERE account_id = ? AND seq > ? AND device_id <> ? ORDER BY seq ASC"
      )
      .all(accountId, sinceSeq, deviceId) as SqlRow[];
    return rows.map((row) => ({ seq: num(row.seq), entry: this.rowToEntry(row) }));
  }

  maxEntrySeq(accountId: string): number {
    const row = this.db.prepare("SELECT MAX(seq) AS max_seq FROM entries WHERE account_id = ?").get(accountId) as SqlRow | undefined;
    return row ? num(row.max_seq) : 0;
  }

  entryCount(accountId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE account_id = ?").get(accountId) as SqlRow | undefined;
    return row ? num(row.count) : 0;
  }

  /** Totals shown on the dashboard: all devices, local-clock day and rolling 7 days. */
  totals(accountId: string, todayStart: number, weekStart: number): Totals {
    const rows = this.db
      .prepare("SELECT timestamp, cost_json FROM entries WHERE account_id = ? AND timestamp >= ?")
      .all(accountId, weekStart) as SqlRow[];
    let todayCost = 0;
    let todayRequests = 0;
    let weekCost = 0;
    for (const row of rows) {
      const cost = costTotal(toCostBreakdown(parseJson(row.cost_json)));
      const timestamp = num(row.timestamp);
      weekCost += cost;
      if (timestamp >= todayStart) {
        todayCost += cost;
        todayRequests += 1;
      }
    }
    return { todayCost, todayRequests, weekCost };
  }

  private rowToEntry(row: SqlRow): UsageEntry {
    const entry: UsageEntry = {
      id: str(row.id),
      sessionId: str(row.session_id),
      timestamp: num(row.timestamp),
      model: str(row.model),
      tokens: toTokenCounts(parseJson(row.tokens_json)),
      isFast: bool(row.is_fast),
      cost: toCostBreakdown(parseJson(row.cost_json)),
      isPriced: bool(row.is_priced),
    };
    if (row.agent_id !== null && row.agent_id !== undefined) entry.agentId = str(row.agent_id);
    if (row.device_id !== null && row.device_id !== undefined) entry.deviceId = str(row.device_id);
    return entry;
  }

  // MARK: - Observations

  /** Dedupe key: (account, kind, observed_at, resets_at, device). */
  insertObservations(accountId: string, deviceId: string, observations: QuotaObservation[]): { accepted: number; deduped: number } {
    return this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO observations
           (account_id, device_id, kind, observed_at, resets_at, used_percentage, source, session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let accepted = 0;
      for (const observation of observations) {
        const result = insert.run(
          accountId,
          deviceId,
          observation.kind,
          Math.round(observation.observedAt),
          Math.round(observation.resetsAt),
          observation.usedPercentage,
          observation.source,
          observation.sessionId ?? null
        );
        accepted += Number(result.changes);
      }
      return { accepted, deduped: observations.length - accepted };
    });
  }

  /**
   * Observations inside the quota lookback window, oldest first. Newest `limit`
   * rows are kept so a long-lived account cannot make /state unbounded.
   */
  observationsForQuota(accountId: string, minObservedAt: number, limit: number): QuotaObservation[] {
    const rows = this.db
      .prepare(
        "SELECT seq, device_id, kind, observed_at, resets_at, used_percentage, source, session_id FROM observations WHERE account_id = ? AND observed_at >= ? ORDER BY observed_at DESC, seq DESC LIMIT ?"
      )
      .all(accountId, minObservedAt, limit) as SqlRow[];
    const observations = rows.map((row) => this.rowToObservation(row));
    observations.reverse();
    return observations;
  }

  /** Other devices' recent observations, for the client-side merge (bounded). */
  remoteObservations(accountId: string, deviceId: string, minObservedAt: number, limit: number): QuotaObservation[] {
    const rows = this.db
      .prepare(
        "SELECT seq, device_id, kind, observed_at, resets_at, used_percentage, source, session_id FROM observations WHERE account_id = ? AND device_id <> ? AND observed_at >= ? ORDER BY observed_at ASC, seq ASC LIMIT ?"
      )
      .all(accountId, deviceId, minObservedAt, limit) as SqlRow[];
    return rows.map((row) => this.rowToObservation(row));
  }

  observationCount(accountId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM observations WHERE account_id = ?").get(accountId) as SqlRow | undefined;
    return row ? num(row.count) : 0;
  }

  /** Drops expired rate-limit readings; the app reports one every few seconds. */
  pruneObservations(accountId: string, oldestKept: number): number {
    const result = this.db.prepare("DELETE FROM observations WHERE account_id = ? AND observed_at < ?").run(accountId, oldestKept);
    return Number(result.changes);
  }

  private rowToObservation(row: SqlRow): QuotaObservation {
    const kindRaw = str(row.kind);
    const sourceRaw = str(row.source);
    const observation: QuotaObservation = {
      kind: isQuotaKind(kindRaw) ? kindRaw : "fiveHour",
      observedAt: num(row.observed_at),
      resetsAt: num(row.resets_at),
      usedPercentage: num(row.used_percentage),
      source: isObservationSource(sourceRaw) ? sourceRaw : "statusLine",
    };
    if (row.session_id !== null && row.session_id !== undefined) observation.sessionId = str(row.session_id);
    if (row.device_id !== null && row.device_id !== undefined) observation.deviceId = str(row.device_id);
    return observation;
  }

  // MARK: - Sessions

  /** Upsert peer-visible session metadata; the newest report wins. */
  upsertSessions(accountId: string, deviceId: string, sessions: SyncSessionMeta[]): number {
    if (sessions.length === 0) return 0;
    return this.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO sessions (account_id, device_id, id, title, project_name, cwd, start, end, auth_mode, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, id) DO UPDATE SET
             device_id = excluded.device_id,
             title = excluded.title,
             project_name = excluded.project_name,
             cwd = excluded.cwd,
             start = excluded.start,
             end = excluded.end,
             updated_at = excluded.updated_at`
      );
      const now = Date.now();
      let accepted = 0;
      for (const session of sessions) {
        const result = upsert.run(
          accountId,
          deviceId,
          session.id,
          session.title,
          session.projectName,
          session.cwd ?? null,
          Math.round(session.start),
          Math.round(session.end),
          session.authMode ?? null,
          now
        );
        accepted += Number(result.changes);
      }
      return accepted;
    });
  }

  /**
   * Sessions owned by other devices, with totals aggregated from their entries.
   * Sessions whose metadata has not arrived yet (older clients) are included from
   * their entries with a placeholder title, so peer usage is never invisible.
   */
  peerSessions(accountId: string, deviceId: string, limit = 2000): SyncSessionMeta[] {
    const meta = new Map<string, SyncSessionMeta>();
    const rows = this.db
      .prepare(
        "SELECT id, device_id, title, project_name, cwd, start, end, auth_mode FROM sessions WHERE account_id = ? AND device_id <> ? ORDER BY end DESC LIMIT ?"
      )
      .all(accountId, deviceId, limit) as SqlRow[];
    for (const row of rows) {
      meta.set(str(row.id), {
        id: str(row.id),
        title: str(row.title),
        projectName: str(row.project_name),
        cwd: str(row.cwd) || undefined,
        start: num(row.start),
        end: num(row.end),
        deviceId: str(row.device_id),
        ...(str(row.auth_mode) ? { authMode: str(row.auth_mode) as SyncSessionMeta["authMode"] } : {}),
      });
    }
    const aggregates = this.db
      .prepare(
        `SELECT session_id,
                device_id,
                COUNT(*) AS requests,
                MIN(timestamp) AS start,
                MAX(timestamp) AS end,
                SUM(json_extract(tokens_json, '$.input')) AS input_tokens,
                SUM(json_extract(tokens_json, '$.output')) AS output_tokens,
                SUM(json_extract(tokens_json, '$.cacheRead')) AS cache_read,
                SUM(json_extract(tokens_json, '$.cacheWrite5m')) AS cache_write_5m,
                SUM(json_extract(tokens_json, '$.cacheWrite1h')) AS cache_write_1h,
                SUM(json_extract(tokens_json, '$.webSearches')) AS web_searches,
                SUM(json_extract(cost_json, '$.input')) AS cost_input,
                SUM(json_extract(cost_json, '$.output')) AS cost_output,
                SUM(json_extract(cost_json, '$.cacheRead')) AS cost_cache_read,
                SUM(json_extract(cost_json, '$.cacheWrite')) AS cost_cache_write,
                SUM(json_extract(cost_json, '$.webSearch')) AS cost_web_search,
                SUM(CASE WHEN is_priced = 0 THEN 1 ELSE 0 END) AS unpriced,
                COUNT(DISTINCT agent_id) AS subagents,
                SUM(CASE WHEN model LIKE 'claude-%' THEN 1 ELSE 0 END) AS claude_requests,
                SUM(CASE WHEN id LIKE 'msg_%:req_%' THEN 1 ELSE 0 END) AS anthropic_ids,
                GROUP_CONCAT(DISTINCT model) AS models
           FROM entries
          WHERE account_id = ? AND device_id <> ?
          GROUP BY session_id, device_id`
      )
      .all(accountId, deviceId) as SqlRow[];
    for (const row of aggregates) {
      const id = str(row.session_id);
      const tokens: TokenCounts = {
        input: num(row.input_tokens),
        output: num(row.output_tokens),
        cacheRead: num(row.cache_read),
        cacheWrite5m: num(row.cache_write_5m),
        cacheWrite1h: num(row.cache_write_1h),
        webSearches: num(row.web_searches),
      };
      const cost: CostBreakdown = {
        input: num(row.cost_input),
        output: num(row.cost_output),
        cacheRead: num(row.cost_cache_read),
        cacheWrite: num(row.cost_cache_write),
        webSearch: num(row.cost_web_search),
      };
      const models = str(row.models).split(",").filter((model) => model.length > 0);
      const fallbackAuth = classifyAuthSignals({
        requests: num(row.requests),
        cacheWrite1h: num(row.cache_write_1h),
        cacheWrite5m: num(row.cache_write_5m),
        claudeRequests: num(row.claude_requests),
        anthropicIdRequests: num(row.anthropic_ids),
      });
      const existing = meta.get(id);
      if (existing) {
        existing.requests = num(row.requests);
        existing.start = Math.min(existing.start, num(row.start));
        existing.end = Math.max(existing.end, num(row.end));
        existing.tokens = tokens;
        existing.cost = cost;
        existing.models = models;
        existing.subagentCount = num(row.subagents);
        existing.hasUnpricedRequests = num(row.unpriced) > 0;
        existing.authMode = existing.authMode ?? fallbackAuth;
        existing.deviceId = existing.deviceId ?? str(row.device_id);
      } else {
        meta.set(id, {
          id,
          title: "会话 " + id.slice(0, 8),
          projectName: "其他设备",
          start: num(row.start),
          end: num(row.end),
          deviceId: str(row.device_id),
          requests: num(row.requests),
          tokens,
          cost,
          models,
          subagentCount: num(row.subagents),
          hasUnpricedRequests: num(row.unpriced) > 0,
          authMode: fallbackAuth,
        });
      }
    }
    return [...meta.values()].sort((a, b) => b.end - a.end).slice(0, limit);
  }

  // MARK: - Session auth

  /** Explicit auth verdicts reported by clients (mod fingerprint / heuristic). */
  sessionAuthModes(accountId: string): Map<string, "subscription" | "thirdParty" | "mixed" | "unknown"> {
    const rows = this.db
      .prepare("SELECT id, auth_mode FROM sessions WHERE account_id = ? AND auth_mode IS NOT NULL")
      .all(accountId) as SqlRow[];
    const modes = new Map<string, "subscription" | "thirdParty" | "mixed" | "unknown">();
    for (const row of rows) {
      const mode = str(row.auth_mode);
      if (mode === "subscription" || mode === "thirdParty" || mode === "mixed" || mode === "unknown") modes.set(str(row.id), mode);
    }
    return modes;
  }

  // MARK: - Plan

  plan(accountId: string): PlanInfo | undefined {
    const row = this.db.prepare("SELECT tier, organization_type, fetched_at FROM plan WHERE account_id = ?").get(accountId) as SqlRow | undefined;
    if (!row) return undefined;
    const plan: PlanInfo = { tier: str(row.tier), fetchedAt: num(row.fetched_at) };
    if (row.organization_type !== null && row.organization_type !== undefined) plan.organizationType = str(row.organization_type);
    return plan;
  }

  planHistory(accountId: string): PlanInfo[] {
    const rows = this.db
      .prepare("SELECT tier, organization_type, fetched_at FROM plan_history WHERE account_id = ? ORDER BY seq ASC")
      .all(accountId) as SqlRow[];
    return rows.map((row) => {
      const plan: PlanInfo = { tier: str(row.tier), fetchedAt: num(row.fetched_at) };
      if (row.organization_type !== null && row.organization_type !== undefined) plan.organizationType = str(row.organization_type);
      return plan;
    });
  }

  /**
   * Stores the latest reported plan and appends to the tier history only when
   * the tier actually changed (PlanHistory.record in the Swift app does the same).
   */
  recordPlan(accountId: string, plan: PlanInfo): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO plan (account_id, tier, organization_type, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (account_id) DO UPDATE SET
             tier = excluded.tier,
             organization_type = excluded.organization_type,
             fetched_at = MAX(plan.fetched_at, excluded.fetched_at)`
        )
        .run(accountId, plan.tier, plan.organizationType ?? null, Math.round(plan.fetchedAt));
      const last = this.db
        .prepare("SELECT tier FROM plan_history WHERE account_id = ? ORDER BY seq DESC LIMIT 1")
        .get(accountId) as SqlRow | undefined;
      if (!last || str(last.tier) !== plan.tier) {
        this.db
          .prepare("INSERT INTO plan_history (account_id, tier, organization_type, fetched_at) VALUES (?, ?, ?, ?)")
          .run(accountId, plan.tier, plan.organizationType ?? null, Math.round(plan.fetchedAt));
      }
    });
  }
}