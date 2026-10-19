# CCUsage 2.0 — Contracts

Everyone codes against this file (read ARCHITECTURE.md and UI-STYLE.md first). If something
must change, message **lead**; lead owns this file, packages/core/src/types.ts, root configs,
git and scripts/.

## Ownership / write scopes

| Scope | Owner |
|---|---|
| packages/core/** (except types.ts, mod-source.generated.ts) | core-port |
| services/server/** | server-sync |
| apps/desktop/src/main/**, src/preload/**, apps/desktop/build.mjs, apps/desktop/assets/** | app-shell |
| apps/desktop/src/renderer/** | renderer-ui |
| packages/mod/**, scripts/**, docs/**, root files, demo-data/** | lead |
| packages/core/src/types.ts | lead (read-only; request additions) |

Rules: no git commands, no npm install (lead preinstalled everything), never touch another
owner’s scope, server tests must listen on port 0. Report to lead via send_message.

## Build / test (repo root)

    npm run build:core      # tsc packages/core -> packages/core/dist
    npm run build:server    # tsc services/server -> services/server/dist
    npm run build:desktop   # esbuild -> apps/desktop/dist
    node --import tsx --test packages/core/test/*.test.ts
    node --import tsx --test services/server/test/*.test.ts
    node --import tsx --test packages/mod/test/*.test.ts

@ccusage/core resolves through the npm workspace symlink; build:core before other builds/tests.

## @ccusage/core public API (src/index.ts)

All timestamps are epoch milliseconds, JSON-safe; ESM exports.

### types
    export * from "./types.js";   // see packages/core/src/types.ts

### pricing (port of legacy Pricing.swift)
    export interface ModelPrice { input; output; cacheRead; cacheWrite5m; cacheWrite1h; fastMultiplier? }
    export interface PricedModel { prefix; displayName; price; longPrompt?; longPromptThreshold }
    export const Pricing: { webSearchPerRequest; models; normalize(m); pricedModel(m); displayName(m); cost(tokens, model, isFast?): CostBreakdown | undefined }
Rules: cacheWrite5m = input*1.25, cacheWrite1h = input*2; long prompt (>100k prompt tokens) uses
longPrompt when present; unknown model -> undefined (unpriced entry, zero cost).

### parser / scanner / snapshot
    export function parseTranscript(path: string, projectsRoot: string): ParsedTranscript
    export function parseTranscriptData(data: string | Uint8Array, filePath: string, projectsRoot: string): ParsedTranscript
    export function buildSnapshot(transcripts: ParsedTranscript[], recordedCosts?: Record<string, number>): UsageSnapshot
    export function recordedCosts(configFile: string): Record<string, number>
    export class UsageScanner { constructor(); static defaultClaudeDirectory(); static defaultProjectsDirectory(); scan(projectsRoot, configFile?): Promise<UsageSnapshot>; clearCache() }
Behavioral parity with legacy Swift (verified by npm run parity against legacy/reference-report.txt):
- projectDirectory = first path component under projectsRoot; subagent iff parent dir is "subagents".
- within-file dedupe key message.id:requestId, later line with larger output wins; global dedupe in
  buildSnapshot over path-sorted transcripts, first occurrence wins.
- user/meta/summary/custom-title/agent-name/limit-message handling identical to TranscriptParser.swift.
- assistant needs message.usage + model != "<synthetic>" + ISO timestamp; split cache writes 5m/1h as Swift.
- scanner caches (path,size,mtime) and reparses only changed files.

### aggregation (Aggregation.swift)
    export type TimeGranularity = "fiveMinutes" | "fifteenMinutes" | "hour" | "day" | "week"
    export const TimeGranularity: { suggestedFor(spanMs); bucketStart(g, ms, tz?); bucketEnd(g, startMs, tz?) }
    export interface UsageBucket { id; start; end; series; tokens; cost; requestCount }
    export function buckets(entries, granularity, seriesOf, tz?): UsageBucket[]
    export interface ModelTotal { name; tokens; cost; requestCount; hasUnpricedRequests }
    export function modelTotals(entries): ModelTotal[]

### quota / plan history (Quota.swift, PlanHistory.swift)
    export function readStatusLineLog(path: string): QuotaObservation[]
    export function limitMessageObservation(event: LimitEvent): QuotaObservation | null
    export function quotaWindows(kind, entries, observations, mode, now?): QuotaWindow[]
    export function quotaEstimate(windows, planChanges?): LimitEstimate | undefined
    export function quotaStatus(kind, windows, entries, planChanges?, now?): QuotaStatus
    export function readPlanInfo(configFile): PlanInfo | undefined
    export function readPlanHistory(logPath): PlanInfo[]
    export function recordPlanInfo(plan, logPath): PlanInfo[]
    export function planChanges(history): PlanChange[]
    export function buildQuotaSnapshot(opts: { entries; limitEvents; mode; configFile; statusLineLogPath; planHistoryPath; extraObservations?; now? }): QuotaSnapshot
    export function buildQuotaSnapshotFromData(opts: { entries; observations; limitEvents?; mode; plan?; planChanges?; now? }): QuotaSnapshot
    export function mergeEntries(local: UsageEntry[], remote: UsageEntry[]): UsageEntry[]   // dedupe by id, local wins, keep deviceId
    export function mergeObservations(local, remote): QuotaObservation[]
Port literally from Swift; keep comments naming the source. Any deviation must be justified by
legacy/reference-report.txt. extraObservations exist so merged cross-device data can feed windows.

### formatting (Formatting.swift)
    export const Format: { usd, tokens, duration, dateTime, bucketLabel, bucketRange, windowStart, windowEnd }
    export const SeriesPalette: { light: string[]; dark: string[]; maxSeries; otherName; color(i) }

### sync client (used by Electron main)
    export class SyncClient {
      constructor(opts: { url: string; token?: string });
      setToken(token?: string): void;
      signup(username, password, device: DeviceInfo): Promise<LoginResponse>;
      login(username, password, device: DeviceInfo): Promise<LoginResponse>;
      ingest(req: SyncIngestRequest): Promise<SyncIngestResponse>;
      pull(since?: number): Promise<SyncPullResponse>;
      state(): Promise<{ account: AccountInfo; devices: DeviceInfo[]; quota: QuotaSnapshot }>;
    }

### mod sources
packages/core/src/mod-source.generated.ts (generated by npm run gen:mod) exports
    export const MOD_PLUGIN_FILES: Record<string, string>
Installer writes these under <claudeDir>/skills/ccusage/ and compares contents for ModState.

## Electron IPC (main <-> renderer)

preload exposes window.ccusage. All methods resolve JSON-safe values; failures reject Error(msg).

    interface CcusageApi {
      getState(): Promise<AppState>;
      onState(cb: (state: AppState) => void): () => void;
      refresh(): Promise<void>;                 // transcript rescan
      bridgeRefresh(): Promise<void>;           // bump refreshId -> mod reports at once
      getSettings(): Promise<AppSettings>;
      updateSettings(patch): Promise<AppSettings>;
      getModState(): Promise<ModState>;
      installMod(): Promise<{ state; error? }>;
      uninstallMod(): Promise<{ state; error? }>;
      getBridgeStatus(): Promise<BridgeStatus>;
      sync: {
        status(): Promise<SyncState>;
        configure(patch: Partial<ServerConfig>): Promise<AppSettings>;
        login(username, password): Promise<{ ok; error? }>;
        register(username, password): Promise<{ ok; error? }>;
        logout(): Promise<void>;
        now(): Promise<{ ok; error? }>;
      };
      openMainWindow(); openSettings(); quit();
    }

Main pushes "app:state:updated" (AppState) on every change. Renderer tolerates the initial
empty state (skeleton).

## Mod bridge protocol (app <-> Claude Code mod)

App main process hosts HTTP over a Unix socket at <appConfigDir>/bridge.sock; on Windows a TCP
loopback port with "url" in bridge.json. <appConfigDir> = CCUSAGE_DEMO_DIR when set, else macOS
~/Library/Application Support/CCUsage, Linux ${XDG_CONFIG_HOME:-~/.config}/CCUsage, Windows %APPDATA%\CCUsage.

bridge.json (atomic write, shape BridgeConfig in types.ts): { version:1, socketPath, url?, token,
pollMs, refreshId, appVersion }.

Endpoints:
- POST /report  header x-ccusage-token, body BridgeReading -> 200 { ok:true, pollMs, reportNow, refreshId }
  401 bad token; app merges reading, appends legacy rate-limits.jsonl line, recomputes quota incl.
  synced devices, forwards to sync server when online.
- GET /status -> BridgeStatus.
- unlink stale socket on start, remove on quit.

Mod behavior (packages/mod/plugin/hooks/register.ts, single self-contained file, no runtime imports):
1) session.start: $.ui.status(...), start $.clock.every(2000, tick).
2) tick: read bridge.json candidates ($HOME/Library/Application Support/CCUsage,
   $XDG_CONFIG_HOME/CCUsage, $HOME/.config/CCUsage, %APPDATA%\CCUsage); if refreshId changed or
   pollMs elapsed or reading changed -> await $.session.usage(), POST /report, apply response
   pollMs; reportNow -> report again immediately. No bridge -> append legacy JSONL via
   $.process.run(["/bin/sh","-c",...]) (skip when no shell).
3) session.measure: report immediately.
4) session.end: cancel timer.
5) status text format exactly: 5h 4% ↻23:40 · 7d 97% ↻Sun 13:00 · $34.63
6) all socket errors swallowed; never break a session.

## Sync server REST API (services/server)

Base /api/v1, auth header Authorization: Bearer <token>. Express 5 + node:sqlite (DatabaseSync);
DB path process.env.CCUSAGE_DB ?? data/ccusage.sqlite; PORT ?? 8787; HOST ?? 127.0.0.1.
Passwords: node:crypto scrypt + salt; tokens: random hex stored sha256.

- GET /health -> { ok:true }
- POST /accounts {username,password} -> 201 {account}; 409 exists; 400 invalid.
- POST /login {username,password,device:{id?,name,platform,appVersion}} -> 200 LoginResponse (upsert device).
- POST /logout {deviceId} -> 204 revoke token.
- POST /ingest (auth) SyncIngestRequest -> SyncIngestResponse. Optional `sessions: SyncSessionMeta[]`
  carries per-session metadata (id/title/projectName/cwd/start/end/authMode) so peers can render real
  titles and the subscription-vs-third-party classification (authMode: subscription | thirdParty |
  mixed | unknown).
  Dedupe entries by id per account, observations by (kind,observed_at,resets_at,device_id); upsert
  device last_seen_at; upsert session metadata.
- GET /sync?since=<seq>&mode=firstRequest (auth) -> SyncPullResponse: entries from OTHER devices with
  seq > since tagged deviceId, `sessions: SyncSessionMeta[]` (peer sessions with real titles and
  server-computed requests/tokens/cost/models), all devices, server quota computed with
  buildQuotaSnapshotFromData over account entries+observations, plan = latest reported.
- GET /state (auth) -> { account, devices, quota, totals:{todayCost,todayRequests,weekCost} }.
- DELETE /devices/:id -> 204.
Bodies JSON objects only, reject >2MB with {error} 400. Tests use createServer(dbPath) factory on port 0.

## Mod auth fingerprint

Every bridge reading may carry `auth: { credential: "managedKey" | "oauthToken" | "authToken" |
"apiKey" | "apiKeyHelper" | "unknown"; baseUrlHost?: string; thirdPartyBase?: boolean }`, read from
the Claude Code process env + merged settings. The app treats it as authoritative over the
transcript heuristic (custom base URL or non-managed-key credentials = thirdParty) and persists it
per session. `"managedKey"` is the `/login` subscription path.

## Mod generation / install

scripts/gen-mod-source.mjs (lead) writes packages/core/src/mod-source.generated.ts from
packages/mod/plugin/**. Electron main mod-installer: install() writes files to
<claudeDir>/skills/ccusage/, removes the legacy statusLine hook from settings.json (backup + restore,
port from legacy/swift/Sources/CCUsage/ModInstaller.swift); state() compares content; uninstall() reverses.

## Settings / paths / env

    appConfigDir()      // CCUSAGE_DEMO_DIR || platform dir above
    settings.json       // AppSettings
    bridge.json         // BridgeConfig
    rate-limits.jsonl   // observation log (app + mod fallback)
    plan-history.jsonl  // plan tier history
Server token and deviceId live in settings.json (deviceId generated once).

## Acceptance (lead runs at the end)

1. npm install && npm run build && npm test green.
2. npm run parity matches legacy/reference-report.txt header (125 files, 48191 requests, 86 sessions
   for the live ~/.claude snapshot).
3. npm run seed && npm run screenshot -> screenshots/main.png + screenshots/tray.png non-empty.
4. Server tests prove multi-device ingest, pull of other device entries, quota includes both devices.
5. npm run seed-server + demo mode app shows 2 devices and server quota badge "含 2 台设备".

## Notes for renderer-ui

Renderer is a single React 19 root (apps/desktop/src/renderer/main.tsx) plus tray.tsx. It receives
AppState via window.ccusage. No external state libs (use useState/useReducer/context). Charts are
hand written SVG. All copy is Chinese; reuse the strings from legacy/swift/Sources/CCUsage/*.swift
(see UI-STYLE.md). New: device table (设备), server settings tab (服务端), sync status badge,
"含 N 台设备" badge on quota cards when serverQuota is used.

## Notes for app-shell

Main process modules: index.ts (app lifecycle, tray, windows), settings.ts, scanner.ts (worker_threads
or async scan of UsageScanner), quota.ts (build local quota), bridge.ts (socket server), mod-installer.ts,
sync.ts (SyncClient polling + merge + forwarding), ipc.ts (channels above), tray.ts. Demo mode:
CCUSAGE_DEMO_DIR sets data dir; skip real ~/.claude. The renderer entry is dist/renderer.js from
src/renderer/main.tsx; tray window loads dist/tray.html + dist/tray.js. Build with esbuild in build.mjs
(main/preload = cjs, platform node, external electron; renderer = iife, platform browser, jsx).
