// Ported from legacy/swift/Sources/CCUsageCore/Aggregation.swift and the shared parts of
// legacy/swift/Sources/CCUsage/Formatting.swift.
import test from "node:test";
import assert from "node:assert/strict";
import {
  Format,
  SeriesName,
  SeriesPalette,
  TimeGranularity,
  buckets,
  buildSnapshot,
  modelTotals,
  parseTranscriptData
} from "../src/index.js";
import type { CostBreakdown, TokenCounts, UsageEntry } from "../src/index.js";
import { Pricing } from "../src/index.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

function tokens(partial: Partial<TokenCounts> = {}): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearches: 0, ...partial };
}

function entry(
  id: string,
  timestamp: number,
  model = "claude-opus-5-5",
  tokenCounts: Partial<TokenCounts> = {},
  session = "s1",
  agentId?: string
): UsageEntry {
  const counts = tokens(tokenCounts);
  const priced = Pricing.cost(counts, model);
  const cost: CostBreakdown = priced ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 };
  return {
    id,
    sessionId: session,
    timestamp,
    model,
    tokens: counts,
    isFast: false,
    ...(agentId !== undefined ? { agentId } : {}),
    cost,
    isPriced: priced !== undefined
  };
}

test("suggested granularity follows the Swift thresholds", () => {
  assert.equal(TimeGranularity.suggestedFor(DAY), "fiveMinutes");
  assert.equal(TimeGranularity.suggestedFor(2 * DAY - 1), "fiveMinutes");
  assert.equal(TimeGranularity.suggestedFor(2 * DAY), "fifteenMinutes");
  assert.equal(TimeGranularity.suggestedFor(10 * DAY - 1), "fifteenMinutes");
  assert.equal(TimeGranularity.suggestedFor(10 * DAY), "hour");
  assert.equal(TimeGranularity.suggestedFor(60 * DAY - 1), "hour");
  assert.equal(TimeGranularity.suggestedFor(60 * DAY), "day");
  assert.deepEqual(TimeGranularity.all, ["fiveMinutes", "fifteenMinutes", "hour", "day", "week"]);
});

test("bucket boundaries in UTC for every granularity", () => {
  const at = Date.parse("2026-09-26T05:33:38.000Z");
  assert.equal(TimeGranularity.bucketStart("hour", at, "UTC"), Date.parse("2026-09-26T05:00:00Z"));
  assert.equal(TimeGranularity.bucketEnd("hour", Date.parse("2026-09-26T05:00:00Z"), "UTC"), Date.parse("2026-09-26T06:00:00Z"));
  assert.equal(TimeGranularity.bucketStart("fiveMinutes", at, "UTC"), Date.parse("2026-09-26T05:30:00Z"));
  assert.equal(TimeGranularity.bucketEnd("fiveMinutes", Date.parse("2026-09-26T05:30:00Z"), "UTC"), Date.parse("2026-09-26T05:35:00Z"));
  assert.equal(TimeGranularity.bucketStart("fifteenMinutes", at, "UTC"), Date.parse("2026-09-26T05:30:00Z"));
  assert.equal(TimeGranularity.bucketEnd("fifteenMinutes", Date.parse("2026-09-26T05:30:00Z"), "UTC"), Date.parse("2026-09-26T05:45:00Z"));
  assert.equal(TimeGranularity.bucketStart("day", at, "UTC"), Date.parse("2026-09-26T00:00:00Z"));
  assert.equal(TimeGranularity.bucketEnd("day", Date.parse("2026-09-26T00:00:00Z"), "UTC"), Date.parse("2026-09-27T00:00:00Z"));
  // 2026-09-26 is a Saturday; weeks start on Monday.
  assert.equal(TimeGranularity.bucketStart("week", at, "UTC"), Date.parse("2026-09-21T00:00:00Z"));
  assert.equal(TimeGranularity.bucketEnd("week", Date.parse("2026-09-21T00:00:00Z"), "UTC"), Date.parse("2026-09-28T00:00:00Z"));
});

test("bucket boundaries are timezone aware", () => {
  const at = Date.parse("2026-09-26T05:33:38.000Z");
  // Singapore is UTC+8: local midnight is 16:00Z the previous day.
  assert.equal(TimeGranularity.bucketStart("day", at, "Asia/Singapore"), Date.parse("2026-09-25T16:00:00Z"));
  assert.equal(TimeGranularity.bucketStart("hour", at, "Asia/Singapore"), Date.parse("2026-09-26T05:00:00Z"));
  // New York is UTC-4 in September: local midnight is 04:00Z.
  assert.equal(TimeGranularity.bucketStart("day", at, "America/New_York"), Date.parse("2026-09-26T04:00:00Z"));
});

test("buckets aggregate by (start, series), sorted by start then series", () => {
  const start = Date.parse("2026-09-26T05:00:00Z");
  const entries = [
    entry("e1", start + 1_000, "claude-opus-5-5", { output: 1_000_000 }, "s1"),
    entry("e2", start + 2_000, "claude-haiku-4-5", { output: 1_000_000 }, "s2"),
    entry("e3", start + 70 * 60_000, "claude-opus-5-5", { output: 1_000_000 }, "s1")
  ];
  const result = buckets(entries, "hour", (item) => (item.sessionId === "s1" ? "主会话" : "子代理"), "UTC");
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((bucket) => [bucket.start, bucket.series, bucket.requestCount]),
    [
      [Date.parse("2026-09-26T05:00:00Z"), "主会话", 1],
      [Date.parse("2026-09-26T05:00:00Z"), "子代理", 1],
      [Date.parse("2026-09-26T06:00:00Z"), "主会话", 1]
    ]
  );
  // The two 05:00 buckets do not mix series.
  const firstHour = result.filter((bucket) => bucket.start === start);
  assert.equal(firstHour.length, 2);
  assert.equal(firstHour.reduce((total, bucket) => total + bucket.requestCount, 0), 2);
  assert.equal(result[0]!.id, `${result[0]!.start}|${result[0]!.series}`);
  assert.equal(result[0]!.end, result[0]!.start + HOUR);
});

test("model totals are sorted by cost and flag unpriced requests", () => {
  const entries = [
    entry("e1", 0, "claude-opus-5-5", { output: 1_000_000 }),
    entry("e2", 0, "claude-haiku-4-5", { output: 5_000_000 }),
    entry("e3", 0, "claude-haiku-4-5", { input: 100_000_000 }),
    entry("e4", 0, "gpt-unknown", { output: 1_000 })
  ];
  const totals = modelTotals(entries);
  assert.deepEqual(
    totals.map((total) => total.name),
    ["Haiku 4.5", "Opus 5.5", "gpt-unknown"]
  );
  assert.equal(totals[0]!.requestCount, 2);
  // 5M output at $5/M + 100M input at $1/M.
  assert.ok(Math.abs(totals[0]!.cost - (25 + 100)) < 1e-9);
  assert.equal(totals[1]!.requestCount, 1);
  assert.ok(Math.abs(totals[1]!.cost - 20) < 1e-9);
  const unknown = totals.find((total) => total.name === "gpt-unknown");
  assert.equal(unknown?.hasUnpricedRequests, true);
  assert.equal(unknown?.cost, 0);
  assert.equal(totals[0]!.hasUnpricedRequests, false);
});

test("buildSnapshot sorts sessions, dedupes limit events and fills entriesBySession", () => {
  const line = (session: string, output: number, time: string): string =>
    JSON.stringify({
      type: "assistant",
      sessionId: session,
      requestId: "req",
      timestamp: time,
      message: { id: `msg-${session}-${output}`, model: "claude-opus-5-5", usage: { output_tokens: output } }
    });
  const a = parseTranscriptData(line("a", 10, "2026-09-26T05:00:00Z"), "/tmp/projects/-p/a.jsonl", "/tmp/projects");
  const b = parseTranscriptData(line("b", 20, "2026-09-26T06:00:00Z"), "/tmp/projects/-p/b.jsonl", "/tmp/projects");
  const limit = (timestamp: number, text: string) => ({ timestamp, text });
  a.limitEvents = [limit(2, "x")];
  b.limitEvents = [limit(2, "x"), limit(1, "y")];

  const snapshot = buildSnapshot([a, b], { a: 1.5 });
  assert.equal(snapshot.fileCount, 2);
  assert.deepEqual(
    snapshot.sessions.map((session) => session.id),
    ["b", "a"] // most recent activity first
  );
  assert.equal(snapshot.sessions.find((session) => session.id === "a")?.recordedCost, 1.5);
  assert.equal(snapshot.sessions.find((session) => session.id === "b")?.recordedCost, undefined);
  assert.equal(snapshot.entriesBySession["a"]?.length, 1);
  assert.equal(snapshot.entries.length, 2);
  assert.deepEqual(
    snapshot.limitEvents.map((event) => event.text),
    ["y", "x"]
  );
  assert.ok(snapshot.generatedAt > 0);
  // Titles fall back to the encoded session id.
  assert.match(snapshot.sessions[0]!.title, /^未命名会话 b/);
});

test("Format helpers match the Swift output shapes", () => {
  assert.equal(Format.usd(0), "$0.00");
  assert.equal(Format.usd(0.5), "$0.500");
  assert.equal(Format.usd(137.8), "$137.80");
  assert.equal(Format.usd(1234.5), "$1,234.50");
  assert.equal(Format.usd(-0.5), "-$0.500");
  assert.equal(Format.tokens(999), "999");
  assert.equal(Format.tokens(1_500), "1.5K");
  assert.equal(Format.tokens(2_500_000), "2.5M");
  assert.equal(Format.tokens(1_200_000_000), "1.20B");
  assert.equal(Format.duration(30_000), "1m");
  assert.equal(Format.duration(60 * 60_000), "1h");
  assert.equal(Format.duration(90 * 60_000), "1h 30m");
  assert.equal(Format.duration(2 * DAY), "2d");
  assert.equal(Format.duration(2.5 * DAY), "2d 12h");
  assert.match(Format.dateTime(Date.parse("2026-09-26T05:33:38Z")), /^\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.match(Format.bucketLabel(Date.parse("2026-09-26T00:00:00Z"), "day"), /^\d{4}\/\d{2}\/\d{2}$/);
  assert.match(Format.bucketLabel(Date.parse("2026-09-21T00:00:00Z"), "week"), /起一周$/);
  assert.match(Format.bucketRange(Date.parse("2026-09-26T05:00:00Z"), "hour"), / – /);
  assert.equal(Format.granularity("fiveMinutes"), "5 分钟");
  assert.equal(Format.granularity("day"), "天");
});

test("SeriesPalette exposes the eight light/dark pairs and series names", () => {
  assert.equal(SeriesPalette.maxSeries, 8);
  assert.equal(SeriesPalette.light.length, 8);
  assert.equal(SeriesPalette.dark.length, 8);
  assert.equal(SeriesPalette.light[0], "#2A78D6");
  assert.equal(SeriesPalette.dark[0], "#3987E5");
  assert.equal(SeriesPalette.color(0), "#2A78D6");
  assert.equal(SeriesPalette.color(99), "");
  assert.equal(SeriesPalette.colorFor(0, "dark"), "#3987E5");
  assert.equal(SeriesPalette.colorFor(0, "light"), "#2A78D6");
  assert.equal(SeriesPalette.otherName, "其他");
  assert.equal(SeriesName.main, "主会话");
  assert.equal(SeriesName.subagent, "子代理");
});
