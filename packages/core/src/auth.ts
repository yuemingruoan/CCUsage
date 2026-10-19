// Quota-attribution classification for usage entries.
//
// Earlier versions tried to infer the *auth path* from cache TTL (subscription OAuth writes 1h
// prompt cache, API-key paths usually 5m) and request-id shape. Real data showed that signal is
// not safe for quota attribution: a relay/reverse-proxy can serve the user's own subscription while
// the client still writes 5m cache, so its Claude-model usage **does** consume the subscription
// quota even though it looks like an API-key path. CC-reported weekly percentages confirmed this
// (relay-heavy hours with almost no local Mac usage still moved the percentage).
//
// The rule is therefore simple and defensible:
//   - Claude models  -> subscription (they consume the Claude subscription quota, regardless of
//     whether the request went direct, through a relay, or via a shared login);
//   - non-Claude models (deepseek/kimi/glm/grok/gpt/...) -> third-party, they never consume the
//     Claude quota (cost is usually unknown / unpriced);
//   - a session mixing both -> mixed.
//
// The mod's auth fingerprint (BridgeAuthFingerprint) is kept for diagnostics only; it must not
// override this attribution, because a custom BASE_URL does not prove the upstream account.
import type { AuthMode, UsageEntry } from "./types.js";

/** True for `claude-*` / `claude.*` style model names (including dated snapshots). */
export function isClaudeModel(model: string): boolean {
  return /^claude[-.]/i.test(model);
}

/** True when the entry id looks like Anthropic API message/request ids (diagnostics only). */
export function isAnthropicRequestId(id: string): boolean {
  return /^msg_[A-Za-z0-9]+:req_/.test(id);
}

/** Does this request consume Claude subscription quota? */
export function classifyEntryAuth(entry: UsageEntry): AuthMode {
  return isClaudeModel(entry.model) ? "subscription" : "thirdParty";
}

/** Quota attribution for a session: all-Claude = subscription, none = third-party, mixed otherwise. */
export function classifySessionAuth(entries: readonly UsageEntry[]): AuthMode {
  if (entries.length === 0) return "unknown";
  let claude = 0;
  for (const entry of entries) if (isClaudeModel(entry.model)) claude += 1;
  if (claude === entries.length) return "subscription";
  if (claude === 0) return "thirdParty";
  return "mixed";
}

/**
 * Entries that count toward the subscription quota: all of them in the default "all" cost basis.
 * The optional filter (costBasis: "subscription") keeps Claude-model usage from subscription and
 * unknown sessions, and only the Claude-model entries of a mixed session.
 */
export function filterSubscriptionEntries(
  entries: readonly UsageEntry[],
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
        if (classifyEntryAuth(entry) === "subscription") kept.add(entry);
      }
    }
  }
  return entries.filter((entry) => kept.has(entry));
}
