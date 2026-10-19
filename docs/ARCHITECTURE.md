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

Devices also report per-session metadata (title/project/cwd/start/end/authMode) on ingest; the
server aggregates each peer session's requests/tokens/cost and returns it on pull, so the UI can
show other devices' sessions with their real titles instead of synthesized labels.

### Quota attribution: Claude models vs third-party models

Earlier attempts inferred the auth path from transcript evidence (1h vs 5m prompt cache, request-id
shape, model name). Real multi-device data showed this is wrong for quota attribution: a relay or
shared login can serve the user's own subscription while the client still writes 5m cache, so its
Claude-model usage does consume the subscription quota. Correlating CC-reported weekly percentages
with per-device cost confirmed relay-heavy hours moved the percentage even with almost no local
usage.

The attribution rule is now model-family based:

- Claude models (claude-*) -> subscription; they count toward 5h/7d quota and the cost estimate,
  regardless of whether the request went direct, through a relay, or via an API-key-looking path;
- non-Claude models (deepseek/kimi/glm/grok/gpt/...) -> third-party; they never consume the Claude
  quota and are usually unpriced;
- a session mixing both -> mixed.

Quota cost basis defaults to "all" (everything synced), with costBasis: "subscription" available
for a strict Claude-only view. The mod auth fingerprint (BridgeAuthFingerprint: credential /
baseUrlHost) is recorded for diagnostics only; it does not override attribution, because a custom
BASE_URL does not prove which account the upstream request billed.

## Repository / process

- Branch `main`. Commit message style: `feat:` / `fix:` / `test:` / `docs:` / `chore:`.
- `npm install && npm run build && npm test` must pass.
- Demo: `npm run seed && npm run screenshot` renders the UI with fixture data
  (no access to the real `~/.claude` required).
- Live run: `npm start` (real `~/.claude`), `npm run server` for the sync server.
