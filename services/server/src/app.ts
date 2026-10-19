// Express 5 routes for the CCUsage multi-device sync server.
//
// Route list (see docs/CONTRACTS.md §Sync server REST API), mounted under
// /api/v1 and also at the root so both base-URL conventions work:
//
//   GET    /health          -> { ok: true }
//   POST   /accounts        -> 201 { account } | 409 | 400
//   POST   /login           -> 200 LoginResponse | 401 | 400
//   POST   /logout          (auth) { deviceId } -> 204
//   POST   /ingest          (auth) SyncIngestRequest -> SyncIngestResponse
//   GET    /sync            (auth) ?since=&mode= -> SyncPullResponse
//   GET    /state           (auth) -> { account, devices, quota, totals }
//   DELETE /devices/:id     (auth) -> 204
//
// Everything is synchronous: node:sqlite is synchronous and Node serves one
// request at a time, so handlers cannot observe partially written state.

import express from "express";
import type { NextFunction, Request, Response } from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AccountInfo,
  DeviceInfo,
  PlanInfo,
  QuotaObservation,
  TokenCounts,
  CostBreakdown,
  SyncSessionMeta,
  UsageEntry,
  WindowMode,
} from "@ccusage/core";
import { generateId, generateToken, hashPassword, hashToken, parseBearerToken, verifyPassword } from "./auth.js";
import { computeQuota, loadQuotaData, loadTotals } from "./aggregate.js";
import { SyncStore } from "./store.js";

/** Request bodies are capped by express.json; keep the limit in one place. */
export const BODY_LIMIT = "2mb";
/** Rate-limit readings are frequent; drop ones this old on every ingest. */
export const OBSERVATION_RETENTION_MS = 30 * 86_400_000;
/** Observations returned to peers cover the 7-day window. */
export const REMOTE_OBSERVATION_LOOKBACK_MS = 7 * 86_400_000;
export const REMOTE_OBSERVATION_LIMIT = 5000;
/** Guardrails against an oversized (but under 2 MB) batch. */
const MAX_ENTRIES_PER_INGEST = 20_000;
const MAX_OBSERVATIONS_PER_INGEST = 50_000;
const MAX_SESSIONS_PER_INGEST = 2_000;
const MAX_TITLE_LENGTH = 300;
const MAX_PROJECT_LENGTH = 200;
const MAX_CWD_LENGTH = 1_000;

export interface CreateServerOptions {
  /** Path to the SQLite file, or ":memory:" for an ephemeral database. */
  dbPath: string;
}

export interface CreateServerResult {
  app: express.Express;
  /** Closes the SQLite connection; call after the HTTP server stops. */
  close(): void;
}

export interface RequestAuth {
  accountId: string;
  deviceId: string;
  account: AccountInfo;
  tokenHash: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: RequestAuth;
    }
  }
}

// MARK: - Validation helpers

const WINDOW_MODES: readonly WindowMode[] = ["firstRequest", "fixedRolling"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function count(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed === undefined ? 0 : Math.max(0, parsed);
}

function normalizeTokenCounts(raw: unknown): TokenCounts | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    input: count(raw.input),
    output: count(raw.output),
    cacheRead: count(raw.cacheRead),
    cacheWrite5m: count(raw.cacheWrite5m),
    cacheWrite1h: count(raw.cacheWrite1h),
    webSearches: count(raw.webSearches),
  };
}

function normalizeCost(raw: unknown): CostBreakdown | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    input: count(raw.input),
    output: count(raw.output),
    cacheRead: count(raw.cacheRead),
    cacheWrite: count(raw.cacheWrite),
    webSearch: count(raw.webSearch),
  };
}

function normalizeUsername(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const username = raw.trim();
  if (username.length === 0 || username.length > 100) return undefined;
  return username;
}

function normalizePassword(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.length === 0 || raw.length > 1024) return undefined;
  return raw;
}

interface ParsedDevice {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
}

/** Fills in defaults for missing device fields; undefined when device is not an object. */
function normalizeDevice(raw: unknown, fallbackId?: string): ParsedDevice | undefined {
  if (raw === undefined || raw === null) {
    return { id: fallbackId ?? generateId(), name: "Unknown device", platform: "unknown", appVersion: "" };
  }
  if (!isRecord(raw)) return undefined;
  const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim().slice(0, 200) : fallbackId ?? generateId();
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim().slice(0, 100) : "Unknown device";
  const platform = typeof raw.platform === "string" && raw.platform.trim() !== "" ? raw.platform.trim().slice(0, 50) : "unknown";
  const appVersion = typeof raw.appVersion === "string" ? raw.appVersion.trim().slice(0, 50) : "";
  return { id, name, platform, appVersion };
}

function normalizeEntry(raw: unknown, index: number): { entry: UsageEntry } | { error: string } {
  if (!isRecord(raw)) return { error: `entries[${index}] must be an object` };
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 512) {
    return { error: `entries[${index}].id must be a non-empty string` };
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId.length > 512) {
    return { error: `entries[${index}].sessionId must be a string` };
  }
  const timestamp = finiteNumber(raw.timestamp);
  if (timestamp === undefined || timestamp < 0) return { error: `entries[${index}].timestamp must be a number` };
  if (typeof raw.model !== "string" || raw.model.length === 0 || raw.model.length > 200) {
    return { error: `entries[${index}].model must be a non-empty string` };
  }
  const tokens = normalizeTokenCounts(raw.tokens);
  if (!tokens) return { error: `entries[${index}].tokens must be an object` };
  const cost = normalizeCost(raw.cost);
  if (!cost) return { error: `entries[${index}].cost must be an object` };
  const entry: UsageEntry = {
    id: raw.id,
    sessionId: raw.sessionId,
    timestamp: Math.round(timestamp),
    model: raw.model,
    tokens,
    isFast: raw.isFast === true,
    cost,
    isPriced: raw.isPriced === undefined ? true : raw.isPriced === true,
  };
  if (typeof raw.agentId === "string" && raw.agentId.length > 0) entry.agentId = raw.agentId.slice(0, 512);
  return { entry };
}

function normalizeEntries(raw: unknown): { entries: UsageEntry[] } | { error: string } {
  if (raw === undefined || raw === null) return { entries: [] };
  if (!Array.isArray(raw)) return { error: "entries must be an array" };
  if (raw.length > MAX_ENTRIES_PER_INGEST) return { error: "too many entries" };
  const entries: UsageEntry[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = normalizeEntry(raw[index], index);
    if ("error" in parsed) return parsed;
    entries.push(parsed.entry);
  }
  return { entries };
}

function normalizeObservation(raw: unknown, index: number): { observation: QuotaObservation } | { error: string } {
  if (!isRecord(raw)) return { error: `observations[${index}] must be an object` };
  if (raw.kind !== "fiveHour" && raw.kind !== "sevenDay") {
    return { error: `observations[${index}].kind must be fiveHour or sevenDay` };
  }
  const observedAt = finiteNumber(raw.observedAt);
  if (observedAt === undefined || observedAt < 0) return { error: `observations[${index}].observedAt must be a number` };
  const resetsAt = finiteNumber(raw.resetsAt);
  if (resetsAt === undefined || resetsAt < 0) return { error: `observations[${index}].resetsAt must be a number` };
  const usedPercentage = finiteNumber(raw.usedPercentage);
  if (usedPercentage === undefined || usedPercentage < 0) {
    return { error: `observations[${index}].usedPercentage must be a non-negative number` };
  }
  let source: QuotaObservation["source"] = "statusLine";
  if (raw.source !== undefined) {
    if (raw.source !== "statusLine" && raw.source !== "limitMessage") {
      return { error: `observations[${index}].source must be statusLine or limitMessage` };
    }
    source = raw.source;
  }
  const observation: QuotaObservation = {
    kind: raw.kind,
    observedAt: Math.round(observedAt),
    resetsAt: Math.round(resetsAt),
    usedPercentage,
    source,
  };
  if (typeof raw.sessionId === "string" && raw.sessionId.length > 0) observation.sessionId = raw.sessionId.slice(0, 512);
  return { observation };
}

function normalizeObservations(raw: unknown): { observations: QuotaObservation[] } | { error: string } {
  if (raw === undefined || raw === null) return { observations: [] };
  if (!Array.isArray(raw)) return { error: "observations must be an array" };
  if (raw.length > MAX_OBSERVATIONS_PER_INGEST) return { error: "too many observations" };
  const observations: QuotaObservation[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = normalizeObservation(raw[index], index);
    if ("error" in parsed) return parsed;
    observations.push(parsed.observation);
  }
  return { observations };
}

function normalizeSessionMeta(raw: unknown, index: number): { session: SyncSessionMeta } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "sessions[" + index + "] must be an object" };
  }
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (id.length === 0 || id.length > 200) {
    return { error: "sessions[" + index + "].id must be a non-empty string" };
  }
  const start = typeof value.start === "number" && Number.isFinite(value.start) ? value.start : undefined;
  const end = typeof value.end === "number" && Number.isFinite(value.end) ? value.end : undefined;
  if (start === undefined || end === undefined) {
    return { error: "sessions[" + index + "].start/end must be timestamps" };
  }
  const rawTitle = typeof value.title === "string" ? value.title.trim() : "";
  const rawProject = typeof value.projectName === "string" ? value.projectName.trim() : "";
  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd.slice(0, MAX_CWD_LENGTH) : undefined;
  return {
    session: {
      id,
      title: (rawTitle.length > 0 ? rawTitle : "会话 " + id.slice(0, 8)).slice(0, MAX_TITLE_LENGTH),
      projectName: (rawProject.length > 0 ? rawProject : "其他设备").slice(0, MAX_PROJECT_LENGTH),
      ...(cwd !== undefined ? { cwd } : {}),
      start: Math.round(start),
      end: Math.round(end),
    },
  };
}

function normalizeSessions(raw: unknown): { sessions: SyncSessionMeta[] } | { error: string } {
  if (raw === undefined || raw === null) return { sessions: [] };
  if (!Array.isArray(raw)) return { error: "sessions must be an array" };
  if (raw.length > MAX_SESSIONS_PER_INGEST) return { error: "too many sessions (max " + MAX_SESSIONS_PER_INGEST + ")" };
  const sessions: SyncSessionMeta[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = normalizeSessionMeta(raw[index], index);
    if ("error" in parsed) return parsed;
    sessions.push(parsed.session);
  }
  return { sessions };
}

function normalizePlan(raw: unknown, now: number): PlanInfo | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.tier !== "string" || raw.tier.trim() === "" || raw.tier.length > 200) return undefined;
  const plan: PlanInfo = { tier: raw.tier.trim(), fetchedAt: Math.round(finiteNumber(raw.fetchedAt) ?? now) };
  if (typeof raw.organizationType === "string" && raw.organizationType.length > 0) {
    plan.organizationType = raw.organizationType.slice(0, 200);
  }
  return plan;
}

function parseSince(value: unknown): number | undefined {
  if (value === undefined) return 0;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function parseMode(value: unknown): WindowMode | undefined {
  if (value === undefined) return "firstRequest";
  if (typeof value !== "string") return undefined;
  return (WINDOW_MODES as readonly string[]).includes(value) ? (value as WindowMode) : undefined;
}

function withSelf(devices: DeviceInfo[], selfId: string): DeviceInfo[] {
  return devices.map((device) => (device.id === selfId ? { ...device, isSelf: true } : device));
}

// MARK: - Middleware

/** Rejects arrays/scalars so every handler can assume a JSON object body. */
function requireObjectBody(req: Request, res: Response, next: NextFunction): void {
  if (req.body === undefined || req.body === null) {
    req.body = {};
    next();
    return;
  }
  if (!isRecord(req.body)) {
    res.status(400).json({ error: "request body must be a JSON object" });
    return;
  }
  next();
}

function createAuthMiddleware(store: SyncStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tokenHash = hashToken(token);
    const auth = store.findAuth(tokenHash);
    if (!auth) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.auth = { ...auth, tokenHash };
    next();
  };
}

/** Hash used to keep unknown-username logins as slow as wrong-password ones. */
let dummyPassword: { passwordHash: string; salt: string } | undefined;
function dummyPasswordRecord(): { passwordHash: string; salt: string } {
  dummyPassword ??= hashPassword("ccusage-sync-dummy-password");
  return dummyPassword;
}

// MARK: - Server factory

export function createServer(options: CreateServerOptions): CreateServerResult {
  const dbPath = options.dbPath;
  if (dbPath !== ":memory:" && dbPath !== "file::memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const store = new SyncStore(dbPath);
  const app = express();
  const router = express.Router();
  const requireAuth = createAuthMiddleware(store);

  app.disable("x-powered-by");
  app.use(express.json({ limit: BODY_LIMIT }));

  // MARK: health
  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // MARK: accounts
  router.post("/accounts", requireObjectBody, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const username = normalizeUsername(body.username);
    const password = normalizePassword(body.password);
    if (!username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }
    const { passwordHash, salt } = hashPassword(password);
    const account = store.createAccount({ id: generateId(), username, passwordHash, salt, createdAt: Date.now() });
    if (!account) {
      res.status(409).json({ error: "account already exists (409 conflict)" });
      return;
    }
    res.status(201).json({ account: { id: account.id, username: account.username } satisfies AccountInfo });
  });

  // MARK: login
  router.post("/login", requireObjectBody, (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      res.status(400).json({ error: "username and password are required" });
      return;
    }
    const username = body.username.trim();
    const account = store.accountByUsername(username);
    const valid = account
      ? verifyPassword(body.password, account.passwordHash, account.salt)
      : (verifyPassword(body.password, dummyPasswordRecord().passwordHash, dummyPasswordRecord().salt), false);
    if (!account || !valid) {
      res.status(401).json({ error: "invalid username or password" });
      return;
    }
    const requested = normalizeDevice(body.device);
    if (!requested) {
      res.status(400).json({ error: "device must be an object" });
      return;
    }
    const deviceId = requested.id && store.canUseDeviceId(account.id, requested.id) ? requested.id : generateId();
    const now = Date.now();
    store.upsertDevice(account.id, { ...requested, id: deviceId, lastSeenAt: now });
    const token = generateToken();
    store.createToken(hashToken(token), account.id, deviceId, now);
    res.json({ token, account: { id: account.id, username: account.username } satisfies AccountInfo, deviceId });
  });

  // MARK: logout
  router.post("/logout", requireAuth, requireObjectBody, (req, res) => {
    const auth = req.auth!;
    const body = req.body as Record<string, unknown>;
    if (typeof body.deviceId === "string" && body.deviceId === auth.deviceId) {
      store.revokeDeviceTokens(auth.accountId, auth.deviceId);
    } else {
      store.revokeToken(auth.tokenHash);
    }
    res.status(204).end();
  });

  // MARK: ingest
  router.post("/ingest", requireAuth, requireObjectBody, (req, res) => {
    const auth = req.auth!;
    const body = req.body as Record<string, unknown>;
    const entries = normalizeEntries(body.entries);
    if ("error" in entries) {
      res.status(400).json({ error: entries.error });
      return;
    }
    const observations = normalizeObservations(body.observations);
    if ("error" in observations) {
      res.status(400).json({ error: observations.error });
      return;
    }
    const sessions = normalizeSessions(body.sessions);
    if ("error" in sessions) {
      res.status(400).json({ error: sessions.error });
      return;
    }
    const now = Date.now();
    const requestedDevice = body.device === undefined ? undefined : normalizeDevice(body.device, auth.deviceId);
    if (body.device !== undefined && !requestedDevice) {
      res.status(400).json({ error: "device must be an object" });
      return;
    }
    let plan: PlanInfo | undefined;
    if (body.plan !== undefined && body.plan !== null) {
      plan = normalizePlan(body.plan, now);
      if (!plan) {
        res.status(400).json({ error: "plan.tier must be a non-empty string" });
        return;
      }
    }
    const result = store.transaction(() => {
      const inserted = store.insertEntries(auth.accountId, auth.deviceId, entries.entries);
      const recorded = store.insertObservations(auth.accountId, auth.deviceId, observations.observations);
      const sessionsAccepted = store.upsertSessions(auth.accountId, auth.deviceId, sessions.sessions);
      if (requestedDevice && requestedDevice.id === auth.deviceId) {
        store.upsertDevice(auth.accountId, { ...requestedDevice, lastSeenAt: now });
      } else {
        store.touchDevice(auth.accountId, auth.deviceId, now);
      }
      if (plan) store.recordPlan(auth.accountId, plan);
      store.pruneObservations(auth.accountId, now - OBSERVATION_RETENTION_MS);
      return { inserted, recorded, sessionsAccepted, cursor: store.maxEntrySeq(auth.accountId) };
    });
    const response: { serverTime: number; accepted: number; deduped: number; cursor: number; sessionsAccepted: number } = {
      serverTime: now,
      accepted: result.inserted.accepted,
      deduped: result.inserted.deduped,
      cursor: result.cursor,
      sessionsAccepted: result.sessionsAccepted,
    };
    res.json(response);
  });

  // MARK: sync (pull)
  router.get("/sync", requireAuth, (req, res) => {
    const auth = req.auth!;
    const since = parseSince(req.query.since);
    if (since === undefined) {
      res.status(400).json({ error: "since must be a non-negative integer" });
      return;
    }
    const mode = parseMode(req.query.mode);
    if (mode === undefined) {
      res.status(400).json({ error: "mode must be firstRequest or fixedRolling" });
      return;
    }
    const now = Date.now();
    const remote = store.remoteEntries(auth.accountId, auth.deviceId, since);
    const observations = store.remoteObservations(
      auth.accountId,
      auth.deviceId,
      now - REMOTE_OBSERVATION_LOOKBACK_MS,
      REMOTE_OBSERVATION_LIMIT
    );
    const quota = computeQuota(loadQuotaData(store, auth.accountId, now), mode, now);
    // Cursor covers exactly the peer entries handed out here; the client passes
    // it back as ?since= on the next pull. When nothing is new it stays put.
    const cursor = remote.length > 0 ? remote[remote.length - 1]!.seq : since;
    res.json({
      serverTime: now,
      cursor,
      entries: remote.map((item) => item.entry),
      observations,
      devices: withSelf(store.devices(auth.accountId), auth.deviceId),
      sessions: store.peerSessions(auth.accountId, auth.deviceId),
      plan: store.plan(auth.accountId),
      quota,
    });
  });

  // MARK: state
  router.get("/state", requireAuth, (req, res) => {
    const auth = req.auth!;
    const mode = parseMode(req.query.mode);
    if (mode === undefined) {
      res.status(400).json({ error: "mode must be firstRequest or fixedRolling" });
      return;
    }
    const now = Date.now();
    res.json({
      account: auth.account,
      devices: withSelf(store.devices(auth.accountId), auth.deviceId),
      quota: computeQuota(loadQuotaData(store, auth.accountId, now), mode, now),
      totals: loadTotals(store, auth.accountId, now),
    });
  });

  // MARK: devices
  router.delete("/devices/:id", requireAuth, (req, res) => {
    const auth = req.auth!;
    const deviceId = req.params.id;
    if (typeof deviceId === "string" && deviceId.length > 0) {
      store.deleteDevice(auth.accountId, deviceId);
    }
    res.status(204).end();
  });

  // Same router at /api/v1 (contract) and at the root (clients whose base URL
  // has no suffix). Route handlers are stateless so this is safe.
  app.use("/api/v1", router);
  app.use(router);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    const type = (error as { type?: unknown }).type;
    if (type === "entity.too.large" || status === 413) {
      // CONTRACTS §6: bodies over 2 MB are rejected with a 400 + { error }.
      res.status(400).json({ error: "request body too large" });
      return;
    }
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: type === "entity.parse.failed" ? "invalid JSON body" : "bad request" });
      return;
    }
    console.error("[ccusage-server]", error);
    res.status(500).json({ error: "internal server error" });
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    store.close();
  };
  return { app, close };
}