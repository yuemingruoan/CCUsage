// Port of legacy/swift/Sources/CCUsageCore/Quota.swift and PlanHistory.swift, plus the
// file-backed QuotaSnapshot builder from the Swift app's UsageStore.swift.
//
// The subscription quota is reconstructed from two sources:
//  - exact status-line reports (`rate-limits.jsonl`, written by the CCUsage mod),
//  - "You've hit your … limit · resets …" messages found in transcripts (minute rounded).
// From those report anchors and the local usage entries we rebuild windows, estimate what
// 100% of a limit is worth in USD and where the current window is heading.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { filterSubscriptionEntries } from "./auth.js";
import type { AuthMode } from "./types.js";
import type {
  LimitEstimate,
  LimitEvent,
  LimitSample,
  PlanChange,
  PlanInfo,
  QuotaKind,
  QuotaObservation,
  QuotaSnapshot,
  QuotaStatus,
  QuotaWindow,
  UsageEntry,
  WindowMode
} from "./types.js";
import { addTokenCounts, costTotal, emptyTokenCounts } from "./aggregation.js";
import { isValidTimeZone, nextDateMatching } from "./time-utils.js";

export const QUOTA_KINDS: QuotaKind[] = ["fiveHour", "sevenDay"];

/** Window duration: 5 hours / 7 days, in milliseconds (Swift QuotaKind.duration). */
export function quotaKindDuration(kind: QuotaKind): number {
  return kind === "fiveHour" ? 5 * 3600 * 1000 : 7 * 86400 * 1000;
}

export function quotaKindLabel(kind: QuotaKind): string {
  return kind === "fiveHour" ? "5 小时" : "每周";
}

export function windowModeLabel(mode: WindowMode): string {
  return mode === "firstRequest" ? "首条请求开启窗口" : "固定周期滚动";
}

/** `default_claude_max_5x` -> "Max 5x" (Swift PlanInfo.displayName(forTier:)). */
export function planDisplayName(tier: string): string {
  // Swift replaces every occurrence of "default_" before splitting.
  const parts = tier.split("default_").join("").split("_");
  if (parts[0] !== "claude") return tier;
  return parts
    .slice(1)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Legacy observation logs store epoch *seconds* (written by the status line script / mod).
 * New writers may store milliseconds; accept both so mixed histories keep working.
 */
function epochMs(value: number): number {
  return value >= 100_000_000_000 ? value : value * 1000;
}

// MARK: - Status line log

interface StatusLineRecord {
  ts?: number;
  session_id?: string;
  sessionId?: string;
  device_id?: string;
  deviceId?: string;
  five_hour?: StatusLineWindow;
  fiveHour?: StatusLineWindow;
  seven_day?: StatusLineWindow;
  sevenDay?: StatusLineWindow;
}

interface StatusLineWindow {
  used_percentage?: number;
  usedPercentage?: number;
  resets_at?: number;
  resetsAt?: number;
}

/** Reads the JSONL log written by the CCUsage mod (Swift StatusLineLog.read). */
export function readStatusLineLog(logPath: string): QuotaObservation[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const observations: QuotaObservation[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as StatusLineRecord;
    if (typeof record.ts !== "number") continue;
    const observedAt = epochMs(record.ts);
    const sessionId = record.session_id ?? record.sessionId;
    const deviceId = record.device_id ?? record.deviceId;
    const windows: Array<[QuotaKind, StatusLineWindow | undefined]> = [
      ["fiveHour", record.five_hour ?? record.fiveHour],
      ["sevenDay", record.seven_day ?? record.sevenDay]
    ];
    for (const [kind, window] of windows) {
      if (window === undefined) continue;
      const used = window.used_percentage ?? window.usedPercentage;
      const resets = window.resets_at ?? window.resetsAt;
      if (typeof used !== "number" || typeof resets !== "number") continue;
      observations.push({
        kind,
        observedAt,
        resetsAt: epochMs(resets),
        usedPercentage: used,
        source: "statusLine",
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(deviceId !== undefined ? { deviceId } : {})
      });
    }
  }
  return observations;
}

// MARK: - Limit messages

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const PERSONAL_LIMIT_WORDS = ["opus", "fable", "sonnet", "mythos"];

/** Parses "You've hit your session limit · resets 10:10pm (Asia/Singapore)". */
export function limitMessageObservation(event: LimitEvent): QuotaObservation | null {
  const lower = event.text.toLowerCase();
  let kind: QuotaKind;
  if (lower.includes("session limit") || lower.includes("5-hour limit")) {
    kind = "fiveHour";
  } else if (
    lower.includes("weekly limit") &&
    !PERSONAL_LIMIT_WORDS.some((word) => lower.includes(word))
  ) {
    kind = "sevenDay";
  } else {
    return null;
  }
  const resetsAt = limitResetDate(event.text, event.timestamp);
  if (resetsAt === undefined) return null;
  return {
    kind,
    observedAt: event.timestamp,
    resetsAt,
    usedPercentage: 100,
    source: "limitMessage"
  };
}

/** Next date after `date` matching "10:10pm", "Mon 9am" or "Sep 30, 9am" in the quoted zone. */
function limitResetDate(text: string, afterMs: number): number | undefined {
  const markerIndex = text.indexOf("resets ");
  if (markerIndex < 0) return undefined;
  let body = text.slice(markerIndex + "resets ".length);
  let timeZone: string | undefined;
  const open = body.indexOf("(");
  if (open >= 0) {
    const close = body.indexOf(")", open);
    if (close >= 0) {
      const identifier = body.slice(open + 1, close);
      if (isValidTimeZone(identifier)) timeZone = identifier;
      body = body.slice(0, open);
    }
  }
  const lower = body.toLowerCase();
  const match = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/.exec(lower);
  if (match === null) return undefined;
  const rawHour = Number(match[1]);
  const hour = (rawHour % 12) + (match[3] === "pm" ? 12 : 0);
  const minute = match[2] !== undefined ? Number(match[2]) : 0;

  let weekday: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  const prefixText = lower.slice(0, match.index);
  for (const word of prefixText.split(/[ ,]+/)) {
    if (word.length === 0) continue;
    const prefix = Array.from(word).slice(0, 3).join("");
    const weekdayIndex = WEEKDAYS.indexOf(prefix);
    if (weekdayIndex >= 0) {
      weekday = weekdayIndex + 1; // Foundation: 1 = Sunday
      continue;
    }
    const monthIndex = MONTHS.indexOf(prefix);
    if (monthIndex >= 0) {
      month = monthIndex + 1;
      continue;
    }
    if (/^\d+$/.test(word)) day = Number(word);
  }

  return nextDateMatching(afterMs, { hour, minute, second: 0, weekday, month, day }, timeZone);
}

// MARK: - Windows

/** Limit messages round reset times; treat anchors this close as the same window. */
const MATCH_TOLERANCE = 15 * 60 * 1000;
/** How far a recorded plan change may be moved to an observed usage reset. */
const PLAN_CHANGE_SNAP = 86400 * 1000;
/** Smallest drop within one session's reports that counts as a reset. */
const RESET_DROP = 2.0;

function makeWindow(kind: QuotaKind, start: number, isConfirmed: boolean): QuotaWindow {
  return {
    kind,
    start,
    isConfirmed,
    tokens: emptyTokenCounts(),
    cost: 0,
    requestCount: 0,
    sessionIds: [],
    observations: [],
    costBeforeReset: 0,
    end: start + quotaKindDuration(kind)
  };
}

function windowContains(window: QuotaWindow, date: number): boolean {
  return window.start <= date && date < window.end;
}

function addEntry(window: QuotaWindow, entry: UsageEntry): void {
  addTokenCounts(window.tokens, entry.tokens);
  window.cost += costTotal(entry.cost);
  window.requestCount += 1;
  if (!window.sessionIds.includes(entry.sessionId)) window.sessionIds.push(entry.sessionId);
}

function observationsSinceReset(window: QuotaWindow): QuotaObservation[] {
  const resetAt = window.resetAt;
  return resetAt === undefined
    ? window.observations
    : window.observations.filter((observation) => observation.observedAt > resetAt);
}

function costSinceReset(window: QuotaWindow): number {
  return window.cost - window.costBeforeReset;
}

function impliedLimit(sample: LimitSample): number {
  return (sample.cost / sample.usedPercentage) * 100;
}

/**
 * Swift relied on snapshot entries being timestamp-sorted (it binary-searches them). Server
 * callers can pass per-request arrays, so sort defensively only when the order is broken.
 */
function ensureSorted(entries: readonly UsageEntry[]): readonly UsageEntry[] {
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]!.timestamp < entries[index - 1]!.timestamp) {
      return [...entries].sort((a, b) => a.timestamp - b.timestamp);
    }
  }
  return entries;
}

/** Rebuilds quota windows from anchors and usage entries (Swift QuotaCalculator.windows). */
export function quotaWindows(
  kind: QuotaKind,
  entries: readonly UsageEntry[],
  observations: readonly QuotaObservation[],
  mode: WindowMode,
  now: number = Date.now()
): QuotaWindow[] {
  const duration = quotaKindDuration(kind);
  entries = ensureSorted(entries);
  // Exact status line data first, then the most recent observation.
  const anchors = observations
    .filter((observation) => observation.kind === kind)
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === "statusLine" ? -1 : 1;
      return b.observedAt - a.observedAt;
    });

  // Overlapping windows are the same one, unless the status line reported both reset times
  // exactly: then Claude Code opened the later window early.
  const confirmedAnchors: QuotaObservation[] = [];
  for (const anchor of anchors) {
    const anchorStart = anchor.resetsAt - duration;
    const duplicate = confirmedAnchors.some((existing) => {
      const distance = Math.abs(existing.resetsAt - duration - anchorStart);
      return (
        distance < MATCH_TOLERANCE ||
        (distance < duration && (existing.source !== "statusLine" || anchor.source !== "statusLine"))
      );
    });
    if (!duplicate) confirmedAnchors.push(anchor);
  }
  const windows: QuotaWindow[] = confirmedAnchors
    .map((anchor) => anchor.resetsAt - duration)
    .sort((a, b) => a - b)
    .map((start) => makeWindow(kind, start, true));
  const confirmedCount = windows.length;

  const gridOrigin = mode === "fixedRolling" && anchors.length > 0 ? anchors[0]!.resetsAt - duration : undefined;
  const gridStart = (date: number, origin: number): number =>
    origin + Math.floor((date - origin) / duration) * duration;

  const timelines: Array<Array<{ date: number; cost: number }>> = Array.from(
    { length: confirmedCount },
    () => []
  );
  let openIndex: number | undefined;
  for (const entry of entries) {
    const time = entry.timestamp;
    let index: number | undefined;
    for (let candidate = confirmedCount - 1; candidate >= 0; candidate -= 1) {
      if (windowContains(windows[candidate]!, time)) {
        index = candidate;
        break;
      }
    }
    if (index === undefined && openIndex !== undefined && windowContains(windows[openIndex]!, time)) {
      index = openIndex;
    }
    if (index === undefined) {
      const start =
        gridOrigin !== undefined
          ? gridStart(time, gridOrigin)
          : Math.floor(time / 60000) * 60000;
      windows.push(makeWindow(kind, start, false));
      timelines.push([]);
      index = windows.length - 1;
      openIndex = index;
    }
    addEntry(windows[index]!, entry);
    timelines[index]!.push({ date: time, cost: costTotal(entry.cost) });
  }

  if (gridOrigin !== undefined && !windows.some((window) => windowContains(window, now))) {
    windows.push(makeWindow(kind, gridStart(now, gridOrigin), false));
    timelines.push([]);
  }

  for (const observation of anchors) {
    let index = windows.findIndex(
      (window) => Math.abs(window.end - observation.resetsAt) < MATCH_TOLERANCE
    );
    if (index < 0) index = windows.findIndex((window) => windowContains(window, observation.observedAt));
    if (index >= 0) windows[index]!.observations.push(observation);
  }

  for (const window of windows) {
    window.observations.sort((a, b) => a.observedAt - b.observedAt);
    window.resetAt = inWindowReset(window.observations);
  }

  // A window opened before the previous one ended: the previous one was cut short, and
  // usage reported against it until then belongs to the old limit.
  const cuttable = Math.max(confirmedCount - 1, 0);
  for (let index = 0; index < cuttable; index += 1) {
    const current = windows[index]!;
    const next = windows[index + 1]!;
    if (!(current.end > next.start)) continue;
    const firstNew = next.observations[0]?.observedAt ?? Number.POSITIVE_INFINITY;
    let lastOld: number | undefined;
    for (let observationIndex = current.observations.length - 1; observationIndex >= 0; observationIndex -= 1) {
      const observedAt = current.observations[observationIndex]!.observedAt;
      if (observedAt < firstNew) {
        lastOld = observedAt;
        break;
      }
    }
    if (lastOld !== undefined && lastOld > next.start) {
      next.resetAt = Math.max(next.resetAt ?? lastOld, lastOld);
    }
    current.end = next.start;
  }

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]!;
    const timeline = timelines[index]!;
    if (window.resetAt !== undefined) {
      const resetAt = window.resetAt;
      window.costBeforeReset = timeline.reduce(
        (total, point) => (point.date <= resetAt ? total + point.cost : total),
        0
      );
    }
    window.latestSample = latestSample(observationsSinceReset(window), timeline, window.resetAt);
  }

  return windows.sort((a, b) => a.start - b.start);
}

/** The last report before one session saw the percentage drop within the same window. */
function inWindowReset(observations: QuotaObservation[]): number | undefined {
  const last = new Map<string, QuotaObservation>();
  let reset: number | undefined;
  for (const observation of observations) {
    if (observation.source !== "statusLine") continue;
    const key = observation.sessionId ?? "";
    const previous = last.get(key);
    if (previous !== undefined && previous.usedPercentage - observation.usedPercentage >= RESET_DROP) {
      reset = previous.observedAt;
    }
    last.set(key, observation);
  }
  return reset;
}

/**
 * The latest observation with a usable percentage, paired with the cost spent by then
 * (after `resetAt`, if the window was reset).
 * Very small percentages are skipped: their rounding makes spent / percentage unreliable.
 */
function latestSample(
  observations: QuotaObservation[],
  timeline: Array<{ date: number; cost: number }>,
  resetAt?: number
): LimitSample | undefined {
  const since = resetAt ?? Number.NEGATIVE_INFINITY;
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    if (observation.usedPercentage < 3) continue;
    let cost = 0;
    for (const point of timeline) {
      if (point.date > since && point.date <= observation.observedAt) cost += point.cost;
    }
    if (cost <= 0) continue;
    return {
      observedAt: observation.observedAt,
      usedPercentage: observation.usedPercentage,
      cost
    };
  }
  return undefined;
}

/** Estimates 100% of the window as spent / used percentage from the latest plan period. */
export function quotaEstimate(
  windows: readonly QuotaWindow[],
  planChanges: readonly PlanChange[] = []
): LimitEstimate | undefined {
  let recorded: PlanChange | undefined;
  for (const change of planChanges) {
    if (recorded === undefined || change.date > recorded.date) recorded = change;
  }
  if (recorded !== undefined) {
    const logged = recorded;
    let nearest: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const window of windows) {
      if (window.resetAt === undefined) continue;
      const distance = Math.abs(window.resetAt - logged.date);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = window.resetAt;
      }
    }
    if (nearest !== undefined && bestDistance <= PLAN_CHANGE_SNAP) {
      recorded = { ...logged, date: nearest };
    }
  }

  let change: PlanChange | undefined = recorded;
  let sample: LimitSample | undefined;
  let lowerBound = 0;
  const startPeriod = (newChange: PlanChange): void => {
    change = newChange;
    sample = undefined;
    lowerBound = 0;
  };

  const sorted = [...windows].sort((a, b) => a.start - b.start);
  for (const window of sorted) {
    // A window straddling a recorded change mixes both limits, unless it was reset there.
    const periodStart = window.resetAt ?? window.start;
    if (recorded !== undefined && periodStart < recorded.date) continue;
    const previous = sample === undefined ? undefined : impliedLimit(sample);
    if (window.latestSample !== undefined) {
      const latest = window.latestSample;
      const implied = impliedLimit(latest);
      if (previous !== undefined && (implied < previous * 0.8 || implied < lowerBound * 0.95)) {
        startPeriod({ date: periodStart, kind: "inferredDowngrade" });
      } else if (previous !== undefined && implied > previous * 1.25) {
        startPeriod({ date: periodStart, kind: "inferredUpgrade" });
      }
      sample = latest;
      continue;
    }
    const maxObserved = observationsSinceReset(window).reduce(
      (max, observation) => Math.max(max, observation.usedPercentage),
      0
    );
    const hitLimit = maxObserved >= 100;
    const cost = costSinceReset(window);
    if (hitLimit || cost <= 0) continue;
    if (previous !== undefined && cost > previous * 1.05) {
      startPeriod({ date: periodStart, kind: "inferredUpgrade" });
    }
    lowerBound = Math.max(lowerBound, cost);
  }

  if (sample === undefined && lowerBound <= 0) return undefined;
  const estimatedCost = sample === undefined ? undefined : impliedLimit(sample);
  return {
    ...(sample !== undefined ? { sample } : {}),
    ...(estimatedCost !== undefined ? { cost: estimatedCost } : {}),
    lowerBound,
    ...(change !== undefined ? { planChange: change } : {})
  };
}

/** Where the current window stands and where it is heading (Swift QuotaCalculator.status). */
export function quotaStatus(
  kind: QuotaKind,
  windows: readonly QuotaWindow[],
  entries: readonly UsageEntry[],
  planChanges: readonly PlanChange[] = [],
  now: number = Date.now()
): QuotaStatus {
  let current: QuotaWindow | undefined;
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    if (windowContains(windows[index]!, now)) {
      current = windows[index];
      break;
    }
  }
  const estimate = quotaEstimate(windows, planChanges);
  const latest =
    current !== undefined && current.observations.length > 0
      ? current.observations[current.observations.length - 1]
      : undefined;

  // Entries are sorted by timestamp (snapshot order); binary search for the start.
  const sortedEntries = ensureSorted(entries);
  const costSince = (start: number): number => {
    let low = 0;
    let high = sortedEntries.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sortedEntries[mid]!.timestamp < start) low = mid + 1;
      else high = mid;
    }
    let total = 0;
    for (let index = low; index < sortedEntries.length; index += 1) {
      const entry = sortedEntries[index]!;
      if (entry.timestamp > now) continue;
      total += costTotal(entry.cost);
    }
    return total;
  };

  let burnRate = 0;
  if (current !== undefined) {
    const lookback = kind === "fiveHour" ? 3600 * 1000 : 86400 * 1000;
    const since = Math.max(now - lookback, current.resetAt ?? current.start);
    burnRate = costSince(since) / (Math.max(now - since, 600 * 1000) / (3600 * 1000));
  }

  let percentage: number | undefined;
  let percentageIsReported = false;
  if (latest !== undefined) {
    const extra = costSince(latest.observedAt + 1000);
    const limit = estimate?.cost;
    if (limit !== undefined && limit > 0) {
      percentage = latest.usedPercentage + (extra / limit) * 100;
      percentageIsReported = extra === 0;
    } else {
      percentage = latest.usedPercentage;
      percentageIsReported = true;
    }
  } else if (current !== undefined && estimate?.cost !== undefined && estimate.cost > 0) {
    percentage = (costSinceReset(current) / estimate.cost) * 100;
  }

  let exhaustionDate: number | undefined;
  const limit = estimate?.cost;
  if (current !== undefined && percentage !== undefined && limit !== undefined) {
    if (percentage >= 100) {
      exhaustionDate = now;
    } else if (burnRate > 0) {
      const date = now + (((100 - percentage) / 100) * limit) / burnRate * 3600 * 1000;
      if (date < current.end) exhaustionDate = date;
    }
  }

  return {
    kind,
    ...(current !== undefined ? { window: current } : {}),
    ...(latest !== undefined ? { latestObservation: latest } : {}),
    ...(estimate !== undefined ? { estimate } : {}),
    burnRatePerHour: burnRate,
    ...(percentage !== undefined ? { percentage } : {}),
    percentageIsReported,
    ...(exhaustionDate !== undefined ? { exhaustionDate } : {})
  };
}

// MARK: - Plan info / history

/** Reads the plan Claude Code last fetched from `oauthAccount` in ~/.claude.json. */
export function readPlanInfo(configFile: string): PlanInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const account = (parsed as Record<string, unknown>)["oauthAccount"];
  if (typeof account !== "object" || account === null || Array.isArray(account)) return undefined;
  const record = account as Record<string, unknown>;
  const organizationTier = record["organizationRateLimitTier"];
  const userTier = record["userRateLimitTier"];
  const tier = typeof organizationTier === "string" ? organizationTier : typeof userTier === "string" ? userTier : undefined;
  if (tier === undefined) return undefined;
  const fetched = record["profileFetchedAt"];
  const fetchedAt = typeof fetched === "number" && Number.isFinite(fetched) ? fetched : Date.now();
  const organizationType = record["organizationType"];
  return {
    tier,
    ...(typeof organizationType === "string" ? { organizationType } : {}),
    fetchedAt
  };
}

function parsePlanInfoRecord(value: unknown): PlanInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tier = record["tier"];
  if (typeof tier !== "string") return undefined;
  const fetchedAt = parsePlanTimestamp(record["fetchedAt"]);
  if (fetchedAt === undefined) return undefined;
  const organizationType = record["organizationType"];
  return {
    tier,
    ...(typeof organizationType === "string" ? { organizationType } : {}),
    fetchedAt
  };
}

function parsePlanTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 100_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** Appends the plan tier to the history log if it differs from the last entry; returns the log. */
export function recordPlanInfo(plan: PlanInfo | undefined, logPath: string): PlanInfo[] {
  const history = readPlanHistory(logPath);
  if (plan === undefined || history[history.length - 1]?.tier === plan.tier) return history;
  const record: Record<string, unknown> = {
    tier: plan.tier,
    ...(plan.organizationType !== undefined ? { organizationType: plan.organizationType } : {}),
    // Swift JSONEncoder .iso8601 (whole seconds, no fractional part).
    fetchedAt: new Date(plan.fetchedAt).toISOString().replace(/\.\d{3}Z$/, "Z")
  };
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(record) + "\n");
  } catch {
    // Swift ignored write failures and still returned the in-memory history.
  }
  history.push(plan);
  return history;
}

/** Reads the append-only plan tier log (Swift PlanHistory.read). */
export function readPlanHistory(logPath: string): PlanInfo[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const history: PlanInfo[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const plan = parsePlanInfoRecord(parsed);
    if (plan !== undefined) history.push(plan);
  }
  return history;
}

/** Tier changes between consecutive log entries (Swift PlanHistory.changes). */
export function planChanges(history: readonly PlanInfo[]): PlanChange[] {
  const changes: PlanChange[] = [];
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1]!;
    const next = history[index]!;
    if (previous.tier === next.tier) continue;
    changes.push({
      date: next.fetchedAt,
      kind: "recorded",
      from: previous.tier,
      to: next.tier
    });
  }
  return changes;
}

// MARK: - Snapshot builders

export interface BuildQuotaSnapshotOptions {
  entries: UsageEntry[];
  limitEvents: LimitEvent[];
  mode: WindowMode;
  configFile: string;
  statusLineLogPath: string;
  planHistoryPath: string;
  /** Observations merged from other devices; they feed the windows but not the plan history. */
  extraObservations?: QuotaObservation[];
  /** Authoritative per-session auth verdicts; the heuristic applies when absent. */
  sessionAuth?: ReadonlyMap<string, AuthMode>;
  /**
   * Which usage feeds the window cost estimate: all synced usage (default; a relay can still
   * consume the subscription quota) or only heuristically subscription sessions.
   */
  costBasis?: "all" | "subscription";
  now?: number;
}

/** File-backed quota snapshot (port of the Swift app's QuotaSnapshot.build). */
export function buildQuotaSnapshot(options: BuildQuotaSnapshotOptions): QuotaSnapshot {
  const statusLine = readStatusLineLog(options.statusLineLogPath);
  const messages = options.limitEvents
    .map((event) => limitMessageObservation(event))
    .filter((observation): observation is QuotaObservation => observation !== null);
  const observations = [...statusLine, ...messages, ...(options.extraObservations ?? [])];
  const history = recordPlanInfo(readPlanInfo(options.configFile), options.planHistoryPath);
  const changes = planChanges(history);
  const plan = history[history.length - 1];
  return computeSnapshot({
    entries: options.entries,
    observations,
    mode: options.mode,
    planChanges: changes,
    ...(options.costBasis !== undefined ? { costBasis: options.costBasis } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(options.now !== undefined ? { now: options.now } : {})
  });
}

export interface BuildQuotaSnapshotFromDataOptions {
  entries: UsageEntry[];
  observations: QuotaObservation[];
  /** Transcript limit messages not yet converted to observations. */
  limitEvents?: LimitEvent[];
  mode: WindowMode;
  plan?: PlanInfo;
  planChanges?: PlanChange[];
  sessionAuth?: ReadonlyMap<string, AuthMode>;
  costBasis?: "all" | "subscription";
  now?: number;
}

/**
 * Pure quota snapshot from already-gathered data (used by the sync server over all devices'
 * entries/observations). No file access and no plan-history writes.
 */
export function buildQuotaSnapshotFromData(options: BuildQuotaSnapshotFromDataOptions): QuotaSnapshot {
  const messageObservations = (options.limitEvents ?? [])
    .map((event) => limitMessageObservation(event))
    .filter((observation): observation is QuotaObservation => observation !== null);
  const observations = [...options.observations, ...messageObservations];
  return computeSnapshot({
    entries: options.entries,
    observations,
    mode: options.mode,
    planChanges: options.planChanges ?? [],
    ...(options.costBasis !== undefined ? { costBasis: options.costBasis } : {}),
    ...(options.plan !== undefined ? { plan: options.plan } : {}),
    ...(options.now !== undefined ? { now: options.now } : {})
  });
}

function computeSnapshot(input: {
  entries: UsageEntry[];
  observations: QuotaObservation[];
  mode: WindowMode;
  planChanges: PlanChange[];
  plan?: PlanInfo;
  sessionAuth?: ReadonlyMap<string, AuthMode>;
  costBasis?: "all" | "subscription";
  now?: number;
}): QuotaSnapshot {
  const now = input.now ?? Date.now();
  // Cost basis: all synced usage by default (a relay may still consume the subscription
  // quota); costBasis: "subscription" excludes heuristic third-party sessions instead.
  const scopedEntries = input.costBasis === "subscription"
    ? filterSubscriptionEntries(input.entries, input.sessionAuth)
    : input.entries;
  const statusLineObservationCount = input.observations.filter(
    (observation) => observation.source === "statusLine"
  ).length;
  const limitMessageCount = input.observations.filter(
    (observation) => observation.source === "limitMessage"
  ).length;
  const windows: Partial<Record<QuotaKind, QuotaWindow[]>> = {};
  const status: Partial<Record<QuotaKind, QuotaStatus>> = {};
  for (const kind of QUOTA_KINDS) {
    // Weekly limits reset on a fixed schedule; the 5-hour mode is configurable.
    const kindWindows = quotaWindows(
      kind,
      scopedEntries,
      input.observations,
      kind === "sevenDay" ? "fixedRolling" : input.mode,
      now
    );
    windows[kind] = kindWindows;
    status[kind] = quotaStatus(kind, kindWindows, scopedEntries, input.planChanges, now);
  }
  return {
    windows,
    status,
    statusLineObservationCount,
    limitMessageCount,
    ...(input.plan !== undefined ? { plan: input.plan } : {})
  };
}

// MARK: - Cross-device merging

/**
 * Merges entries pulled from the server into the local list: deduplicated by entry id with
 * local entries winning, and remote entries keeping their `deviceId`. Sorted by timestamp,
 * like every snapshot entry list.
 */
export function mergeEntries(local: readonly UsageEntry[], remote: readonly UsageEntry[]): UsageEntry[] {
  const byId = new Map<string, UsageEntry>();
  for (const entry of local) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  for (const entry of remote) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Merges observations from other devices. Dedupe key matches the server's
 * (kind, observed_at, resets_at, device_id); local observations win on collisions.
 */
export function mergeObservations(
  local: readonly QuotaObservation[],
  remote: readonly QuotaObservation[]
): QuotaObservation[] {
  const seen = new Set<string>();
  const merged: QuotaObservation[] = [];
  const push = (observation: QuotaObservation): void => {
    const key = `${observation.kind}|${observation.observedAt}|${observation.resetsAt}|${observation.deviceId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(observation);
  };
  for (const observation of local) push(observation);
  for (const observation of remote) push(observation);
  return merged.sort((a, b) => a.observedAt - b.observedAt);
}