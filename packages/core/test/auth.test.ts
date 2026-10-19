// Subscription vs third-party classification: cache TTL split, Anthropic ids, model family,
// mixed sessions, and the quota accounting filter (third-party usage must not consume limits).
import test from "node:test";
import assert from "node:assert/strict";
import {
  authSignals,
  buildQuotaSnapshotFromData,
  classifyAuthSignals,
  classifyEntryAuth,
  classifySessionAuth,
  filterSubscriptionEntries,
  isAnthropicRequestId,
  isClaudeModel,
} from "../src/index.js";
import type { UsageEntry } from "../src/index.js";

const HOUR = 3_600_000;
const START = Date.parse("2026-10-19T02:00:00Z");

function entry(overrides: Partial<UsageEntry> & { id: string; sessionId: string; timestamp: number }): UsageEntry {
  const base: UsageEntry = {
    id: overrides.id,
    sessionId: overrides.sessionId,
    timestamp: overrides.timestamp,
    model: "claude-opus-5-5",
    tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearches: 0 },
    isFast: false,
    cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 },
    isPriced: true,
  };
  return { ...base, ...overrides, tokens: { ...base.tokens, ...(overrides.tokens ?? {}) } };
}

function subscriptionEntry(id: string, sessionId: string, timestamp: number): UsageEntry {
  return entry({
    id: "msg_011CfN" + id + ":req_011CfN" + id,
    sessionId,
    timestamp,
    tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 5_000, webSearches: 0 },
  });
}

function thirdPartyClaudeEntry(id: string, sessionId: string, timestamp: number): UsageEntry {
  return entry({
    id: "opaque-" + id + ":",
    sessionId,
    timestamp,
    tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite5m: 5_000, cacheWrite1h: 0, webSearches: 0 },
  });
}

test("isClaudeModel / isAnthropicRequestId detect the two id shapes", () => {
  assert.equal(isClaudeModel("claude-opus-5-5"), true);
  assert.equal(isClaudeModel("deepseek-v4.1-flash"), false);
  assert.equal(isAnthropicRequestId("msg_011CfNabc:req_011CfNdef"), true);
  assert.equal(isAnthropicRequestId("0217898062834652d0:"), false);
});

test("classifyAuthSignals: cache TTL split drives the verdict", () => {
  assert.equal(classifyAuthSignals({ requests: 100, cacheWrite1h: 1_000_000, cacheWrite5m: 1_000, claudeRequests: 100, anthropicIdRequests: 100 }), "subscription");
  assert.equal(classifyAuthSignals({ requests: 100, cacheWrite1h: 1_000, cacheWrite5m: 1_000_000, claudeRequests: 100, anthropicIdRequests: 0 }), "thirdParty");
  assert.equal(classifyAuthSignals({ requests: 100, cacheWrite1h: 50_000, cacheWrite5m: 50_000, claudeRequests: 100, anthropicIdRequests: 100 }), "mixed");
  assert.equal(classifyAuthSignals({ requests: 10, cacheWrite1h: 0, cacheWrite5m: 0, claudeRequests: 0, anthropicIdRequests: 0 }), "thirdParty");
  assert.equal(classifyAuthSignals({ requests: 10, cacheWrite1h: 0, cacheWrite5m: 0, claudeRequests: 10, anthropicIdRequests: 8 }), "unknown");
});

test("classifySessionAuth and classifyEntryAuth", () => {
  const subscription = [subscriptionEntry("a", "s1", START), subscriptionEntry("b", "s1", START + HOUR)];
  assert.equal(classifySessionAuth(subscription), "subscription");
  const thirdParty = [thirdPartyClaudeEntry("a", "s2", START), thirdPartyClaudeEntry("b", "s2", START + HOUR)];
  assert.equal(classifySessionAuth(thirdParty), "thirdParty");
  assert.equal(classifyEntryAuth(thirdParty[0]!), "thirdParty");
  // Mixed session: 9 subscription + 1 third-party request.
  const mixed = [...subscription.slice(0, 1), ...Array.from({ length: 4 }, (_, index) => subscriptionEntry("m" + index, "s3", START + index)), thirdPartyClaudeEntry("x", "s3", START + 10)];
  const mixedMode = classifySessionAuth(mixed);
  assert.ok(mixedMode === "subscription" || mixedMode === "mixed", "mostly-1h session should not be thirdParty");
  assert.equal(classifyEntryAuth(subscription[0]!), "subscription");
});

test("filterSubscriptionEntries drops third-party sessions, keeps unknown and subscription", () => {
  const entries = [
    subscriptionEntry("a", "sub", START),
    subscriptionEntry("b", "sub", START + HOUR),
    thirdPartyClaudeEntry("c", "third", START),
    thirdPartyClaudeEntry("d", "third", START + HOUR),
    entry({ id: "e1", sessionId: "unknown", timestamp: START, tokens: { cacheWrite1h: 0, cacheWrite5m: 0 } }),
    entry({ id: "f1", sessionId: "other-model", timestamp: START, model: "deepseek-flash", isPriced: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 } }),
  ];
  const kept = filterSubscriptionEntries(entries);
  const keptSessions = new Set(kept.map((item) => item.sessionId));
  assert.equal(keptSessions.has("third"), false);
  assert.equal(keptSessions.has("other-model"), false);
  assert.equal(keptSessions.has("sub"), true);
  assert.equal(keptSessions.has("unknown"), true);
  assert.equal(kept.length, 3);
});

test("explicit session auth overrides the heuristic", () => {
  const heuristicThirdParty = [thirdPartyClaudeEntry("a", "relay", START), thirdPartyClaudeEntry("b", "relay", START + HOUR)];
  const heuristicSubscription = [subscriptionEntry("c", "proxy", START)];
  const overrides = new Map<string, "subscription" | "thirdParty">([
    ["relay", "subscription"], // mod says managed key -> authoritative
    ["proxy", "thirdParty"], // mod says custom BASE_URL -> authoritative
  ]);
  const kept = filterSubscriptionEntries([...heuristicThirdParty, ...heuristicSubscription], overrides);
  assert.deepEqual(kept.map((item) => item.sessionId), ["relay", "relay"]);
});

test("subscription quota ignores third-party sessions but keeps subscription and unknown", () => {
  const now = START + 2 * HOUR;
  const entries = [
    subscriptionEntry("a", "sub", START + 10 * 60_000),
    thirdPartyClaudeEntry("b", "third", START + 20 * 60_000),
    entry({ id: "c", sessionId: "unknown", timestamp: START + 30 * 60_000 }),
  ];
  const snapshot = buildQuotaSnapshotFromData({
    entries,
    observations: [],
    mode: "firstRequest",
    costBasis: "subscription",
    plan: { tier: "default_claude_max_20x", fetchedAt: START },
    now,
  });
  const window = snapshot.status.fiveHour?.window;
  assert.ok(window, "five-hour window exists");
  assert.equal(window.requestCount, 2, "third-party request is not counted");
  assert.equal(window.cost, 2, "third-party cost is not counted");
  assert.deepEqual([...window.sessionIds].sort(), ["sub", "unknown"]);
});