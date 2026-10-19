// Account-wide aggregation for the sync server: the server recomputes the
// 5h/7d quota over every device's entries and observations so each client can
// show a quota card that already includes the peers' consumption.

import { buildQuotaSnapshotFromData, planChanges as planChangesFromHistory } from "@ccusage/core";
import type {
  PlanChange,
  PlanInfo,
  QuotaObservation,
  QuotaSnapshot,
  UsageEntry,
  WindowMode,
} from "@ccusage/core";
import type { SyncStore, Totals } from "./store.js";

/** How far back entries are loaded for the quota window computation. */
export const QUOTA_ENTRY_LOOKBACK_MS = 90 * 86_400_000;
/** Status-line readings arrive every few seconds; only recent ones matter for windows. */
export const QUOTA_OBSERVATION_LOOKBACK_MS = 14 * 86_400_000;
export const QUOTA_OBSERVATION_LIMIT = 20_000;
/** "weekCost" on the dashboard: rolling 7 days, like the app's "近 7 天" range. */
export const TOTALS_WEEK_MS = 7 * 86_400_000;

export interface QuotaData {
  entries: UsageEntry[];
  observations: QuotaObservation[];
  plan?: PlanInfo;
  planChanges: PlanChange[];
}

/** Loads everything buildQuotaSnapshotFromData needs for one account. */
export function loadQuotaData(store: SyncStore, accountId: string, now: number = Date.now()): QuotaData {
  const entries = store.entriesForQuota(accountId, now - QUOTA_ENTRY_LOOKBACK_MS);
  const observations = store.observationsForQuota(
    accountId,
    now - QUOTA_OBSERVATION_LOOKBACK_MS,
    QUOTA_OBSERVATION_LIMIT
  );
  const plan = store.plan(accountId);
  const history = store.planHistory(accountId);
  return { entries, observations, plan, planChanges: planChangesFromHistory(history) };
}

/**
 * Server-side quota snapshot. The weekly window always rolls on the fixed
 * schedule; only the 5-hour window follows the client's configured mode, which
 * is what QuotaSnapshot.build does in the app (UsageStore.swift).
 */
export function computeQuota(data: QuotaData, mode: WindowMode, now: number = Date.now()): QuotaSnapshot {
  return buildQuotaSnapshotFromData({
    entries: data.entries,
    observations: data.observations,
    limitEvents: [],
    mode,
    plan: data.plan,
    planChanges: data.planChanges,
    now,
  });
}

/** Local midnight of the server's timezone; "today" is a calendar day, not last 24h. */
export function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function loadTotals(store: SyncStore, accountId: string, now: number = Date.now()): Totals {
  return store.totals(accountId, startOfLocalDay(now), now - TOTALS_WEEK_MS);
}
