// Multi-device sync (ARCHITECTURE.md §3, CONTRACTS.md sync client).
//
// Owns the @ccusage/core SyncClient lifecycle: configure from settings.server, login/register/
// logout, and a periodic cycle that
//   1. ingests the local delta (entries + observations) since the last upload,
//   2. pulls other devices' entries / observations / devices / server-computed quota,
//   3. merges them into a UsageSnapshot for the UI and exposes SyncState + the server quota.
//
// When sync is online the server quota includes every device and is what the quota cards show;
// the locally computed snapshot remains the offline fallback (and still receives the remote
// observations so windows account for other devices).
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AccountInfo,
  AppSettings,
  CostBreakdown,
  DeviceInfo,
  PlanInfo,
  QuotaObservation,
  QuotaSnapshot,
  ServerConfig,
  SessionSummary,
  SyncSessionMeta,
  SyncState,
  SyncStatus,
  TokenCounts,
  UsageEntry,
  UsageSnapshot,
} from "@ccusage/core";
import { mergeEntries, mergeObservations, SyncClient } from "@ccusage/core";

/** UI refresh cadence of the sync cycle (lead: ingest local delta + pull every ~15-30 s). */
export const SYNC_INTERVAL_MS = 30_000;
const INGEST_BATCH_SIZE = 1000;
const ENTRY_OVERLAP_MS = 2 * 60_000;
const OBSERVATION_OVERLAP_MS = 5 * 60_000;
/** Only upload the last two weeks of observations (quota windows are 5h/7d; server keeps 30 days). */
const OBSERVATION_UPLOAD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const REQUEST_SYNC_DEBOUNCE_MS = 1_500;

interface PersistedSyncState {
  cursor?: number;
  ingestedThrough?: number;
  observedThrough?: number;
  account?: AccountInfo;
}

export interface SyncManagerOptions {
  appVersion: string;
  getSettings: () => AppSettings;
  /** Persists a partial server config (token/username/deviceId) and returns the new settings. */
  updateServer: (patch: Partial<ServerConfig>) => AppSettings;
  statePath: () => string;
  getLocalSnapshot: () => UsageSnapshot;
  getLocalObservations: () => QuotaObservation[];
  getPlan: () => PlanInfo | undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function deviceInfoFromSettings(settings: AppSettings, appVersion: string): DeviceInfo {
  return {
    id: settings.server.deviceId,
    name: settings.server.deviceName,
    platform: process.platform,
    appVersion,
    lastSeenAt: Date.now(),
  };
}

function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearches: 0 };
}

function addTokens(target: TokenCounts, tokens: TokenCounts): void {
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite5m += tokens.cacheWrite5m;
  target.cacheWrite1h += tokens.cacheWrite1h;
  target.webSearches += tokens.webSearches;
}

function emptyCost(): CostBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 };
}

function addCost(target: CostBreakdown, cost: CostBreakdown): void {
  target.input += cost.input;
  target.output += cost.output;
  target.cacheRead += cost.cacheRead;
  target.cacheWrite += cost.cacheWrite;
  target.webSearch += cost.webSearch;
}

/**
 * Session summary for entries that only exist on other devices (no local transcript metadata).
 * The title falls back to the reporting device's name when the caller provides the device map.
 */
export function synthesizeSession(sessionId: string, entries: UsageEntry[], deviceNames?: ReadonlyMap<string, string>): SessionSummary {
  let start = entries[0]?.timestamp ?? Date.now();
  let end = start;
  const tokens = emptyTokens();
  const cost = emptyCost();
  const models = new Set<string>();
  const agentIds = new Set<string>();
  const deviceIds = new Set<string>();
  let subagentCost = 0;
  let hasUnpricedRequests = false;
  for (const entry of entries) {
    start = Math.min(start, entry.timestamp);
    end = Math.max(end, entry.timestamp);
    addTokens(tokens, entry.tokens);
    addCost(cost, entry.cost);
    models.add(entry.model);
    if (entry.agentId) {
      agentIds.add(entry.agentId);
      subagentCost += entry.cost.input + entry.cost.output + entry.cost.cacheRead + entry.cost.cacheWrite + entry.cost.webSearch;
    }
    if (entry.deviceId) deviceIds.add(entry.deviceId);
    if (!entry.isPriced) hasUnpricedRequests = true;
  }
  const deviceName = deviceNames ? mostFrequentDeviceName(deviceIds, deviceNames) : undefined;
  const session: SessionSummary = {
    id: sessionId,
    title: deviceName ? deviceName + " 的用量" : "会话 " + sessionId.slice(0, 8),
    projectName: "其他设备",
    start,
    end,
    models: [...models],
    tokens,
    cost,
    subagentCost,
    requestCount: entries.length,
    subagentCount: agentIds.size,
    hasUnpricedRequests,
  };
  if (deviceIds.size > 0) session.deviceIds = [...deviceIds];
  return session;
}

/** Most common device id in a session, resolved to the device name when known. */
function mostFrequentDeviceName(deviceIds: Set<string>, deviceNames: ReadonlyMap<string, string>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  const counts = new Map<string, number>();
  for (const deviceId of deviceIds) {
    const count = (counts.get(deviceId) ?? 0) + 1;
    counts.set(deviceId, count);
    if (count > bestCount && deviceNames.has(deviceId)) {
      best = deviceNames.get(deviceId);
      bestCount = count;
    }
  }
  return best;
}

/** Build a session summary from synced peer metadata (server-computed totals when present). */
function sessionFromMeta(meta: SyncSessionMeta): SessionSummary {
  const tokens = meta.tokens ?? emptyTokens();
  const cost = meta.cost ?? emptyCost();
  const session: SessionSummary = {
    id: meta.id,
    title: meta.title,
    projectName: meta.projectName,
    ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
    start: meta.start,
    end: meta.end,
    models: meta.models ?? [],
    tokens,
    cost,
    subagentCost: 0,
    requestCount: meta.requests ?? 0,
    subagentCount: meta.subagentCount ?? 0,
    hasUnpricedRequests: meta.hasUnpricedRequests === true,
  };
  if (meta.deviceId !== undefined) session.deviceIds = [meta.deviceId];
  return session;
}

/**
 * Merge entries pulled from other devices into the local snapshot: dedupe by id (local wins,
 * deviceId kept) and build session summaries for sessions that only exist remotely — preferring
 * the synced session metadata (real title, server-computed totals), falling back to a synthesized
 * summary for peers running an older client.
 */
export function mergeRemoteSnapshot(
  local: UsageSnapshot,
  remoteEntries: UsageEntry[],
  deviceNames?: ReadonlyMap<string, string>,
  remoteSessions?: ReadonlyMap<string, SyncSessionMeta>,
): UsageSnapshot {
  if (remoteEntries.length === 0 && (remoteSessions === undefined || remoteSessions.size === 0)) return local;
  const merged = mergeEntries(local.entries, remoteEntries);
  const entries = [...merged].sort((a, b) => a.timestamp - b.timestamp);
  const entriesBySession: Record<string, UsageEntry[]> = {};
  for (const entry of entries) {
    (entriesBySession[entry.sessionId] ??= []).push(entry);
  }
  const sessions = [...local.sessions];
  const knownSessions = new Set(local.sessions.map((session) => session.id));
  for (const meta of remoteSessions?.values() ?? []) {
    if (knownSessions.has(meta.id)) continue;
    sessions.push(sessionFromMeta(meta));
    knownSessions.add(meta.id);
  }
  for (const [sessionId, sessionEntries] of Object.entries(entriesBySession)) {
    if (knownSessions.has(sessionId)) continue;
    sessions.push(synthesizeSession(sessionId, sessionEntries, deviceNames));
  }
  sessions.sort((a, b) => b.end - a.end);
  return { ...local, entries, entriesBySession, sessions, generatedAt: Date.now() };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class SyncManager extends EventEmitter {
  private readonly options: SyncManagerOptions;
  private client: SyncClient | undefined;
  private clientSignature: string | undefined;
  private status: SyncStatus = "disabled";
  private lastSyncAt: number | undefined;
  private lastError: string | undefined;
  private account: AccountInfo | undefined;
  private devices: DeviceInfo[] = [];
  private deviceNameMap: ReadonlyMap<string, string> | undefined;
  private serverQuota: QuotaSnapshot | undefined;
  private remoteEntries: UsageEntry[] = [];
  private remoteObservations: QuotaObservation[] = [];
  /** Session metadata pulled from other devices, keyed by session id. */
  private remoteSessions = new Map<string, SyncSessionMeta>();
  /** session id -> end timestamp last uploaded, so only changed sessions are re-sent. */
  private sentSessionEnd = new Map<string, number>();
  private cursor = 0;
  private ingestedThrough = 0;
  private observedThrough = 0;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private requestSyncTimer: NodeJS.Timeout | undefined;
  private cyclePromise: Promise<void> | undefined;
  private lastServerUrl: string | undefined;
  private lastEnabled: boolean | undefined;

  constructor(options: SyncManagerOptions) {
    super();
    this.options = options;
    this.loadPersisted();
    this.lastServerUrl = options.getSettings().server.url;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastEnabled = this.options.getSettings().server.enabled;
    this.refreshClient();
    this.updateStatusFromSettings();
    this.emit("state");
    if (this.canSync()) void this.runCycle();
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    this.clearTimers();
  }

  /** Re-read settings after settings.update / configure: rebuild the client and resync. */
  applySettings(): void {
    const server = this.options.getSettings().server;
    const urlChanged = this.lastServerUrl !== undefined && this.lastServerUrl !== server.url;
    const wasEnabled = this.lastEnabled === true;
    this.lastServerUrl = server.url;
    this.lastEnabled = server.enabled;
    this.refreshClient();
    if (urlChanged || (wasEnabled && !server.enabled)) {
      this.resetRemoteState();
    }
    this.updateStatusFromSettings();
    this.emit("state");
    this.emit("quota", this.serverQuota);
    if (this.canSync()) {
      this.scheduleNext();
      void this.runCycle();
    }
  }

  getState(): SyncState {
    const state: SyncState = {
      status: this.status,
      devices: this.devices.map((device) => ({ ...device })),
      pendingEntries: this.pendingEntryCount(),
    };
    if (this.lastSyncAt !== undefined) state.lastSyncAt = this.lastSyncAt;
    if (this.lastError) state.error = this.lastError;
    if (this.account) state.account = { ...this.account };
    if (this.serverQuota) state.serverQuota = this.serverQuota;
    return state;
  }

  getRemoteEntries(): UsageEntry[] {
    return this.remoteEntries;
  }

  getRemoteObservations(): QuotaObservation[] {
    return this.remoteObservations;
  }

  /** Device id -> display name (used to title sessions that only exist on other devices). */
  getDeviceNames(): ReadonlyMap<string, string> {
    if (!this.deviceNameMap) {
      const names = new Map<string, string>();
      for (const device of this.devices) names.set(device.id, device.name);
      this.deviceNameMap = names;
    }
    return this.deviceNameMap;
  }

  getServerQuota(): QuotaSnapshot | undefined {
    return this.serverQuota;
  }

  mergedSnapshot(local: UsageSnapshot): UsageSnapshot {
    return mergeRemoteSnapshot(local, this.remoteEntries, this.getDeviceNames(), this.remoteSessions);
  }

  /** Called by the mod bridge after a reading so the new observation reaches the server quickly. */
  requestSyncSoon(): void {
    if (!this.canSync()) return;
    if (this.requestSyncTimer) clearTimeout(this.requestSyncTimer);
    this.requestSyncTimer = setTimeout(() => {
      this.requestSyncTimer = undefined;
      void this.runCycle();
    }, REQUEST_SYNC_DEBOUNCE_MS);
    this.requestSyncTimer.unref?.();
  }

  async syncNow(): Promise<{ ok: boolean; error?: string }> {
    const server = this.options.getSettings().server;
    if (!server.enabled) return { ok: false, error: "同步未启用" };
    if (!server.token) return { ok: false, error: "尚未登录服务器" };
    await this.runCycle();
    if (this.status === "online") return { ok: true };
    return { ok: false, error: this.lastError ?? "同步失败" };
  }

  async login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    return this.authenticate("login", username, password);
  }

  async register(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    return this.authenticate("register", username, password);
  }

  async logout(): Promise<void> {
    const server = this.options.getSettings().server;
    if (server.token && server.url) {
      try {
        const client = new SyncClient({ url: server.url, token: server.token });
        await client.logout(server.deviceId);
      } catch (error) {
        // Revocation is best effort: the local token is cleared regardless.
        console.warn("[sync] failed to revoke token", error);
      }
    }
    this.options.updateServer({ token: undefined });
    this.account = undefined;
    this.devices = [];
    this.resetRemoteState();
    this.refreshClient();
    this.updateStatusFromSettings();
    this.lastError = undefined;
    this.emit("state");
    this.emit("quota", undefined);
  }

  /** Sets the server config (partial) then applies it. Used by IPC sync.configure. */
  configure(patch: Partial<ServerConfig>): AppSettings {
    const settings = this.options.updateServer(patch);
    this.applySettings();
    return settings;
  }

  private async authenticate(mode: "login" | "register", username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    const trimmedUser = username.trim();
    if (!trimmedUser) return { ok: false, error: "请输入用户名" };
    if (!password) return { ok: false, error: "请输入密码" };
    const server = this.options.getSettings().server;
    if (!server.url) return { ok: false, error: "请先填写服务器地址" };
    try {
      this.status = "connecting";
      this.lastError = undefined;
      this.emit("state");
      const client = new SyncClient({ url: server.url });
      const device = deviceInfoFromSettings(this.options.getSettings(), this.options.appVersion);
      const response = mode === "login" ? await client.login(trimmedUser, password, device) : await client.signup(trimmedUser, password, device);
      this.options.updateServer({
        token: response.token,
        username: trimmedUser,
        deviceId: response.deviceId || server.deviceId,
      });
      this.account = response.account;
      this.lastError = undefined;
      this.resetRemoteState();
      this.refreshClient();
      this.status = "connecting";
      this.emit("state");
      if (this.canSync()) {
        await this.runCycle();
      } else {
        this.updateStatusFromSettings();
        this.emit("state");
      }
      if (this.isOnline()) return { ok: true };
      return { ok: false, error: this.lastError ?? "登录成功，但同步失败" };
    } catch (error) {
      this.status = "error";
      this.lastError = errorMessage(error);
      this.emit("state");
      return { ok: false, error: this.lastError };
    }
  }

  private isOnline(): boolean {
    return (this.status as SyncStatus) === "online";
  }

  private canSync(): boolean {
    const server = this.options.getSettings().server;
    return this.started && server.enabled && Boolean(server.url) && Boolean(server.token);
  }

  private refreshClient(): void {
    const server = this.options.getSettings().server;
    const signature = server.url + "|" + (server.token ?? "") + "|" + server.deviceId;
    if (this.client && this.clientSignature === signature) return;
    this.clientSignature = signature;
    this.client = server.url ? new SyncClient({ url: server.url, token: server.token }) : undefined;
  }

  private updateStatusFromSettings(): void {
    const server = this.options.getSettings().server;
    if (!server.enabled) {
      this.status = "disabled";
      return;
    }
    if (!server.token || !server.url) {
      this.status = "offline";
      return;
    }
    if (this.status === "disabled") this.status = "offline";
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runCycle().finally(() => this.scheduleNext());
    }, SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  private clearTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.requestSyncTimer) {
      clearTimeout(this.requestSyncTimer);
      this.requestSyncTimer = undefined;
    }
  }

  private runCycle(): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;
    const cycle = this.doCycle()
      .catch((error) => {
        this.status = "error";
        this.lastError = errorMessage(error);
        this.emit("state");
        this.emit("quota", undefined);
      })
      .finally(() => {
        if (this.cyclePromise === cycle) this.cyclePromise = undefined;
      });
    this.cyclePromise = cycle;
    return cycle;
  }

  private async doCycle(): Promise<void> {
    if (!this.canSync()) {
      this.updateStatusFromSettings();
      this.emit("state");
      return;
    }
    const client = this.client;
    if (!client) return;
    this.status = "connecting";
    this.emit("state");
    await this.ingest(client);
    await this.pull(client);
    this.status = "online";
    this.lastSyncAt = Date.now();
    this.lastError = undefined;
    this.savePersisted();
    this.emit("state");
    this.emit("quota", this.serverQuota);
  }

  private async ingest(client: SyncClient): Promise<void> {
    const settings = this.options.getSettings();
    const device = deviceInfoFromSettings(settings, this.options.appVersion);
    const snapshot = this.options.getLocalSnapshot();
    const entryCutoff = Math.max(0, this.ingestedThrough - ENTRY_OVERLAP_MS);
    const entries = snapshot.entries.filter((entry) => entry.timestamp > entryCutoff);
    // Quota windows only need recent observations; capping keeps the first upload well below
    // the server's 2 MB body limit and chunks together with the entries below.
    const observationCutoff = Math.max(
      Date.now() - OBSERVATION_UPLOAD_WINDOW_MS,
      this.observedThrough - OBSERVATION_OVERLAP_MS,
    );
    const observations = this.options
      .getLocalObservations()
      .filter((observation) => observation.observedAt > observationCutoff)
      .map((observation) => ({ ...observation, deviceId: device.id }));
    const sessions = this.changedSessions(snapshot);
    if (entries.length === 0 && observations.length === 0 && sessions.length === 0) return;
    const plan = this.options.getPlan();
    const entryBatches = chunk(entries, INGEST_BATCH_SIZE);
    const observationBatches = chunk(observations, INGEST_BATCH_SIZE);
    const sessionBatches = chunk(sessions, 500);
    const requestCount = Math.max(entryBatches.length, observationBatches.length, sessionBatches.length);
    for (let index = 0; index < requestCount; index += 1) {
      const entryBatch = entryBatches[index] ?? [];
      const observationBatch = observationBatches[index] ?? [];
      const sessionBatch = sessionBatches[index] ?? [];
      await client.ingest({
        device,
        entries: entryBatch,
        observations: observationBatch,
        sessions: sessionBatch,
        plan: index === 0 ? plan : undefined,
        cursor: this.cursor,
      });
      for (const entry of entryBatch) this.ingestedThrough = Math.max(this.ingestedThrough, entry.timestamp);
      for (const observation of observationBatch) this.observedThrough = Math.max(this.observedThrough, observation.observedAt);
      for (const session of sessionBatch) this.sentSessionEnd.set(session.id, session.end);
      this.savePersisted();
      this.emit("state");
    }
  }

  /** Local sessions whose metadata is new or whose end moved since the last upload. */
  private changedSessions(snapshot: UsageSnapshot): SyncSessionMeta[] {
    const changed: SyncSessionMeta[] = [];
    for (const session of snapshot.sessions) {
      const sent = this.sentSessionEnd.get(session.id);
      if (sent !== undefined && sent === session.end) continue;
      changed.push({
        id: session.id,
        title: session.title,
        projectName: session.projectName,
        ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
        start: session.start,
        end: session.end,
      });
    }
    return changed;
  }

  private async pull(client: SyncClient): Promise<void> {
    const response = await client.pull(this.cursor);
    this.cursor = Math.max(this.cursor, response.cursor ?? 0);
    if (response.entries.length > 0) {
      this.remoteEntries = mergeEntries(this.remoteEntries, response.entries);
    }
    for (const session of response.sessions ?? []) this.remoteSessions.set(session.id, session);
    if (response.observations.length > 0) {
      this.remoteObservations = mergeObservations(this.remoteObservations, response.observations);
    }
    const selfId = this.options.getSettings().server.deviceId;
    if (response.devices.length > 0) {
      this.devices = response.devices.map((device) => ({ ...device, isSelf: device.id === selfId }));
      this.deviceNameMap = undefined;
    }
    if (response.quota) this.serverQuota = response.quota;
    if (!this.account) {
      // Hydrate the account name + device list after a restart (only needs to happen once).
      try {
        const state = await client.state();
        this.account = state.account;
        if (state.devices.length > 0) {
          this.devices = state.devices.map((device) => ({ ...device, isSelf: device.id === selfId }));
          this.deviceNameMap = undefined;
        }
        if (state.quota) this.serverQuota = state.quota;
      } catch (error) {
        console.warn("[sync] failed to load server state", error);
      }
    }
    this.savePersisted();
    this.emit("state");
    this.emit("quota", this.serverQuota);
  }

  private pendingEntryCount(): number {
    const cutoff = this.ingestedThrough;
    const snapshot = this.options.getLocalSnapshot();
    if (cutoff <= 0) return snapshot.entries.length;
    return snapshot.entries.filter((entry) => entry.timestamp > cutoff).length;
  }

  private resetRemoteState(): void {
    this.remoteEntries = [];
    this.remoteObservations = [];
    this.remoteSessions.clear();
    this.sentSessionEnd.clear();
    this.serverQuota = undefined;
    this.devices = [];
    this.cursor = 0;
    this.ingestedThrough = 0;
    this.observedThrough = 0;
    this.savePersisted();
    this.emit("quota", undefined);
  }

  private loadPersisted(): void {
    try {
      const path = this.options.statePath();
      if (!existsSync(path)) return;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedSyncState;
      if (typeof parsed.cursor === "number") this.cursor = parsed.cursor;
      if (typeof parsed.ingestedThrough === "number") this.ingestedThrough = parsed.ingestedThrough;
      if (typeof parsed.observedThrough === "number") this.observedThrough = parsed.observedThrough;
      if (parsed.account && typeof parsed.account.username === "string") this.account = parsed.account;
    } catch (error) {
      console.warn("[sync] failed to read sync state", error);
    }
  }

  private savePersisted(): void {
    try {
      const state: PersistedSyncState = {
        cursor: this.cursor,
        ingestedThrough: this.ingestedThrough,
        observedThrough: this.observedThrough,
      };
      if (this.account) state.account = this.account;
      const path = this.options.statePath();
      mkdirSync(dirname(path), { recursive: true });
      const temp = path + ".tmp-" + process.pid;
      writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
      renameSync(temp, path);
    } catch (error) {
      console.warn("[sync] failed to persist sync state", error);
    }
  }
}