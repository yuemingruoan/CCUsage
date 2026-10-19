// Local quota computation (QuotaSnapshot.build in UsageStore.swift).
//
// The display quota is the server-computed snapshot while multi-device sync is online (it includes
// every device's usage), and the locally computed snapshot otherwise. The local snapshot always
// includes remote observations pulled from the sync server as extra observations, so 5h/7d windows
// still account for other devices when the sync connection is down.
import type { AuthMode, LimitEvent, PlanInfo, QuotaObservation, QuotaSnapshot, UsageEntry, UsageSnapshot, WindowMode } from "@ccusage/core";
import { buildQuotaSnapshot, readPlanInfo, readStatusLineLog } from "@ccusage/core";

export interface QuotaPaths {
  configFile: string;
  statusLineLogPath: string;
  planHistoryPath: string;
}

export function emptyQuotaSnapshot(): QuotaSnapshot {
  return { windows: {}, status: {}, statusLineObservationCount: 0, limitMessageCount: 0 };
}

export class QuotaService {
  private local: QuotaSnapshot = emptyQuotaSnapshot();
  private serverQuota: QuotaSnapshot | undefined;
  private remoteObservations: QuotaObservation[] = [];
  private entries: UsageEntry[] = [];
  private sessionAuth: ReadonlyMap<string, AuthMode> = new Map();
  private limitEvents: LimitEvent[] = [];
  private mode: WindowMode = "firstRequest";
  private lastError: string | undefined;
  private readonly getPaths: () => QuotaPaths;

  constructor(getPaths: () => QuotaPaths) {
    this.getPaths = getPaths;
  }

  setLocalSnapshot(snapshot: UsageSnapshot): void {
    this.entries = snapshot.entries;
    this.limitEvents = snapshot.limitEvents;
    const auth = new Map<string, AuthMode>();
    for (const session of snapshot.sessions) {
      if (session.authMode !== undefined) auth.set(session.id, session.authMode);
    }
    this.sessionAuth = auth;
  }

  setWindowMode(mode: WindowMode): void {
    this.mode = mode;
  }

  /** Observations of other devices pulled from the sync server (offline fallback). */
  setRemoteObservations(observations: QuotaObservation[]): void {
    this.remoteObservations = observations;
  }

  /** Server-computed quota; pass undefined to fall back to the local snapshot. */
  setServerQuota(quota: QuotaSnapshot | undefined): void {
    this.serverQuota = quota;
  }

  displayQuota(): QuotaSnapshot {
    return this.serverQuota ?? this.local;
  }

  usingServerQuota(): boolean {
    return this.serverQuota !== undefined;
  }

  localQuota(): QuotaSnapshot {
    return this.local;
  }

  error(): string | undefined {
    return this.lastError;
  }

  /** Recompute the local quota; returns the quota that should be displayed. */
  recompute(): QuotaSnapshot {
    try {
      const paths = this.getPaths();
      this.local = buildQuotaSnapshot({
        entries: this.entries,
        limitEvents: this.limitEvents,
        mode: this.mode,
        configFile: paths.configFile,
        statusLineLogPath: paths.statusLineLogPath,
        planHistoryPath: paths.planHistoryPath,
        extraObservations: this.remoteObservations,
        costBasis: "all",
        ...(this.sessionAuth.size > 0 ? { sessionAuth: this.sessionAuth } : {}),
      });
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("[quota] failed to build local snapshot", error);
    }
    return this.displayQuota();
  }

  /** Observations the mod wrote to the legacy rate-limits.jsonl (also forwarded to the sync server). */
  localObservations(): QuotaObservation[] {
    try {
      return readStatusLineLog(this.getPaths().statusLineLogPath);
    } catch (error) {
      console.error("[quota] failed to read status line log", error);
      return [];
    }
  }

  /** Plan Claude Code last fetched (for sync ingest / settings display). */
  plan(): PlanInfo | undefined {
    try {
      return readPlanInfo(this.getPaths().configFile);
    } catch {
      return undefined;
    }
  }
}
