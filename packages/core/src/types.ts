// Shared data model for CCUsage (ported from the original Swift CCUsageCore).
//
// Timestamps are epoch milliseconds everywhere in this file so every value is
// JSON/IPC/SQLite safe; UI code formats them for display.

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearches: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearch: number;
}

/** One deduplicated API request recorded in a Claude Code transcript. */
export interface UsageEntry {
  /** message.id:requestId — stable across duplicated per-content-block lines. */
  id: string;
  sessionId: string;
  timestamp: number;
  model: string;
  tokens: TokenCounts;
  isFast: boolean;
  /** Non-null when the request came from a subagent transcript. */
  agentId?: string;
  cost: CostBreakdown;
  /** False when the model has no entry in the pricing table (cost is then zero). */
  isPriced: boolean;
  /** Set on entries merged from another device; absent for local entries. */
  deviceId?: string;
}

export interface SessionMetadata {
  customTitle?: string;
  agentName?: string;
  summary?: string;
  firstPrompt?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  projectName: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  start: number;
  end: number;
  models: string[];
  tokens: TokenCounts;
  cost: CostBreakdown;
  subagentCost: number;
  requestCount: number;
  subagentCount: number;
  hasUnpricedRequests: boolean;
  /** lastCost Claude Code itself wrote to ~/.claude.json for this session, if any. */
  recordedCost?: number;
  /** Devices that contributed entries to this session (local device omitted). */
  deviceIds?: string[];
}

export interface LimitEvent {
  timestamp: number;
  text: string;
}

export interface ParsedTranscript {
  path: string;
  /** Directory directly under the projects root (the encoded project path). */
  projectDirectory: string;
  sessionId: string;
  agentId?: string;
  entries: UsageEntry[];
  metadata: SessionMetadata;
  limitEvents: LimitEvent[];
}

export interface UsageSnapshot {
  /** Deduplicated requests, sorted by timestamp. */
  entries: UsageEntry[];
  /** Sessions sorted by most recent activity first. */
  sessions: SessionSummary[];
  entriesBySession: Record<string, UsageEntry[]>;
  limitEvents: LimitEvent[];
  fileCount: number;
  generatedAt: number;
}

// MARK: - Quota / subscription windows

export type QuotaKind = "fiveHour" | "sevenDay";
export type ObservationSource = "statusLine" | "limitMessage";
export type WindowMode = "firstRequest" | "fixedRolling";

/** A usage percentage and reset time reported by Claude Code. */
export interface QuotaObservation {
  kind: QuotaKind;
  observedAt: number;
  resetsAt: number;
  usedPercentage: number;
  source: ObservationSource;
  /** The Claude Code session that reported it (status line only). */
  sessionId?: string;
  /** The device that reported it. */
  deviceId?: string;
}

/** Cost spent in a window by the time Claude Code reported a usage percentage. */
export interface LimitSample {
  observedAt: number;
  usedPercentage: number;
  cost: number;
}

export type PlanChangeKind = "recorded" | "inferredUpgrade" | "inferredDowngrade";

export interface PlanChange {
  date: number;
  kind: PlanChangeKind;
  /** Only for kind === "recorded". */
  from?: string;
  to?: string;
}

export interface QuotaWindow {
  kind: QuotaKind;
  start: number;
  /** The end time was reported by Claude Code rather than inferred. */
  isConfirmed: boolean;
  tokens: TokenCounts;
  cost: number;
  requestCount: number;
  sessionIds: string[];
  observations: QuotaObservation[];
  latestSample?: LimitSample;
  resetAt?: number;
  costBeforeReset: number;
  end: number;
}

export interface LimitEstimate {
  sample?: LimitSample;
  /** Estimated USD-equivalent cost of 100% of the window (spent / used percentage). */
  cost?: number;
  lowerBound: number;
  planChange?: PlanChange;
}

export interface QuotaStatus {
  kind: QuotaKind;
  window?: QuotaWindow;
  latestObservation?: QuotaObservation;
  estimate?: LimitEstimate;
  burnRatePerHour: number;
  /** Best current usage estimate in percent; may exceed 100. */
  percentage?: number;
  percentageIsReported: boolean;
  exhaustionDate?: number;
}

export interface QuotaSnapshot {
  windows: Partial<Record<QuotaKind, QuotaWindow[]>>;
  status: Partial<Record<QuotaKind, QuotaStatus>>;
  statusLineObservationCount: number;
  limitMessageCount: number;
  plan?: PlanInfo;
}

export interface PlanInfo {
  /** e.g. default_claude_max_20x */
  tier: string;
  organizationType?: string;
  fetchedAt: number;
}

// MARK: - Devices / accounts / sync

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  lastSeenAt: number;
  /** True for the device the UI is running on. */
  isSelf?: boolean;
}

export interface AccountInfo {
  id: string;
  username: string;
}

export type SyncStatus = "disabled" | "offline" | "connecting" | "online" | "error";

export interface SyncState {
  status: SyncStatus;
  lastSyncAt?: number;
  error?: string;
  account?: AccountInfo;
  devices: DeviceInfo[];
  pendingEntries: number;
  /** Quota computed by the server over all devices; the display source of truth when online. */
  serverQuota?: QuotaSnapshot;
}

export interface ServerConfig {
  enabled: boolean;
  url: string;
  username?: string;
  deviceId: string;
  deviceName: string;
  /** Bearer token from POST /login; persisted in settings.json. */
  token?: string;
}

/**
 * Session metadata a device reports so other devices can display its sessions with
 * real titles and totals. Aggregates (requests/tokens/cost) are filled by the server
 * when it hands a peer session to another device.
 */
export interface SyncSessionMeta {
  id: string;
  title: string;
  projectName: string;
  cwd?: string;
  start: number;
  end: number;
  deviceId?: string;
  requests?: number;
  tokens?: TokenCounts;
  cost?: CostBreakdown;
  models?: string[];
  subagentCount?: number;
  hasUnpricedRequests?: boolean;
}

export interface SyncIngestRequest {
  device: DeviceInfo;
  entries: UsageEntry[];
  observations: QuotaObservation[];
  plan?: PlanInfo;
  /** Metadata for the sessions whose entries are being uploaded (or changed since the last upload). */
  sessions?: SyncSessionMeta[];
  /** Entries the device has already uploaded (for server-side cursor). */
  cursor?: number;
}

export interface SyncIngestResponse {
  serverTime: number;
  accepted: number;
  deduped: number;
  cursor: number;
  sessionsAccepted?: number;
}

export interface SyncPullResponse {
  serverTime: number;
  cursor: number;
  entries: UsageEntry[];
  observations: QuotaObservation[];
  devices: DeviceInfo[];
  /** Sessions owned by other devices, with real titles and server-computed totals. */
  sessions: SyncSessionMeta[];
  plan?: PlanInfo;
  quota?: QuotaSnapshot;
}

export interface LoginResponse {
  token: string;
  account: AccountInfo;
  deviceId: string;
}

// MARK: - Claude Code mod bridge

export interface BridgeConfig {
  version: 1;
  socketPath: string;
  token: string;
  /** How often the mod should push a heartbeat reading. */
  pollMs: number;
  /** Bumped by the app's "refresh" button; the mod reports at once when it changes. */
  refreshId: number;
  appVersion: string;
}

export interface BridgeReading {
  sessionId: string;
  entrypoint?: string;
  rateLimits: Array<{
    kind: string;
    percentUsed: number;
    resetsAt?: number;
  }>;
  cost?: { usd: number };
  /** True when this push answers a refresh request or a changed reading. */
  changed?: boolean;
  at: number;
}

export interface BridgeReportResponse {
  ok: true;
  pollMs: number;
  reportNow: boolean;
  refreshId: number;
}

export interface BridgeStatus {
  listening: boolean;
  socketPath: string;
  pollMs: number;
  refreshId: number;
  lastReportAt?: number;
  lastSessionId?: string;
  sessions: string[];
}

export type ModState = "notInstalled" | "installed" | "outdated" | "legacyStatusLine";

// MARK: - Settings / app state (IPC payloads)

export interface AppSettings {
  projectsPath: string;
  refreshIntervalSeconds: number;
  windowMode: WindowMode;
  server: ServerConfig;
  theme: "system" | "light" | "dark";
}

export interface ScanStats {
  fileCount: number;
  scanDurationMs: number;
  scannedAt: number;
}

export interface AppState {
  snapshot: UsageSnapshot;
  quota: QuotaSnapshot;
  sync: SyncState;
  settings: AppSettings;
  modState: ModState;
  bridge: BridgeStatus;
  scan: ScanStats;
  lastError?: string;
}

/** IPC channel names, shared by main/preload/renderer. */
export const IPC = {
  stateGet: "app:state:get",
  stateUpdated: "app:state:updated",
  refresh: "app:refresh",
  openMainWindow: "app:window:main",
  openSettings: "app:window:settings",
  quit: "app:quit",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  modStateGet: "mod:state",
  modInstall: "mod:install",
  modUninstall: "mod:uninstall",
  bridgeStatus: "bridge:status",
  bridgeRefresh: "bridge:refresh",
  syncNow: "sync:now",
  syncLogin: "sync:login",
  syncLogout: "sync:logout",
  syncConfigure: "sync:configure",
  serverAccounts: "server:accounts",
  demoSeed: "app:demo:seed"
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];