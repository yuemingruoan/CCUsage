// Derived view data for the renderer. Ports the view-model logic that lived in
// UsageStore.swift / the Swift views into plain functions over the AppState.
import { Pricing, SeriesPalette, modelTotals } from "@ccusage/core/pure";
import type {
  AppState,
  CostBreakdown,
  DeviceInfo,
  QuotaSnapshot,
  QuotaWindow,
  SessionSummary,
  TimeGranularity,
  TokenCounts,
  UsageBucket,
  UsageEntry,
} from "@ccusage/core/pure";
import { MAIN_SERIES, SUBAGENT_SERIES, formatTokens, usd } from "./format";

// MARK: - Date ranges (UsageStore.swift DateRange)

export type RangeKey = "today" | "week" | "month" | "all";

export interface RangeOption {
  key: RangeKey;
  label: string;
}

export const RANGES: readonly RangeOption[] = [
  { key: "today", label: "今天" },
  { key: "week", label: "近 7 天" },
  { key: "month", label: "近 30 天" },
  { key: "all", label: "全部" },
];

export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function rangeStart(key: RangeKey, now: number): number | null {
  const today = startOfDay(now);
  switch (key) {
    case "today":
      return today;
    case "week": {
      const date = new Date(today);
      date.setDate(date.getDate() - 6);
      return date.getTime();
    }
    case "month": {
      const date = new Date(today);
      date.setDate(date.getDate() - 29);
      return date.getTime();
    }
    case "all":
      return null;
  }
}

/** Entries with timestamp >= start; the snapshot list is sorted (Swift entries(since:)). */
export function entriesSince(entries: UsageEntry[], start: number | null): UsageEntry[] {
  if (start == null) return entries;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const entry = entries[mid];
    if (entry === undefined || entry.timestamp < start) low = mid + 1;
    else high = mid;
  }
  return entries.slice(low);
}

// MARK: - Token / cost totals (Models.swift)

export function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearches: 0 };
}

export function addTokens(into: TokenCounts, other: TokenCounts): void {
  into.input += other.input;
  into.output += other.output;
  into.cacheRead += other.cacheRead;
  into.cacheWrite5m += other.cacheWrite5m;
  into.cacheWrite1h += other.cacheWrite1h;
  into.webSearches += other.webSearches;
}

export function tokenTotal(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
}

export function cacheWriteTotal(tokens: TokenCounts): number {
  return tokens.cacheWrite5m + tokens.cacheWrite1h;
}

export function costTotal(cost: CostBreakdown): number {
  return cost.input + cost.output + cost.cacheRead + cost.cacheWrite + cost.webSearch;
}

export interface EntryTotals {
  tokens: TokenCounts;
  cost: number;
  sessions: number;
}

export function sumEntries(entries: readonly UsageEntry[]): EntryTotals {
  const tokens = emptyTokens();
  let cost = 0;
  const sessions = new Set<string>();
  for (const entry of entries) {
    addTokens(tokens, entry.tokens);
    cost += costTotal(entry.cost);
    sessions.add(entry.sessionId);
  }
  return { tokens, cost, sessions: sessions.size };
}

// MARK: - Series palettes (UsageStore.swift modelOrder / modelScale)

export { MAIN_SERIES, SUBAGENT_SERIES };
export const OTHER_SERIES = SeriesPalette.otherName;
export const MAX_SERIES = SeriesPalette.maxSeries;
export const OTHER_COLOR = "var(--series-other)";

export function seriesColor(index: number): string {
  return index < MAX_SERIES ? "var(--series-" + index + ")" : OTHER_COLOR;
}

export interface SeriesScale {
  domain: readonly string[];
  color(series: string): string;
}

/** Model display names ordered by all-time cost; drives stable series colors. */
export function buildModelOrder(entries: readonly UsageEntry[]): string[] {
  return modelTotals([...entries]).map((total) => total.name);
}

/** Series callback for per-model charts, folding models past the palette into 其他. */
export function makeModelSeries(order: readonly string[]): (entry: UsageEntry) => string {
  const slots = new Set<string>(order.slice(0, MAX_SERIES - 1));
  return (entry) => {
    const name = Pricing.displayName(entry.model);
    return slots.has(name) ? name : OTHER_SERIES;
  };
}

/** Scale for the model series present in a chart; each model keeps its all-time color slot. */
export function modelScale(order: readonly string[], present: ReadonlySet<string>): SeriesScale {
  const domain: string[] = [];
  const colors = new Map<string, string>();
  order.slice(0, MAX_SERIES - 1).forEach((name, index) => {
    if (present.has(name)) {
      domain.push(name);
      colors.set(name, seriesColor(index));
    }
  });
  if (present.has(OTHER_SERIES)) {
    domain.push(OTHER_SERIES);
    colors.set(OTHER_SERIES, OTHER_COLOR);
  }
  return { domain, color: (series) => colors.get(series) ?? OTHER_COLOR };
}

export const MAIN_SUBAGENT_SCALE: SeriesScale = {
  domain: [MAIN_SERIES, SUBAGENT_SERIES],
  color: (series) => (series === SUBAGENT_SERIES ? "var(--series-1)" : "var(--series-0)"),
};

// MARK: - Chart model (UsageChart.swift)

export type ChartMetric = "cost" | "tokens";

export interface ChartMetricOption {
  key: ChartMetric;
  label: string;
}

export const CHART_METRICS: readonly ChartMetricOption[] = [
  { key: "cost", label: "折算金额" },
  { key: "tokens", label: "Tokens" },
];

export function bucketMetricValue(bucket: UsageBucket, metric: ChartMetric): number {
  return metric === "cost" ? bucket.cost : tokenTotal(bucket.tokens);
}

export function formatMetricValue(metric: ChartMetric, value: number): string {
  return metric === "cost" ? usd(value) : formatTokens(Math.round(value));
}

export interface ChartColumn {
  start: number;
  end: number;
  parts: UsageBucket[];
  total: number;
  requestCount: number;
}

/** One column per bucket start, series-ordered like the Swift chart. */
export function chartColumns(
  buckets: readonly UsageBucket[],
  metric: ChartMetric,
  scale: SeriesScale,
): ChartColumn[] {
  const order = new Map<string, number>();
  scale.domain.forEach((series, index) => order.set(series, index));
  const grouped = new Map<number, UsageBucket[]>();
  for (const bucket of buckets) {
    const parts = grouped.get(bucket.start);
    if (parts) parts.push(bucket);
    else grouped.set(bucket.start, [bucket]);
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, parts]) => {
      const sorted = [...parts].sort(
        (a, b) => (order.get(a.series) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.series) ?? Number.MAX_SAFE_INTEGER),
      );
      let total = 0;
      let requestCount = 0;
      for (const part of sorted) {
        total += bucketMetricValue(part, metric);
        requestCount += part.requestCount;
      }
      const first = sorted[0];
      return { start, end: first?.end ?? start, parts: sorted, total, requestCount };
    });
}

/** A granularity that yields a readable number of points for the given span. */
export function suggestedGranularity(spanMs: number): TimeGranularity {
  if (spanMs < 2 * 86_400_000) return "fiveMinutes";
  if (spanMs < 10 * 86_400_000) return "fifteenMinutes";
  if (spanMs < 60 * 86_400_000) return "hour";
  return "day";
}

// MARK: - Quota helpers (Quota.swift computed properties)

export const EMPTY_QUOTA: QuotaSnapshot = {
  windows: {},
  status: {},
  statusLineObservationCount: 0,
  limitMessageCount: 0,
};

export interface QuotaSource {
  quota: QuotaSnapshot;
  /** null when the quota is local; otherwise the number of known devices. */
  serverDeviceCount: number | null;
}

/** Server-computed quota (includes every device) is the display source of truth when present. */
export function quotaSource(state: AppState | null): QuotaSource {
  if (!state) return { quota: EMPTY_QUOTA, serverDeviceCount: null };
  if (state.sync.serverQuota) {
    return { quota: state.sync.serverQuota, serverDeviceCount: Math.max(state.sync.devices.length, 1) };
  }
  return { quota: state.quota, serverDeviceCount: null };
}

export function windowCostSinceReset(window: QuotaWindow): number {
  return window.cost - window.costBeforeReset;
}

export function windowContains(window: QuotaWindow, time: number): boolean {
  return window.start <= time && time < window.end;
}

export function windowMaxObserved(window: QuotaWindow): number | undefined {
  let max: number | undefined;
  for (const observation of window.observations) {
    if (max == null || observation.usedPercentage > max) max = observation.usedPercentage;
  }
  return max;
}

export type QuotaLevel = "normal" | "warning" | "critical";

export function quotaLevel(percentage: number | undefined): QuotaLevel {
  const value = percentage ?? 0;
  if (value < 75) return "normal";
  if (value < 90) return "warning";
  return "critical";
}

// MARK: - Devices

export const LOCAL_DEVICE_KEY = "__self__";

export interface DeviceUsage {
  requests: number;
  cost: number;
  hasUnpricedRequests: boolean;
}

/** Today's per-device usage; local requests have no deviceId. */
export function deviceTodayStats(entries: readonly UsageEntry[], now: number): Map<string, DeviceUsage> {
  const start = startOfDay(now);
  const stats = new Map<string, DeviceUsage>();
  for (const entry of entries) {
    if (entry.timestamp < start) continue;
    const key = entry.deviceId ?? LOCAL_DEVICE_KEY;
    const current = stats.get(key);
    if (current) {
      current.requests += 1;
      current.cost += costTotal(entry.cost);
    } else {
      stats.set(key, { requests: 1, cost: costTotal(entry.cost), hasUnpricedRequests: !entry.isPriced });
    }
  }
  return stats;
}

/** Entries that belong to one device; local entries (no deviceId) belong to the self device. */
export function entriesForDevice(
  entries: readonly UsageEntry[],
  device: DeviceInfo,
  selfDeviceId: string | undefined,
): UsageEntry[] {
  const self = device.isSelf === true || (selfDeviceId != null && device.id === selfDeviceId);
  return entries.filter((entry) => (entry.deviceId != null ? entry.deviceId === device.id : self));
}

/** Sessions that belong to one device; local sessions (no deviceIds) belong to the self device. */
export function sessionsForDevice(
  sessions: readonly SessionSummary[],
  device: DeviceInfo,
  selfDeviceId: string | undefined,
): SessionSummary[] {
  const self = device.isSelf === true || (selfDeviceId != null && device.id === selfDeviceId);
  return sessions.filter((session) =>
    session.deviceIds != null && session.deviceIds.length > 0
      ? session.deviceIds.includes(device.id)
      : self,
  );
}

export interface DailyUsage {
  /** Local midnight of the day. */
  day: number;
  requests: number;
  tokens: TokenCounts;
  cost: number;
  hasUnpricedRequests: boolean;
}

/** Per-day usage rows, newest day first. */
export function dailyUsage(entries: readonly UsageEntry[]): DailyUsage[] {
  const byDay = new Map<number, DailyUsage>();
  for (const entry of entries) {
    const day = startOfDay(entry.timestamp);
    const current = byDay.get(day);
    if (current) {
      current.requests += 1;
      addTokens(current.tokens, entry.tokens);
      current.cost += costTotal(entry.cost);
      current.hasUnpricedRequests = current.hasUnpricedRequests || !entry.isPriced;
    } else {
      const tokens = emptyTokens();
      addTokens(tokens, entry.tokens);
      byDay.set(day, {
        day,
        requests: 1,
        tokens,
        cost: costTotal(entry.cost),
        hasUnpricedRequests: !entry.isPriced,
      });
    }
  }
  return [...byDay.values()].sort((a, b) => b.day - a.day);
}

export function deviceStatKey(device: DeviceInfo, selfDeviceId: string | undefined): string {
  if (device.isSelf || (selfDeviceId != null && device.id === selfDeviceId)) return LOCAL_DEVICE_KEY;
  return device.id;
}

export function platformLabel(platform: string): string {
  const value = platform.toLowerCase();
  if (value.includes("darwin") || value.includes("mac")) return "macOS";
  if (value.includes("win")) return "Windows";
  if (value.includes("linux")) return "Linux";
  return platform || "—";
}

// MARK: - Sessions (ContentView.swift visibleSessions)

export type SessionSort = "recent" | "cost";

export const SESSION_SORTS: readonly { key: SessionSort; label: string }[] = [
  { key: "recent", label: "最近活动" },
  { key: "cost", label: "金额" },
];

export function filterSessions(
  sessions: readonly SessionSummary[],
  start: number | null,
  query: string,
  sort: SessionSort,
): SessionSummary[] {
  let visible = start == null ? [...sessions] : sessions.filter((session) => session.end >= start);
  const trimmed = query.trim();
  if (trimmed.length > 0) {
    const lower = trimmed.toLowerCase();
    visible = visible.filter(
      (session) =>
        session.title.toLowerCase().includes(lower) ||
        session.projectName.toLowerCase().includes(lower) ||
        session.id.startsWith(trimmed),
    );
  }
  if (sort === "cost") visible.sort((a, b) => costTotal(b.cost) - costTotal(a.cost));
  return visible;
}

export interface TopSessionRow {
  id: string;
  session?: SessionSummary;
  cost: number;
  share: number;
}

export function topSessionRows(
  entries: readonly UsageEntry[],
  sessions: readonly SessionSummary[],
  limit: number,
): TopSessionRow[] {
  const costBySession = new Map<string, number>();
  for (const entry of entries) {
    costBySession.set(entry.sessionId, (costBySession.get(entry.sessionId) ?? 0) + costTotal(entry.cost));
  }
  let total = 0;
  for (const cost of costBySession.values()) total += cost;
  const denominator = total > 0 ? total : 1;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return [...costBySession.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, cost]) => ({ id, session: byId.get(id), cost, share: cost / denominator }));
}

// MARK: - Paths shown in settings

/** Swift configFileURL: the .claude.json next to the .claude directory. */
export function configFilePath(projectsPath: string): string {
  const backslash = String.fromCharCode(92);
  let clean = projectsPath;
  while (clean.endsWith("/") || clean.endsWith(backslash)) clean = clean.slice(0, -1);
  const index = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf(backslash));
  if (index < 0) return ".claude.json";
  const claudeDirectory = clean.slice(0, index);
  const separator = claudeDirectory.includes(backslash) && !claudeDirectory.includes("/") ? backslash : "/";
  return claudeDirectory + separator + ".claude.json";
}