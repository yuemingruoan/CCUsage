// Subscription vs third-party API classification, derived from transcript evidence.
//
// Claude Code's OAuth/subscription path writes 1-hour prompt cache entries
// (usage.cache_creation.ephemeral_1h_input_tokens), while API-key auth and most third-party
// relays/providers only write 5-minute cache (or none). Anthropic API responses produce ids like
// `msg_…:req_…`, while non-Anthropic providers emit opaque ids (often with an empty request id).
// Model names alone are not enough: resellers serve `claude-*` models too.
//
// Evidence from this machine's real data (Mac subscription vs Windows third-party device):
//   Mac:     97.5% of cache-write tokens are 1h, 89 sessions -> 84 subscription, 1 mixed, 1 API-like
//   Windows: 97.7% of cache-write tokens are 5m, 180 sessions -> 133 third-party, 4 subscription,
//            41 non-Claude-model third-party.
import type { AuthMode, UsageEntry } from "./types.js";

/** Raw signals aggregated over one or more requests. */
export interface AuthSignals {
  requests: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  /** Requests whose model name looks like an Anthropic Claude model. */
  claudeRequests: number;
  /** Requests whose entry id has the Anthropic `msg_…:req_…` shape. */
  anthropicIdRequests: number;
}

/** True for `claude-*` / `claude.*` style model names (including dated snapshots). */
export function isClaudeModel(model: string): boolean {
  return /^claude[-.]/i.test(model);
}

/** True when the entry id looks like Anthropic API message/request ids. */
export function isAnthropicRequestId(id: string): boolean {
  return /^msg_[A-Za-z0-9]+:req_/.test(id);
}

export function authSignals(entries: readonly UsageEntry[]): AuthSignals {
  const signals: AuthSignals = {
    requests: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    claudeRequests: 0,
    anthropicIdRequests: 0,
  };
  for (const entry of entries) {
    signals.requests += 1;
    signals.cacheWrite1h += entry.tokens.cacheWrite1h;
    signals.cacheWrite5m += entry.tokens.cacheWrite5m;
    if (isClaudeModel(entry.model)) signals.claudeRequests += 1;
    if (isAnthropicRequestId(entry.id)) signals.anthropicIdRequests += 1;
  }
  return signals;
}

/**
 * Classify a batch of requests:
 * - 1h cache dominated -> subscription (OAuth);
 * - 5m cache dominated -> third-party API / API key path;
 * - non-Claude models only -> third-party;
 * - both cache kinds materially present -> mixed;
 * - no cache signal -> unknown (still treated as subscription usage).
 */
export function classifyAuthSignals(signals: AuthSignals): AuthMode {
  if (signals.requests === 0) return "unknown";
  const cacheTotal = signals.cacheWrite1h + signals.cacheWrite5m;
  if (cacheTotal > 0) {
    const fiveMinuteRatio = signals.cacheWrite5m / cacheTotal;
    if (fiveMinuteRatio >= 0.75) return "thirdParty";
    if (fiveMinuteRatio <= 0.05) return "subscription";
    return "mixed";
  }
  if (signals.claudeRequests === 0) return "thirdParty";
  return "unknown";
}

export function classifySessionAuth(entries: readonly UsageEntry[]): AuthMode {
  return classifyAuthSignals(authSignals(entries));
}

/** Best-effort classification for a single request (used inside mixed sessions). */
export function classifyEntryAuth(entry: UsageEntry): AuthMode {
  if (!isClaudeModel(entry.model)) return "thirdParty";
  const oneHour = entry.tokens.cacheWrite1h;
  const fiveMinute = entry.tokens.cacheWrite5m;
  if (oneHour > 0 && fiveMinute === 0) return "subscription";
  if (fiveMinute > 0 && oneHour === 0) return "thirdParty";
  return "unknown";
}

/**
 * Entries that count toward the subscription quota windows: keep subscription and unknown
 * sessions; for mixed sessions drop only the entries that look third-party. Third-party
 * sessions are excluded entirely (their usage does not consume the 5h/7d subscription limits).
 */
export function filterSubscriptionEntries(
  entries: readonly UsageEntry[],
  /** Authoritative per-session verdicts (e.g. reported by the mod); heuristic applies otherwise. */
  sessionAuth?: ReadonlyMap<string, AuthMode>,
): UsageEntry[] {
  const bySession = new Map<string, UsageEntry[]>();
  for (const entry of entries) {
    const group = bySession.get(entry.sessionId);
    if (group === undefined) bySession.set(entry.sessionId, [entry]);
    else group.push(entry);
  }
  const kept = new Set<UsageEntry>();
  for (const sessionEntries of bySession.values()) {
    const override = sessionAuth?.get(sessionEntries[0]?.sessionId ?? "");
    const mode = override ?? classifySessionAuth(sessionEntries);
    if (mode === "subscription" || mode === "unknown") {
      for (const entry of sessionEntries) kept.add(entry);
    } else if (mode === "mixed") {
      for (const entry of sessionEntries) {
        if (classifyEntryAuth(entry) !== "thirdParty") kept.add(entry);
      }
    }
  }
  return entries.filter((entry) => kept.has(entry));
}