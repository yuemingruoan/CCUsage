// Ported from legacy/swift/Tests/CCUsageCoreTests/QuotaTests.swift plus status-line log,
// plan-history, snapshot builders and cross-device merge coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildQuotaSnapshot,
  buildQuotaSnapshotFromData,
  limitMessageObservation,
  mergeEntries,
  mergeObservations,
  planChanges,
  planDisplayName,
  quotaEstimate,
  quotaStatus,
  quotaWindows,
  readPlanHistory,
  readPlanInfo,
  readStatusLineLog,
  recordPlanInfo
} from "../src/index.js";
import type {
  LimitEvent,
  PlanChange,
  PlanInfo,
  QuotaKind,
  QuotaObservation,
  QuotaWindow,
  UsageEntry
} from "../src/index.js";

const date = (text: string): number => Date.parse(text);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearches: 0 });

function entry(time: string, cost = 1, index = 0): UsageEntry {
  // Haiku 4.5 output is $5 per million tokens.
  const output = cost * 200_000;
  return {
    id: `e${index}`,
    sessionId: "s",
    timestamp: date(time),
    model: "claude-haiku-4-5",
    tokens: { ...zeroTokens(), output },
    isFast: false,
    cost: { input: 0, output: (output * 5) / 1_000_000, cacheRead: 0, cacheWrite: 0, webSearch: 0 },
    isPriced: true
  };
}

function entries(times: string[], cost = 1): UsageEntry[] {
  return times.map((time, index) => entry(time, cost, index));
}

function makeWindow(start: string, cost: number, fitted?: number, hit = false): QuotaWindow {
  const window: QuotaWindow = {
    kind: "fiveHour",
    start: date(start),
    isConfirmed: false,
    tokens: zeroTokens(),
    cost,
    requestCount: 0,
    sessionIds: [],
    observations: [],
    costBeforeReset: 0,
    end: date(start) + 5 * HOUR
  };
  if (fitted !== undefined) {
    window.latestSample = { observedAt: date(start), usedPercentage: 50, cost: fitted / 2 };
  }
  if (hit) {
    window.observations = [
      { kind: "fiveHour", observedAt: date(start), resetsAt: window.end, usedPercentage: 100, source: "limitMessage" }
    ];
  }
  return window;
}

function report(
  kind: QuotaKind,
  time: string,
  resets: string,
  percentage: number,
  session = "a"
): QuotaObservation {
  return {
    kind,
    observedAt: date(time),
    resetsAt: date(resets),
    usedPercentage: percentage,
    source: "statusLine",
    sessionId: session
  };
}

function tempDir(t: test.TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ccusage-quota-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// MARK: - Limit messages

test("limit messages resolve the next local reset time", () => {
  const event: LimitEvent = {
    timestamp: date("2026-09-24T11:09:37Z"),
    text: "You've hit your session limit · resets 10:10pm (Asia/Singapore)"
  };
  const observation = limitMessageObservation(event);
  assert.ok(observation);
  assert.equal(observation.kind, "fiveHour");
  assert.equal(observation.resetsAt, date("2026-09-24T14:10:00Z"));
  assert.equal(observation.usedPercentage, 100);
  assert.equal(observation.source, "limitMessage");

  const weekly = limitMessageObservation({
    timestamp: date("2026-09-24T11:00:00Z"),
    text: "You've hit your weekly limit · resets Mon 9am (UTC)"
  });
  assert.equal(weekly?.kind, "sevenDay");
  assert.equal(weekly?.resetsAt, date("2026-09-28T09:00:00Z"));

  const opus = limitMessageObservation({
    timestamp: date("2026-09-24T11:00:00Z"),
    text: "You've hit your Opus weekly limit · resets Mon 9am (UTC)"
  });
  assert.equal(opus, null);

  const sonnet = limitMessageObservation({
    timestamp: date("2026-09-24T11:00:00Z"),
    text: "You've hit your Sonnet weekly limit · resets Mon 9am (UTC)"
  });
  assert.equal(sonnet, null);
});

test("limit messages support the 5-hour phrasing, day names and a missing zone", () => {
  const observation = limitMessageObservation({
    timestamp: date("2026-09-24T11:00:00Z"),
    text: "You've hit your 5-hour limit · resets 2:30pm"
  });
  assert.equal(observation?.kind, "fiveHour");
  assert.ok(observation);
  // Without a quoted zone Swift used TimeZone.current (the host's local zone).
  const local = new Date(observation.resetsAt);
  assert.equal(local.getHours(), 14);
  assert.equal(local.getMinutes(), 30);
  assert.ok(observation.resetsAt > date("2026-09-24T11:00:00Z"));

  const dated = limitMessageObservation({
    timestamp: date("2026-09-24T11:00:00Z"),
    text: "You've hit your session limit · resets Sep 30, 9am (UTC)"
  });
  assert.equal(dated?.resetsAt, date("2026-09-30T09:00:00Z"));
});

// MARK: - Windows

test("first-request windows match observed resets", () => {
  const usage = entries([
    "2026-09-24T09:12:07Z",
    "2026-09-24T11:06:02Z",
    "2026-09-24T14:23:23Z",
    "2026-09-24T15:50:00Z"
  ]);
  const windows = quotaWindows("fiveHour", usage, [], "firstRequest", date("2026-09-25T00:00:00Z"));
  assert.deepEqual(
    windows.map((window) => window.start),
    [date("2026-09-24T09:12:00Z"), date("2026-09-24T14:23:00Z")]
  );
  assert.deepEqual(windows.map((window) => window.requestCount), [2, 2]);
  assert.ok(windows.every((window) => !window.isConfirmed));
});

test("reported reset times take precedence", () => {
  const usage = entries(["2026-09-24T09:12:07Z", "2026-09-24T11:06:02Z", "2026-09-24T14:23:23Z"]);
  const anchor: QuotaObservation = {
    kind: "fiveHour",
    observedAt: date("2026-09-24T11:09:37Z"),
    resetsAt: date("2026-09-24T14:10:00Z"),
    usedPercentage: 100,
    source: "limitMessage"
  };
  const windows = quotaWindows("fiveHour", usage, [anchor], "firstRequest");
  assert.equal(windows[0]!.start, date("2026-09-24T09:10:00Z"));
  assert.equal(windows[0]!.isConfirmed, true);
  assert.equal(windows[0]!.requestCount, 2);
  assert.equal(windows[1]!.start, date("2026-09-24T14:23:00Z"));
});

test("fixed rolling windows repeat from the latest reset", () => {
  const usage = entries(["2026-09-24T20:05:00Z"]);
  const anchor = report("fiveHour", "2026-09-24T12:00:00Z", "2026-09-24T14:10:00Z", 40);
  const windows = quotaWindows("fiveHour", usage, [anchor], "fixedRolling", date("2026-09-24T20:30:00Z"));
  assert.deepEqual(
    windows.map((window) => window.start),
    [date("2026-09-24T09:10:00Z"), date("2026-09-24T19:10:00Z")]
  );
});

test("windows carry tokens, cost, session ids and observations", () => {
  const usage = entries(["2026-09-26T10:00:00Z", "2026-09-26T10:30:00Z"], 2);
  const windows = quotaWindows("fiveHour", usage, [], "firstRequest", date("2026-09-26T11:00:00Z"));
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.cost, 4);
  assert.equal(windows[0]!.tokens.output, 800_000);
  assert.deepEqual(windows[0]!.sessionIds, ["s"]);
});

// MARK: - Status

test("status extrapolates from the reported percentage", () => {
  const usage = entries(["2026-09-26T10:00:00Z", "2026-09-26T10:30:00Z", "2026-09-26T11:00:00Z"], 10);
  const reportAt = report("fiveHour", "2026-09-26T10:45:00Z", "2026-09-26T15:00:00Z", 20);
  const now = date("2026-09-26T11:10:00Z");
  const windows = quotaWindows("fiveHour", usage, [reportAt], "firstRequest", now);
  assert.equal(windows.length, 1);
  // $20 spent by the 20% report -> 100% is about $100.
  assert.ok(Math.abs((windows[0]!.latestSample?.usedPercentage ?? 0) - 100 / 5) < 1e-9);
  assert.ok(Math.abs((windows[0]!.latestSample ? (windows[0]!.latestSample.cost / windows[0]!.latestSample.usedPercentage) * 100 : 0) - 100) < 1e-6);

  const status = quotaStatus("fiveHour", windows, usage, [], now);
  assert.ok(Math.abs((status.percentage ?? 0) - 30) < 1e-6);
  assert.equal(status.percentageIsReported, false);
});

test("reported percentage is kept when no limit estimate exists", () => {
  const usage = entries(["2026-09-26T10:00:00Z"], 1);
  const observation = report("fiveHour", "2026-09-26T10:15:00Z", "2026-09-26T15:00:00Z", 14);
  const now = date("2026-09-26T10:20:00Z");
  const windows = quotaWindows("fiveHour", usage, [observation], "firstRequest", now);
  const status = quotaStatus("fiveHour", windows, usage, [], now);
  assert.equal(status.percentage, 14);
  assert.equal(status.percentageIsReported, true);
});

// MARK: - Estimate

test("upgrade drops older samples", () => {
  const windows = [
    makeWindow("2026-09-24T09:00:00Z", 40, 40, true),
    makeWindow("2026-09-24T14:00:00Z", 44, 44, true),
    makeWindow("2026-09-25T09:00:00Z", 84),
    makeWindow("2026-09-25T14:00:00Z", 110)
  ];
  const estimate = quotaEstimate(windows);
  assert.ok(estimate);
  assert.equal(estimate.cost, undefined);
  assert.equal(estimate.lowerBound, 110);
  assert.deepEqual(estimate.planChange, {
    date: date("2026-09-25T09:00:00Z"),
    kind: "inferredUpgrade"
  });
});

test("downgrade starts a new plan period", () => {
  const windows = [
    makeWindow("2026-09-24T09:00:00Z", 150),
    makeWindow("2026-09-24T14:00:00Z", 100, 200),
    makeWindow("2026-09-25T09:00:00Z", 40, 45, true)
  ];
  const estimate = quotaEstimate(windows);
  assert.ok(estimate);
  assert.equal(estimate.cost, 45);
  assert.equal(estimate.planChange?.kind, "inferredDowngrade");
});

test("recorded tier change excludes earlier windows", () => {
  const windows = [
    makeWindow("2026-09-24T09:00:00Z", 40, 40, true),
    makeWindow("2026-09-25T09:00:00Z", 30, 150)
  ];
  const change: PlanChange = {
    date: date("2026-09-25T00:00:00Z"),
    kind: "recorded",
    from: "default_claude_pro",
    to: "default_claude_max_5x"
  };
  const estimate = quotaEstimate(windows, [change]);
  assert.ok(estimate);
  assert.equal(estimate.cost, 150);
  assert.deepEqual(estimate.planChange, change);
  assert.equal(planDisplayName("default_claude_max_5x"), "Max 5x");
  assert.equal(planDisplayName("default_claude_max_20x"), "Max 20x");
  assert.equal(planDisplayName("weird_tier"), "weird_tier");
});

test("latest sample of the plan period wins over older samples", () => {
  const windows = [
    makeWindow("2026-09-25T09:00:00Z", 50, 100),
    makeWindow("2026-09-25T14:00:00Z", 60, 110),
    makeWindow("2026-09-25T19:00:00Z", 20)
  ];
  const estimate = quotaEstimate(windows);
  assert.ok(estimate);
  assert.ok(Math.abs((estimate.cost ?? 0) - 110) < 1e-9);
  assert.equal(estimate.planChange, undefined);
});

test("a recorded change far from any reset keeps its date", () => {
  const window = makeWindow("2026-09-25T09:00:00Z", 30);
  window.resetAt = date("2026-09-25T10:00:00Z");
  const change: PlanChange = {
    date: date("2026-09-27T00:00:00Z"),
    kind: "recorded",
    from: "default_claude_pro",
    to: "default_claude_max_5x"
  };
  assert.equal(quotaEstimate([window], [change]), undefined);
});

test("weekly reset inside a window starts a new plan period", () => {
  const usage = entries(
    ["2026-10-07T12:00:00Z", "2026-10-07T12:30:00Z", "2026-10-07T13:10:00Z", "2026-10-07T13:20:00Z"],
    10
  );
  const resets = "2026-10-13T05:00:00Z";
  const observations = [
    report("sevenDay", "2026-10-07T12:31:00Z", resets, 37),
    // A stale idle session dipping by one point is not a reset.
    report("sevenDay", "2026-10-07T12:40:00Z", resets, 36, "idle"),
    report("sevenDay", "2026-10-07T13:01:36Z", resets, 37),
    report("sevenDay", "2026-10-07T13:04:22Z", resets, 0),
    report("sevenDay", "2026-10-07T13:25:00Z", resets, 4)
  ];
  const now = date("2026-10-07T13:30:00Z");
  const windows = quotaWindows("sevenDay", usage, observations, "fixedRolling", now);
  const current = windows.find((window) => window.start <= now && now < window.end);
  assert.ok(current);
  assert.equal(current.resetAt, date("2026-10-07T13:01:36Z"));
  assert.equal(current.cost, 40);
  assert.equal(current.cost - current.costBeforeReset, 20);
  const sample = current.latestSample;
  assert.ok(sample);
  assert.ok(Math.abs((sample.cost / sample.usedPercentage) * 100 - 500) < 1e-6);

  const upgrade: PlanChange = {
    date: date("2026-10-07T08:56:53Z"),
    kind: "recorded",
    from: "default_claude_max_5x",
    to: "default_claude_max_20x"
  };
  const estimate = quotaEstimate(windows, [upgrade]);
  assert.ok(estimate);
  assert.ok(Math.abs((estimate.cost ?? 0) - 500) < 1e-6);
  assert.equal(estimate.planChange?.date, date("2026-10-07T13:01:36Z"));
});

test("an early 5-hour reset cuts the previous window", () => {
  const usage = entries(
    ["2026-10-07T11:40:30Z", "2026-10-07T12:30:00Z", "2026-10-07T13:01:00Z", "2026-10-07T13:10:00Z"],
    10
  );
  const observations = [
    report("fiveHour", "2026-10-07T12:31:00Z", "2026-10-07T16:40:00Z", 12),
    report("fiveHour", "2026-10-07T13:01:36Z", "2026-10-07T16:40:00Z", 18),
    report("fiveHour", "2026-10-07T13:04:22Z", "2026-10-07T18:00:00Z", 0),
    report("fiveHour", "2026-10-07T13:08:53Z", "2026-10-07T18:00:00Z", 1, "b")
  ];
  const now = date("2026-10-07T13:15:00Z");
  const windows = quotaWindows("fiveHour", usage, observations, "firstRequest", now);
  assert.deepEqual(
    windows.map((window) => window.start),
    [date("2026-10-07T11:40:00Z"), date("2026-10-07T13:00:00Z")]
  );
  assert.ok(windows.every((window) => window.isConfirmed));
  assert.equal(windows[0]!.end, date("2026-10-07T13:00:00Z"));
  assert.equal(windows[0]!.observations.length, 2);
  assert.equal(windows[1]!.resetAt, date("2026-10-07T13:01:36Z"));
  assert.equal(windows[1]!.cost - windows[1]!.costBeforeReset, 10);

  const upgrade: PlanChange = {
    date: date("2026-10-07T08:56:53Z"),
    kind: "recorded",
    from: "default_claude_max_5x",
    to: "default_claude_max_20x"
  };
  const status = quotaStatus("fiveHour", windows, usage, [upgrade], now);
  assert.equal(status.window?.start, date("2026-10-07T13:00:00Z"));
  assert.equal(status.estimate?.cost, undefined);
  assert.equal(status.estimate?.lowerBound, 10);
  assert.equal(status.percentage, 1);
  assert.equal(status.percentageIsReported, true);
});

// MARK: - Status line log

test("readStatusLineLog reads legacy seconds and newer milliseconds", (t) => {
  const directory = tempDir(t);
  const logPath = path.join(directory, "rate-limits.jsonl");
  const base = 1_790_000_000; // seconds
  const lines = [
    JSON.stringify({
      ts: base,
      session_id: "a",
      five_hour: { used_percentage: 12.5, resets_at: base + 3600 },
      seven_day: { used_percentage: 80, resets_at: base + 7 * 86400 }
    }),
    JSON.stringify({ ts: base * 1000, session_id: "b", five_hour: { used_percentage: 13, resets_at: (base + 3600) * 1000 } }),
    "{ not json",
    JSON.stringify({ ts: base, session_id: "c" })
  ];
  writeFileSync(logPath, lines.join("\n") + "\n");
  const observations = readStatusLineLog(logPath);
  assert.equal(observations.length, 3);
  assert.equal(observations[0]!.kind, "fiveHour");
  assert.equal(observations[0]!.observedAt, base * 1000);
  assert.equal(observations[0]!.resetsAt, (base + 3600) * 1000);
  assert.equal(observations[0]!.source, "statusLine");
  assert.equal(observations[0]!.sessionId, "a");
  assert.equal(observations[1]!.kind, "sevenDay");
  assert.equal(observations[2]!.observedAt, base * 1000);
  assert.equal(observations[2]!.usedPercentage, 13);
  assert.deepEqual(readStatusLineLog(path.join(directory, "missing.jsonl")), []);
});

// MARK: - Plan info / history

test("readPlanInfo reads the oauth account tier", (t) => {
  const directory = tempDir(t);
  const configFile = path.join(directory, ".claude.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      oauthAccount: {
        organizationRateLimitTier: "default_claude_max_20x",
        organizationType: "claude_max",
        profileFetchedAt: 1_791_000_000_000
      }
    })
  );
  assert.deepEqual(readPlanInfo(configFile), {
    tier: "default_claude_max_20x",
    organizationType: "claude_max",
    fetchedAt: 1_791_000_000_000
  });

  writeFileSync(configFile, JSON.stringify({ oauthAccount: { userRateLimitTier: "default_claude_pro" } }));
  assert.equal(readPlanInfo(configFile)?.tier, "default_claude_pro");
  writeFileSync(configFile, JSON.stringify({}));
  assert.equal(readPlanInfo(configFile), undefined);
  assert.equal(readPlanInfo(path.join(directory, "missing.json")), undefined);
});

test("plan history records tier changes once and yields plan changes", (t) => {
  const directory = tempDir(t);
  const logPath = path.join(directory, "nested", "plan-history.jsonl");
  const planA: PlanInfo = { tier: "default_claude_max_5x", organizationType: "claude_max", fetchedAt: date("2026-10-01T00:00:00Z") };
  const planB: PlanInfo = { tier: "default_claude_max_20x", fetchedAt: date("2026-10-07T08:56:53Z") };

  assert.deepEqual(recordPlanInfo(planA, logPath), [planA]);
  assert.deepEqual(readPlanHistory(logPath), [planA]);
  // The on-disk format stays Swift compatible: ISO-8601 fetchedAt.
  const firstRecord = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(firstRecord.tier, "default_claude_max_5x");
  assert.equal(firstRecord.fetchedAt, "2026-10-01T00:00:00Z");
  assert.equal(firstRecord.organizationType, "claude_max");

  // Same tier: no new line, same history.
  assert.equal(recordPlanInfo(planA, logPath).length, 1);
  assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 1);
  assert.equal(recordPlanInfo(undefined, logPath).length, 1);

  const history = recordPlanInfo(planB, logPath);
  assert.equal(history.length, 2);
  assert.deepEqual(planChanges(history), [
    {
      date: planB.fetchedAt,
      kind: "recorded",
      from: "default_claude_max_5x",
      to: "default_claude_max_20x"
    }
  ]);
  assert.deepEqual(readPlanHistory(logPath), [planA, planB]);
});

// MARK: - Snapshot builders

test("buildQuotaSnapshot combines the status line log, limit messages and plan history", (t) => {
  const directory = tempDir(t);
  const statusLineLogPath = path.join(directory, "rate-limits.jsonl");
  const planHistoryPath = path.join(directory, "plan-history.jsonl");
  const configFile = path.join(directory, ".claude.json");
  const now = date("2026-09-24T12:00:00Z");
  const resets = now + 2 * HOUR;
  const base = Math.floor((now - HOUR) / 1000);
  writeFileSync(
    statusLineLogPath,
    [
      JSON.stringify({ ts: base, session_id: "a", five_hour: { used_percentage: 20, resets_at: resets / 1000 } }),
      JSON.stringify({ ts: base, session_id: "a", seven_day: { used_percentage: 50, resets_at: (now + 3 * DAY) / 1000 } })
    ].join("\n") + "\n"
  );
  writeFileSync(
    configFile,
    JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" } })
  );

  const usage = entries(["2026-09-24T11:00:00Z", "2026-09-24T11:30:00Z"], 2);
  const limitEvents: LimitEvent[] = [
    { timestamp: now, text: "You've hit your session limit · resets 10:10pm (UTC)" }
  ];
  const extraObservations: QuotaObservation[] = [
    {
      kind: "fiveHour",
      observedAt: now,
      resetsAt: resets,
      usedPercentage: 25,
      source: "statusLine",
      deviceId: "other"
    }
  ];

  const snapshot = buildQuotaSnapshot({
    entries: usage,
    limitEvents,
    mode: "firstRequest",
    configFile,
    statusLineLogPath,
    planHistoryPath,
    extraObservations,
    now
  });
  assert.equal(snapshot.statusLineObservationCount, 3);
  assert.equal(snapshot.limitMessageCount, 1);
  assert.equal(snapshot.plan?.tier, "default_claude_max_20x");
  assert.ok(Array.isArray(snapshot.windows.fiveHour));
  assert.ok(Array.isArray(snapshot.windows.sevenDay));
  assert.equal(snapshot.status.fiveHour?.kind, "fiveHour");
  assert.equal(snapshot.status.sevenDay?.kind, "sevenDay");
  assert.equal(readPlanHistory(planHistoryPath).length, 1);
});

test("buildQuotaSnapshotFromData is pure and used by the server", () => {
  const now = date("2026-09-24T12:00:00Z");
  const resets = now + 2 * HOUR;
  const plan: PlanInfo = { tier: "default_claude_max_20x", fetchedAt: date("2026-09-01T00:00:00Z") };
  const snapshot = buildQuotaSnapshotFromData({
    entries: entries(["2026-09-24T11:00:00Z"], 2),
    observations: [
      { kind: "fiveHour", observedAt: now - 5 * MIN, resetsAt: resets, usedPercentage: 25, source: "statusLine", deviceId: "a" },
      { kind: "fiveHour", observedAt: now, resetsAt: resets, usedPercentage: 26, source: "statusLine", deviceId: "b" }
    ],
    limitEvents: [{ timestamp: now, text: "You've hit your weekly limit · resets Mon 9am (UTC)" }],
    mode: "fixedRolling",
    plan,
    planChanges: [],
    now
  });
  assert.equal(snapshot.statusLineObservationCount, 2);
  assert.equal(snapshot.limitMessageCount, 1);
  assert.equal(snapshot.plan, plan);
  assert.ok((snapshot.windows.fiveHour?.length ?? 0) >= 1);
  assert.equal(snapshot.status.fiveHour?.window?.start, date("2026-09-24T09:00:00Z"));
});

// MARK: - Cross-device merging

test("mergeEntries dedupes by id, local wins and remote keeps deviceId", () => {
  const localEntry = entry("2026-09-24T10:00:00Z", 1, 0);
  const second = entry("2026-09-24T09:00:00Z", 2, 1);
  const remoteSameId: UsageEntry = { ...localEntry, deviceId: "d2", timestamp: date("2026-09-24T10:00:00Z") + 5 };
  const remoteNew: UsageEntry = { ...entry("2026-09-24T11:00:00Z", 3, 2), id: "remote", deviceId: "d2" };
  const merged = mergeEntries([localEntry, second], [remoteSameId, remoteNew]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((item) => item.id === localEntry.id)?.deviceId, undefined);
  assert.equal(merged.find((item) => item.id === "remote")?.deviceId, "d2");
  assert.deepEqual(
    merged.map((item) => item.timestamp),
    [...merged.map((item) => item.timestamp)].sort((a, b) => a - b)
  );
});

test("mergeObservations dedupes by kind/observedAt/resetsAt/deviceId, local wins", () => {
  const resets = date("2026-09-24T14:10:00Z");
  const local: QuotaObservation[] = [
    { kind: "fiveHour", observedAt: date("2026-09-24T11:00:00Z"), resetsAt: resets, usedPercentage: 20, source: "statusLine" },
    { kind: "sevenDay", observedAt: date("2026-09-24T11:00:00Z"), resetsAt: date("2026-09-28T09:00:00Z"), usedPercentage: 50, source: "limitMessage" }
  ];
  const remote: QuotaObservation[] = [
    { ...local[0]!, usedPercentage: 99 },
    { ...local[0]!, deviceId: "d2" },
    { kind: "fiveHour", observedAt: date("2026-09-24T10:00:00Z"), resetsAt: resets, usedPercentage: 10, source: "statusLine", deviceId: "d2" }
  ];
  const merged = mergeObservations(local, remote);
  assert.equal(merged.length, 4);
  const sameKey = merged.find(
    (item) => item.kind === "fiveHour" && item.observedAt === date("2026-09-24T11:00:00Z") && item.deviceId === undefined
  );
  assert.equal(sameKey?.usedPercentage, 20);
  assert.ok(merged.some((item) => item.deviceId === "d2" && item.kind === "fiveHour"));
  assert.deepEqual(
    merged.map((item) => item.observedAt),
    [...merged.map((item) => item.observedAt)].sort((a, b) => a - b)
  );
});
