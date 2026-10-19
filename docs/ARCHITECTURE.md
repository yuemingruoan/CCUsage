# CCUsage 2.0 — Architecture

Cross-platform rewrite (macOS / Windows / Linux) of the original SwiftUI CCUsage app.
The original Swift sources are preserved under `legacy/swift/` and in git history.

## Goals

1. Same product as the Swift app: read Claude Code transcripts, show API-equivalent cost
   per session / model / time bucket, and track the Claude subscription 5-hour and
   weekly windows.
2. **Cross-platform UI**: Web UI running in Electron, styled after the macOS original.
3. **Live quota**: a Claude Code mod (plugin) reports rate limits to the app over a
   local Unix socket. The app controls the mod's polling frequency and can ask it to
   refresh on demand (the app's Refresh button).
4. **Multi-device sync**: one account can be used on several devices. Clients push their
   usage to a self-hosted Express server; the server aggregates and pushes other
   devices' usage back. 5h/7d windows include every device's consumption.
5. Tests, demo data and a screenshot harness; the repository is a git repo.

## Stack

- Node.js 24, TypeScript, npm workspaces.
- Electron for the desktop app (main process = node, renderer = React + custom SVG charts).
- Express 5 + `node:sqlite` for the sync server.
- No native dependencies except Electron itself; charts are hand written SVG.

## Layout

```
package.json                 npm workspaces + scripts
docs/                        architecture, contracts, UI style guide
legacy/swift/                original Swift app (reference; not built)
packages/core/               @ccusage/core — port of CCUsageCore + sync client + mod sources
packages/mod/plugin/         Claude Code plugin (mod) sources, embedded into the app at build
apps/desktop/                @ccusage/desktop — Electron main, preload, React renderer, build script
services/server/             @ccusage/server — Express sync server
scripts/                     demo seeding, screenshots, parity report, mod source generation
demo-data/                   generated fixtures (gitignored), CCUSAGE_DEMO_DIR points here
```

## Data flow

### 1. Local transcripts (port of the Swift logic)

`~/.claude/projects/<project>/<session>.jsonl` (plus `subagents/`) is scanned
incrementally (cache key: path + size + mtime). Lines are deduplicated by
`message.id:requestId` (later line with the larger output count wins within a file;
first occurrence in path-sorted order wins globally). Subagent usage rolls into its
parent session. `~/.claude.json` supplies Claude Code's own `lastCost` per project.
Pricing is Anthropic API list price (`Pricing` in core).

### 2. Mod bridge (live rate limits, app-controlled)

```
Claude Code session (mod)                    CCUsage Electron app (main process)
  $.clock.every(2s) ── reads bridge.json ──▶ http server on unix socket / TCP loopback
  POST /report  {sessionId, rateLimits,…} ──▶ updates latest reading, recomputes quota,
  ◀── {pollMs, reportNow, refreshId}           forwards usage to the sync server
  session.measure ──▶ POST /report immediately
  every accepted reading ──▶ appends ~/…/CCUsage/rate-limits.jsonl (fallback/history)
```

The app writes `bridge.json` (`{socketPath, url?, token, pollMs, refreshId}`).
Refresh button bumps `refreshId`; the mod sees it on its next 2 s tick and reports at
once. App settings control `pollMs` (5 s / 15 s / 60 s / off). When no Claude Code
session is running the app shows the last reported reading and when it was reported.

### 3. Multi-device sync

```
device A app ──ingest(entries, observations, plan)──▶ Express server (SQLite)
device B app ──ingest(...)────────────────────────────▶  ├ dedupe by entry id across devices
                                                          ├ aggregate account usage
                                                          └ compute 5h/7d quota over ALL devices
device A ◀──pull(others' entries, devices, account quota)──┘
```

Devices also report per-session metadata (title/project/cwd/start/end) on ingest; the server
aggregates each peer session's requests/tokens/cost and returns it on pull, so the UI can show
other devices' sessions with their real titles instead of synthesized labels.

Clients keep their own local snapshot for offline use, but when sync is online the
quota cards use the server-computed snapshot (which includes every device) and the
device list / other devices' usage is merged into the views. Remote entries are tagged
with `deviceId` so the UI can attribute usage and show it. The device table is clickable:
its detail page shows that device's per-day usage plus its sessions (title / time range /
requests / cost), so multi-device usage can be inspected by date.

## Repository / process

- Branch `main`. Commit message style: `feat:` / `fix:` / `test:` / `docs:` / `chore:`.
- `npm install && npm run build && npm test` must pass.
- Demo: `npm run seed && npm run screenshot` renders the UI with fixture data
  (no access to the real `~/.claude` required).
- Live run: `npm start` (real `~/.claude`), `npm run server` for the sync server.
