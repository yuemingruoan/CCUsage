// Quota-attribution classification: Claude models consume the subscription quota (even through a
// relay or shared login); non-Claude models never do. Cache TTL / request ids are diagnostics only.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuotaSnapshotFromData,
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

const claudeEntry = (id: string, sessionId: string, timestamp: number): UsageEntry =>
  entry({ id: "msg_011CfN" + id + ":req_011CfN" + id, sessionId, timestamp });

const thirdPartyEntry = (id: string, sessionId: string, timestamp: number): UsageEntry =>
  entry({ id: "opaque-" + id + ":", sessionId, timestamp, model: "deepseek-v4.1-flash", isPriced: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 } });

test("isClaudeModel / isAnthropicRequestId", () => {
  assert.equal(isClaudeModel("claude-opus-5-5"), true);
  assert.equal(isClaudeModel("deepseek-v4.1-flash"), false);
  assert.equal(isAnthropicRequestId("msg_011CfNabc:req_011CfNdef"), true);
  assert.equal(isAnthropicRequestId("0217898062834652d0:"), false);
});

test("quota attribution follows the model family, not the auth path", () => {
  const subscription = [claudeEntry("a", "s1", START), claudeEntry("b", "s1", START + HOUR)];
  assert.equal(classifySessionAuth(subscription), "subscription");
  // A Claude model served through a relay / API-key-looking request still consumes the quota:
  const relayed = [
    entry({ id: "opaque-c:", sessionId: "s2", timestamp: START, tokens: { cacheWrite5m: 5_000, cacheWrite1h: 0 } }),
    entry({ id: "opaque-d:", sessionId: "s2", timestamp: START + HOUR, tokens: { cacheWrite5m: 5_000, cacheWrite1h: 0 } }),
  ];
  assert.equal(classifySessionAuth(relayed), "subscription");
  assert.equal(classifyEntryAuth(relayed[0]!), "subscription");

  const third = [thirdPartyEntry("e", "s3", START)];
  assert.equal(classifySessionAuth(third), "thirdParty");
  assert.equal(classifyEntryAuth(third[0]!), "thirdParty");
  assert.equal(classifySessionAuth([]), "unknown");

  const mixed = [claudeEntry("f", "s4", START), thirdPartyEntry("g", "s4", START + HOUR)];
  assert.equal(classifySessionAuth(mixed), "mixed");
});

test("filterSubscriptionEntries keeps Claude usage, drops non-Claude sessions", () => {
  const entries = [
    claudeEntry("a", "sub", START),
    claudeEntry("b", "sub", START + HOUR),
    thirdPartyEntry("c", "third", START),
    thirdPartyEntry("d", "third", START + HOUR),
    claudeEntry("e", "mixed", START),
    thirdPartyEntry("f", "mixed", START + HOUR),
  ];
  const kept = filterSubscriptionEntries(entries);
  assert.deepEqual(kept.map((item) => item.sessionId).sort(), ["mixed", "sub", "sub"]);
  assert.deepEqual(kept.filter((item) => item.sessionId === "mixed").map((item) => item.model), ["claude-opus-5-5"]);
});

test("quota can use all usage; the optional subscription basis excludes non-Claude sessions", () => {
  const now = START + 2 * HOUR;
  const entries = [
    claudeEntry("a", "sub", START + 10 * 60_000),
    thirdPartyEntry("b", "third", START + 20 * 60_000),
  ];
  const all = buildQuotaSnapshotFromData({
    entries,
    observations: [],
    mode: "firstRequest",
    plan: { tier: "default_claude_max_20x", fetchedAt: START },
    now,
  });
  assert.equal(all.status.fiveHour?.window?.requestCount, 2);
  const subscriptionOnly = buildQuotaSnapshotFromData({
    entries,
    observations: [],
    mode: "firstRequest",
    costBasis: "subscription",
    plan: { tier: "default_claude_max_20x", fetchedAt: START },
    now,
  });
  assert.equal(subscriptionOnly.status.fiveHour?.window?.requestCount, 1);
  assert.equal(subscriptionOnly.status.fiveHour?.window?.cost, 1);
});
