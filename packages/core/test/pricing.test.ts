// Ported from legacy/swift/Tests/CCUsageCoreTests/CCUsageCoreTests.swift (pricing cases)
// plus long-prompt / fast / web-search coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { Pricing } from "../src/index.js";

function tokens(partial: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h" | "webSearches", number>> = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearches: 0,
    ...partial
  };
}

test("pricing matches published rates (opus 5.5)", () => {
  const cost = Pricing.cost(tokens({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }), "claude-opus-5-5");
  assert.ok(cost);
  assert.equal(cost.input, 4);
  assert.equal(cost.output, 20);
  assert.ok(Math.abs(cost.cacheRead - 0.2) < 1e-9);
  // 5m = input*1.25 = 5, 1h = input*2 = 8
  assert.ok(Math.abs(cost.cacheWrite - 13) < 1e-9);

  const fast = Pricing.cost(tokens({ output: 1_000_000 }), "claude-opus-5-5", true);
  assert.ok(fast);
  assert.equal(fast.output, 40);
});

test("sonnet 5.5 rates", () => {
  const cost = Pricing.cost(tokens({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }), "claude-sonnet-5-5");
  assert.ok(cost);
  assert.equal(cost.input, 2);
  assert.equal(cost.output, 10);
  assert.ok(Math.abs(cost.cacheRead - 0.2) < 1e-9);
  assert.ok(Math.abs(cost.cacheWrite - (2.5 + 4)) < 1e-9);
});

test("haiku 5.5 long prompt tier applies above 100k prompt tokens", () => {
  const long = Pricing.cost(tokens({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }), "claude-haiku-5-5");
  assert.ok(long);
  assert.equal(long.input, 0.5);
  assert.equal(long.output, 2.5);
  assert.ok(Math.abs(long.cacheRead - 0.05) < 1e-9);
  assert.ok(Math.abs(long.cacheWrite - (0.625 + 1)) < 1e-9);
});

test("haiku 5.5 base tier at exactly the threshold and below it", () => {
  // Exactly 100K prompt tokens is not "over 100,000".
  const atThreshold = Pricing.cost(tokens({ input: 100_000, output: 1_000_000 }), "claude-haiku-5-5");
  assert.ok(atThreshold);
  assert.ok(Math.abs(atThreshold.input - 0.01) < 1e-9);
  assert.equal(atThreshold.output, 0.5);

  const below = Pricing.cost(tokens({ input: 50_000, output: 1_000_000, cacheRead: 40_000 }), "claude-haiku-5-5");
  assert.ok(below);
  assert.ok(Math.abs(below.input - 0.005) < 1e-9);
  assert.ok(Math.abs(below.cacheRead - 0.0004) < 1e-9);
  assert.equal(below.output, 0.5);
});

test("display names resolve longest model prefix", () => {
  assert.equal(Pricing.displayName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(Pricing.displayName("claude-opus-5"), "Opus 5");
  assert.equal(Pricing.displayName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(Pricing.displayName("claude-haiku-5-5-20261001"), "Haiku 5.5");
  assert.equal(Pricing.displayName("us.anthropic.claude-sonnet-5[1m]"), "Sonnet 5");
  assert.equal(Pricing.displayName("us.anthropic.claude-sonnet-5-5[1m]"), "Sonnet 5.5");
  assert.equal(Pricing.displayName("claude-sonnet-5-5@2026-01-01"), "Sonnet 5.5");
  assert.equal(Pricing.displayName("gpt-unknown"), "gpt-unknown");
  assert.equal(Pricing.pricedModel("gpt-unknown"), undefined);
});

test("unknown model is unpriced and web searches add a flat fee", () => {
  assert.equal(Pricing.cost(tokens({ input: 1_000_000 }), "gpt-unknown"), undefined);

  const cost = Pricing.cost(tokens({ webSearches: 3 }), "claude-haiku-4-5");
  assert.ok(cost);
  assert.ok(Math.abs(cost.webSearch - 0.03) < 1e-12);
});

test("non-fast models ignore the fast flag", () => {
  const normal = Pricing.cost(tokens({ input: 1_000_000 }), "claude-haiku-4-5", false);
  const flagged = Pricing.cost(tokens({ input: 1_000_000 }), "claude-haiku-4-5", true);
  assert.ok(normal && flagged);
  assert.equal(normal.input, flagged.input);
});
