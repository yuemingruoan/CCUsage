# CCUsage

A macOS SwiftUI app that shows the API-equivalent cost of every Claude Code session,
broken down by time bucket, model, and 5-hour usage window. Works for subscription
accounts too: cost is computed from the token counts Claude Code writes to its local
transcripts, priced at Anthropic API list rates.

## Data sources

- `~/.claude/projects/<project>/<session>.jsonl` and
  `<session>/subagents/agent-<id>.jsonl` — every assistant message carries
  `message.usage`. Lines are deduplicated by `message.id:requestId` (Claude Code writes
  one line per content block), and subagent usage is rolled into its parent session.
- `~/.claude.json` — `projects[*].lastCost` / `lastSessionId`, the cost Claude Code
  itself recorded for the last session per project; shown next to the computed value.

Transcript-based cost is a lower bound: Claude Code also makes some background
requests (e.g. title generation) that are not written to transcripts, so its own
`lastCost` can be a few percent higher.

## Subscription windows

- **Mod** (optional, "安装 CC mod" in the app): Claude Code measures the `five_hour` /
  `seven_day` windows (used percentage, reset time) after each turn and raises
  `session.measure`. The app installs a mod at `~/.claude/skills/ccusage/`
  (`ccusage@skills-dir`, loaded by sessions started afterwards) that appends them to
  `~/Library/Application Support/CCUsage/rate-limits.jsonl` and pins them as a status
  line under the prompt. Its source is embedded in
  `Sources/CCUsage/ModInstaller.swift`. Earlier versions hooked a script into
  `statusLine` instead; installing the mod restores the previous `statusLine` command
  (`~/.claude/settings.json` is backed up to `…/CCUsage/backups/` first).
- **Limit messages**: "You've hit your session limit · resets 10:10pm (…)" lines in
  transcripts give exact 100% points and reset times.
- Windows without a reported reset are inferred. The default (a window opens with the
  first request after the previous one ended) matches the reset times Claude Code reported
  in the historical data; a fixed back-to-back mode is available in Settings.
- The 100% amount is an estimate: API-equivalent cost spent in the window ÷ the used
  percentage Claude Code reported, taken from the latest report of the current plan.
  Only the current plan period is used: tier changes in `~/.claude.json` are logged to
  `plan-history.jsonl`, and upgrades/downgrades are also inferred (spending clearly past
  the estimate without hitting the limit, or a fit clearly below it).
- A plan change resets usage early: one session's percentage drops within the same window,
  or the 5-hour reset time jumps ahead before the window ends. Usage before that point is
  left out of the estimate, and a logged tier change is dated at the nearest such reset
  (Claude Code does not always update `profileFetchedAt` when the tier changes).

`CLAUDE_CONFIG_DIR` is honored for the default location, and the directory can be
changed in Settings.

## Build and run

```sh
swift run CCUsage                    # debug run from the terminal
swift run CCUsage --report           # print a per-session table and exit
swift test                           # parser / pricing / window tests
scripts/bundle.sh [output-dir]       # release build wrapped in CCUsage.app
```

Pricing lives in `Sources/CCUsageCore/Pricing.swift`.
