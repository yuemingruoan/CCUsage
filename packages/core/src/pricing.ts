// Port of legacy/swift/Sources/CCUsageCore/Pricing.swift.
//
// Prices are Anthropic API list prices in USD per million tokens. Kept as a literal
// translation so cost numbers match the Swift app exactly.

import type { CostBreakdown, TokenCounts } from "./types.js";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Multiplier applied to every component when the usage speed is "fast"; absent if unpriced. */
  fastMultiplier?: number;
}

export interface PricedModel {
  prefix: string;
  displayName: string;
  price: ModelPrice;
  /** Higher rates for requests whose prompt (input + cache tokens) exceeds longPromptThreshold. */
  longPrompt?: ModelPrice;
  longPromptThreshold: number;
}

/** Port of Swift ModelPrice.init(input:output:cacheRead:fastMultiplier:). */
function makePrice(input: number, output: number, cacheRead: number, fastMultiplier?: number): ModelPrice {
  const price: ModelPrice = {
    input,
    output,
    cacheRead,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2
  };
  if (fastMultiplier !== undefined) price.fastMultiplier = fastMultiplier;
  return price;
}

function model(
  prefix: string,
  displayName: string,
  price: ModelPrice,
  longPrompt?: ModelPrice,
  longPromptThreshold = 100_000
): PricedModel {
  const priced: PricedModel = { prefix, displayName, price, longPromptThreshold };
  if (longPrompt !== undefined) priced.longPrompt = longPrompt;
  return priced;
}

/**
 * Swift sorts `models` by descending prefix length so that `first { hasPrefix }` picks the
 * longest match (e.g. claude-opus-5-5 before claude-opus-5). Prefixes of equal length cannot
 * be prefixes of each other, so the order within a length group never matters.
 */
const MODELS: PricedModel[] = [
  model("claude-fable-5-1", "Fable 5.1", makePrice(10, 50, 0.25)),
  model("claude-mythos-5-1", "Mythos 5.1", makePrice(10, 50, 0.25)),
  model("claude-fable-5", "Fable 5", makePrice(10, 50, 1)),
  model("claude-mythos-5", "Mythos 5", makePrice(10, 50, 1)),
  model("claude-opus-5-5", "Opus 5.5", makePrice(4, 20, 0.2, 2)),
  model("claude-opus-5", "Opus 5", makePrice(5, 25, 0.5, 2)),
  model("claude-opus-4-8", "Opus 4.8", makePrice(5, 25, 0.5)),
  model("claude-opus-4-7", "Opus 4.7", makePrice(5, 25, 0.5)),
  model("claude-opus-4-6", "Opus 4.6", makePrice(5, 25, 0.5)),
  model("claude-opus-4-5", "Opus 4.5", makePrice(5, 25, 0.5)),
  model("claude-opus-4-1", "Opus 4.1", makePrice(15, 75, 1.5)),
  model("claude-opus-4", "Opus 4", makePrice(15, 75, 1.5)),
  model("claude-sonnet-5-5", "Sonnet 5.5", makePrice(2, 10, 0.2)),
  model("claude-sonnet-5", "Sonnet 5", makePrice(2, 10, 0.2)),
  model("claude-sonnet-4-6", "Sonnet 4.6", makePrice(3, 15, 0.3)),
  model("claude-sonnet-4-5", "Sonnet 4.5", makePrice(3, 15, 0.3)),
  model("claude-sonnet-4", "Sonnet 4", makePrice(3, 15, 0.3)),
  model("claude-3-7-sonnet", "Sonnet 3.7", makePrice(3, 15, 0.3)),
  model(
    "claude-haiku-5-5",
    "Haiku 5.5",
    makePrice(0.1, 0.5, 0.01),
    makePrice(0.5, 2.5, 0.05)
  ),
  model("claude-haiku-4-5", "Haiku 4.5", makePrice(1, 5, 0.1)),
  model("claude-3-5-haiku", "Haiku 3.5", makePrice(0.8, 4, 0.08))
].sort((a, b) => b.prefix.length - a.prefix.length);

export const Pricing = {
  /** $10 per 1000 web searches. */
  webSearchPerRequest: 10.0 / 1000,

  /** Matched by longest prefix, so dated IDs like claude-haiku-4-5-20251001 resolve too. */
  models: MODELS,

  /** Strips provider prefixes (`us.anthropic.`) and suffixes (`[1m]`, `@date`) from a model ID. */
  normalize(modelId: string): string {
    let id = modelId;
    const claude = id.indexOf("claude-");
    if (claude >= 0) id = id.slice(claude);
    const bracket = id.indexOf("[");
    if (bracket >= 0) id = id.slice(0, bracket);
    const at = id.indexOf("@");
    if (at >= 0) id = id.slice(0, at);
    return id;
  },

  pricedModel(modelId: string): PricedModel | undefined {
    const id = Pricing.normalize(modelId);
    return Pricing.models.find((priced) => id.startsWith(priced.prefix));
  },

  displayName(modelId: string): string {
    return Pricing.pricedModel(modelId)?.displayName ?? modelId;
  },

  /**
   * API-equivalent cost of one request, or undefined when the model has no price entry
   * (the entry stays in the snapshot as an unpriced zero-cost request).
   */
  cost(tokens: TokenCounts, modelId: string, isFast = false): CostBreakdown | undefined {
    const priced = Pricing.pricedModel(modelId);
    if (!priced) return undefined;
    const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
    // Strictly greater: exactly the threshold uses the base tier (matches Swift).
    const price = (prompt > priced.longPromptThreshold ? priced.longPrompt : undefined) ?? priced.price;
    const multiplier = isFast ? price.fastMultiplier ?? 1 : 1;
    const perToken = multiplier / 1_000_000;
    return {
      input: tokens.input * price.input * perToken,
      output: tokens.output * price.output * perToken,
      cacheRead: tokens.cacheRead * price.cacheRead * perToken,
      cacheWrite:
        (tokens.cacheWrite5m * price.cacheWrite5m + tokens.cacheWrite1h * price.cacheWrite1h) * perToken,
      webSearch: tokens.webSearches * Pricing.webSearchPerRequest
    };
  }
};
