// Port of legacy/swift/Sources/CCUsageCore/Aggregation.swift.
//
// UsageSnapshot.build merges parsed transcripts into one deduplicated, time-ordered view;
// TimeGranularity/buckets/modelTotals power the charts and tables.

import type {
  CostBreakdown,
  LimitEvent,
  ParsedTranscript,
  SessionMetadata,
  SessionSummary,
  TokenCounts,
  UsageEntry,
  UsageSnapshot
} from "./types.js";
import { Pricing } from "./pricing.js";
import { addDays, isoWeekday, startOfDay, zonedEpoch, zonedParts } from "./time-utils.js";

// MARK: - Token helpers (Swift TokenCounts += / total)

export function emptyTokenCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearches: 0 };
}

export function addTokenCounts(target: TokenCounts, other: TokenCounts): TokenCounts {
  target.input += other.input;
  target.output += other.output;
  target.cacheRead += other.cacheRead;
  target.cacheWrite5m += other.cacheWrite5m;
  target.cacheWrite1h += other.cacheWrite1h;
  target.webSearches += other.webSearches;
  return target;
}

export function totalTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
}

export function costTotal(cost: CostBreakdown): number {
  return cost.input + cost.output + cost.cacheRead + cost.cacheWrite + cost.webSearch;
}

/** Fills nil fields of `target` from `source` (Swift SessionMetadata.fillMissing). */
function fillMissingMetadata(target: SessionMetadata, source: SessionMetadata | undefined): void {
  if (source === undefined) return;
  target.customTitle ??= source.customTitle;
  target.agentName ??= source.agentName;
  target.summary ??= source.summary;
  target.firstPrompt ??= source.firstPrompt;
  target.cwd ??= source.cwd;
  target.gitBranch ??= source.gitBranch;
  target.version ??= source.version;
}

/** Last path component like Foundation's URL.lastPathComponent (handles / and \\). */
export function lastPathComponent(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

/** Builds a snapshot from parsed transcripts (Swift UsageSnapshot.build). */
export function buildSnapshot(
  transcripts: ParsedTranscript[],
  recordedCosts: Record<string, number> = {}
): UsageSnapshot {
  // Main transcripts sort before their `<session>/subagents/` directory, so the first
  // occurrence of a request (e.g. copied into a resumed session) keeps ownership.
  const ordered = [...transcripts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const seen = new Set<string>();
  const entriesBySession: Record<string, UsageEntry[]> = {};
  const metadata = new Map<string, SessionMetadata>();
  const projectDirectories = new Map<string, string>();
  const subagents = new Map<string, Set<string>>();

  for (const transcript of ordered) {
    const sessionId = transcript.sessionId;
    if (transcript.agentId !== undefined) {
      const existing = metadata.get(sessionId) ?? {};
      fillMissingMetadata(existing, { cwd: transcript.metadata.cwd });
      metadata.set(sessionId, existing);
    } else {
      const merged: SessionMetadata = { ...transcript.metadata };
      fillMissingMetadata(merged, metadata.get(sessionId));
      metadata.set(sessionId, merged);
    }
    if (!projectDirectories.has(sessionId)) {
      projectDirectories.set(sessionId, transcript.projectDirectory);
    }

    for (const entry of transcript.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      let entries = entriesBySession[sessionId];
      if (entries === undefined) {
        entries = [];
        entriesBySession[sessionId] = entries;
      }
      entries.push(entry);
      if (entry.agentId !== undefined) {
        let agents = subagents.get(sessionId);
        if (agents === undefined) {
          agents = new Set();
          subagents.set(sessionId, agents);
        }
        agents.add(entry.agentId);
      }
    }
  }

  const sessions: SessionSummary[] = [];
  for (const [sessionId, unsorted] of Object.entries(entriesBySession)) {
    const entries = [...unsorted].sort((a, b) => a.timestamp - b.timestamp);
    entriesBySession[sessionId] = entries;
    const meta = metadata.get(sessionId) ?? {};

    const tokens = emptyTokenCounts();
    const cost: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 };
    let subagentCost = 0;
    const modelCost = new Map<string, number>();
    let unpriced = false;
    for (const entry of entries) {
      addTokenCounts(tokens, entry.tokens);
      cost.input += entry.cost.input;
      cost.output += entry.cost.output;
      cost.cacheRead += entry.cost.cacheRead;
      cost.cacheWrite += entry.cost.cacheWrite;
      cost.webSearch += entry.cost.webSearch;
      if (entry.agentId !== undefined) subagentCost += costTotal(entry.cost);
      const name = Pricing.displayName(entry.model);
      modelCost.set(name, (modelCost.get(name) ?? 0) + costTotal(entry.cost));
      unpriced = unpriced || !entry.isPriced;
    }

    const title =
      meta.customTitle ??
      meta.agentName ??
      meta.summary ??
      meta.firstPrompt ??
      `未命名会话 ${sessionId.slice(0, 8)}`;
    const projectName =
      meta.cwd !== undefined
        ? lastPathComponent(meta.cwd)
        : projectDirectories.get(sessionId) ?? "未知项目";

    const sortedModels = [...modelCost.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const first = entries[0];
    const last = entries[entries.length - 1];
    sessions.push({
      id: sessionId,
      title,
      projectName,
      ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      ...(meta.gitBranch !== undefined ? { gitBranch: meta.gitBranch } : {}),
      ...(meta.version !== undefined ? { version: meta.version } : {}),
      start: first?.timestamp ?? 0,
      end: last?.timestamp ?? 0,
      models: sortedModels,
      tokens,
      cost,
      subagentCost,
      requestCount: entries.length,
      subagentCount: subagents.get(sessionId)?.size ?? 0,
      hasUnpricedRequests: unpriced,
      ...(recordedCosts[sessionId] !== undefined ? { recordedCost: recordedCosts[sessionId] } : {})
    });
  }

  const allEntries = Object.values(entriesBySession)
    .flat()
    .sort((a, b) => a.timestamp - b.timestamp);
  const limitEvents = dedupeLimitEvents(ordered.flatMap((transcript) => transcript.limitEvents));

  return {
    entries: allEntries,
    sessions: sessions.sort((a, b) => b.end - a.end),
    entriesBySession,
    limitEvents,
    fileCount: transcripts.length,
    generatedAt: Date.now()
  };
}

/** Swift deduped LimitEvent values in a Set and sorted by timestamp. */
function dedupeLimitEvents(events: LimitEvent[]): LimitEvent[] {
  const seen = new Set<string>();
  const result: LimitEvent[] = [];
  for (const event of events) {
    const key = `${event.timestamp}|${event.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result.sort((a, b) => a.timestamp - b.timestamp);
}

/** Empty snapshot used as the initial IPC state before the first scan. */
export function emptyUsageSnapshot(): UsageSnapshot {
  return {
    entries: [],
    sessions: [],
    entriesBySession: {},
    limitEvents: [],
    fileCount: 0,
    generatedAt: Date.now()
  };
}

// MARK: - Time buckets

export type TimeGranularity = "fiveMinutes" | "fifteenMinutes" | "hour" | "day" | "week";

const GRANULARITIES: TimeGranularity[] = ["fiveMinutes", "fifteenMinutes", "hour", "day", "week"];

const GRANULARITY_LABELS: Record<TimeGranularity, string> = {
  fiveMinutes: "5 分钟",
  fifteenMinutes: "15 分钟",
  hour: "小时",
  day: "天",
  week: "周"
};

export function granularityLabel(granularity: TimeGranularity): string {
  return GRANULARITY_LABELS[granularity];
}

function startOfHour(ms: number, timeZone?: string): number {
  const parts = zonedParts(ms, timeZone);
  return zonedEpoch({ ...parts, minute: 0, second: 0 }, timeZone);
}

/** Calendar-aware bucket maths; mirrors Swift Calendar.current (optional IANA override). */
export const TimeGranularity = {
  all: GRANULARITIES,

  label(granularity: TimeGranularity): string {
    return granularityLabel(granularity);
  },

  /** A granularity that yields a readable number of points on a line for the given span. */
  suggestedFor(spanMs: number): TimeGranularity {
    if (spanMs < 2 * 86400000) return "fiveMinutes";
    if (spanMs < 10 * 86400000) return "fifteenMinutes";
    if (spanMs < 60 * 86400000) return "hour";
    return "day";
  },

  bucketStart(granularity: TimeGranularity, ms: number, timeZone?: string): number {
    switch (granularity) {
      case "fiveMinutes":
      case "fifteenMinutes": {
        const hourStart = startOfHour(ms, timeZone);
        const step = granularity === "fiveMinutes" ? 300_000 : 900_000;
        return hourStart + Math.floor((ms - hourStart) / step) * step;
      }
      case "hour":
        return startOfHour(ms, timeZone);
      case "day":
        return startOfDay(ms, timeZone);
      case "week": {
        const parts = zonedParts(ms, timeZone);
        const fromMonday = isoWeekday(parts.year, parts.month, parts.day) - 1;
        return addDays(startOfDay(ms, timeZone), -fromMonday, timeZone);
      }
    }
  },

  bucketEnd(granularity: TimeGranularity, startMs: number, timeZone?: string): number {
    switch (granularity) {
      case "fiveMinutes":
        return startMs + 300_000;
      case "fifteenMinutes":
        return startMs + 900_000;
      case "hour": {
        const parts = zonedParts(startMs, timeZone);
        if (parts.hour === 23) {
          return zonedEpoch({ ...parts, hour: 0, minute: 0, second: 0, ...addDaysParts(startMs, 1, timeZone) }, timeZone);
        }
        return zonedEpoch({ ...parts, hour: parts.hour + 1, minute: 0, second: 0 }, timeZone);
      }
      case "day":
        return addDays(startMs, 1, timeZone);
      case "week":
        return addDays(startMs, 7, timeZone);
    }
  }
};

/** Civil date of `ms + days` in the zone (hour/minute/second left to the caller). */
function addDaysParts(
  ms: number,
  days: number,
  timeZone?: string
): { year: number; month: number; day: number } {
  const parts = zonedParts(ms, timeZone);
  const civil = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86400000);
  return { year: civil.getUTCFullYear(), month: civil.getUTCMonth() + 1, day: civil.getUTCDate() };
}

// MARK: - Buckets / model totals

export interface UsageBucket {
  /** `start|series`, stable React key. */
  id: string;
  start: number;
  end: number;
  series: string;
  tokens: TokenCounts;
  cost: number;
  requestCount: number;
}

export interface ModelTotal {
  name: string;
  tokens: TokenCounts;
  cost: number;
  requestCount: number;
  hasUnpricedRequests: boolean;
}

/** Aggregates entries into (bucket start, series) cells, sorted by (start, series). */
export function buckets(
  entries: readonly UsageEntry[],
  granularity: TimeGranularity,
  seriesOf: (entry: UsageEntry) => string,
  timeZone?: string
): UsageBucket[] {
  const cells = new Map<string, UsageBucket>();
  for (const entry of entries) {
    const start = TimeGranularity.bucketStart(granularity, entry.timestamp, timeZone);
    const series = seriesOf(entry);
    const key = `${start}|${series}`;
    let bucket = cells.get(key);
    if (bucket === undefined) {
      bucket = {
        id: key,
        start,
        end: TimeGranularity.bucketEnd(granularity, start, timeZone),
        series,
        tokens: emptyTokenCounts(),
        cost: 0,
        requestCount: 0
      };
      cells.set(key, bucket);
    }
    addTokenCounts(bucket.tokens, entry.tokens);
    bucket.cost += costTotal(entry.cost);
    bucket.requestCount += 1;
  }
  return [...cells.values()].sort((a, b) => (a.start !== b.start ? a.start - b.start : compareStrings(a.series, b.series)));
}

/** Per-model totals sorted by cost, highest first (Swift UsageAggregator.modelTotals). */
export function modelTotals(entries: readonly UsageEntry[]): ModelTotal[] {
  const totals = new Map<string, ModelTotal>();
  for (const entry of entries) {
    const name = Pricing.displayName(entry.model);
    let total = totals.get(name);
    if (total === undefined) {
      total = { name, tokens: emptyTokenCounts(), cost: 0, requestCount: 0, hasUnpricedRequests: false };
      totals.set(name, total);
    }
    addTokenCounts(total.tokens, entry.tokens);
    total.cost += costTotal(entry.cost);
    total.requestCount += 1;
    if (!entry.isPriced) total.hasUnpricedRequests = true;
  }
  return [...totals.values()].sort((a, b) => b.cost - a.cost);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
