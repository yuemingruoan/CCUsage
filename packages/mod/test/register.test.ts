import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bridgeCandidatePaths, buildReading, jsonlRecord, shouldReport, shouldWriteJsonl,
  statusText, initialReportState, DEFAULT_POLL_MS, REPEAT_AFTER_MS,
} from "../plugin/hooks/register.ts";

const usage = {
  rateLimits: [
    { kind: "five_hour", percentUsed: 4, resetsAt: "2026-10-19T02:40:00.000Z" },
    { kind: "seven_day", percentUsed: 97, resetsAt: "2026-10-20T05:00:00.000Z" },
  ],
  cost: { usd: 34.63 },
};

test("bridgeCandidatePaths covers macOS, Windows, XDG and ~/.config", () => {
  const paths = bridgeCandidatePaths({ home: "/Users/u", appdata: "C:\\Users\\u\\AppData\\Roaming", xdg: "/home/u/.config" });
  assert.equal(paths[0], "/Users/u/Library/Application Support/CCUsage/bridge.json");
  assert.ok(paths.some(p => p.replace(/\\/g, "/").includes("AppData/Roaming/CCUsage/bridge.json")));
  assert.equal(paths[2], "/home/u/.config/CCUsage/bridge.json");
  assert.equal(paths.at(-1), "/Users/u/.config/CCUsage/bridge.json");
});

test("buildReading converts ISO reset times to epoch ms", () => {
  const reading = buildReading("s1", usage, 1_000_000);
  assert.equal(reading.sessionId, "s1");
  assert.equal(reading.rateLimits.length, 2);
  assert.equal(reading.rateLimits[0]?.kind, "five_hour");
  assert.equal(reading.rateLimits[0]?.resetsAt, Date.parse("2026-10-19T02:40:00.000Z"));
  assert.equal(reading.cost?.usd, 34.63);
  assert.equal(reading.at, 1_000_000);
});

test("statusText keeps the Swift status line spelling", () => {
  const text = statusText(usage);
  assert.ok(text);
  assert.match(text as string, /^5h 4% ↻\d\d:\d\d · 7d 97% ↻[A-Z][a-z]{2} \d\d:\d\d · \$34\.63$/);
});

test("statusText omits windows and cost when absent", () => {
  assert.equal(statusText({ rateLimits: [] }), undefined);
  assert.equal(statusText({ rateLimits: [{ kind: "five_hour", percentUsed: 0 }] }), "5h 0%");
});

test("jsonlRecord matches the legacy rate-limits.jsonl line", () => {
  const record = jsonlRecord("s1", usage, 1_791_808_344_000);
  assert.ok(record);
  const parsed = JSON.parse(record as string);
  assert.equal(parsed.ts, 1_791_808_344);
  assert.equal(parsed.session_id, "s1");
  assert.equal(parsed.five_hour.used_percentage, 4);
  assert.equal(parsed.five_hour.resets_at, Math.floor(Date.parse("2026-10-19T02:40:00.000Z") / 1000));
  assert.equal(parsed.seven_day.used_percentage, 97);
});

test("shouldReport: first push, refreshId bump, changed reading, poll interval", () => {
  const config = { token: "t", pollMs: DEFAULT_POLL_MS, refreshId: 1 };
  const reading = buildReading("s1", usage, 1000);
  const state = initialReportState();
  assert.equal(shouldReport(state, config, reading, 1000), true, "first push");
  state.lastPushAt = 1000;
  state.lastRefreshId = 1;
  state.lastRateLimits = JSON.stringify(reading.rateLimits);
  assert.equal(shouldReport(state, config, reading, 2000), false, "unchanged within poll");
  assert.equal(shouldReport(state, config, reading, 1000 + DEFAULT_POLL_MS), true, "poll elapsed");
  assert.equal(shouldReport(state, { ...config, refreshId: 2 }, reading, 2000), true, "refreshId bump");
  const changed = buildReading("s1", { ...usage, rateLimits: [{ kind: "five_hour", percentUsed: 5, resetsAt: usage.rateLimits[0]?.resetsAt }] }, 2000);
  assert.equal(shouldReport(state, config, changed, 2000), true, "reading changed");
});

test("shouldWriteJsonl repeats an unchanged reading only after REPEAT_AFTER_MS", () => {
  const state = initialReportState();
  const record = "{}";
  assert.equal(shouldWriteJsonl(state, record, 0), true);
  state.lastJsonlAt = 0;
  state.lastJsonlReading = record;
  assert.equal(shouldWriteJsonl(state, record, REPEAT_AFTER_MS - 1), false);
  assert.equal(shouldWriteJsonl(state, record, REPEAT_AFTER_MS), true);
  assert.equal(shouldWriteJsonl(state, undefined, 0), false);
});