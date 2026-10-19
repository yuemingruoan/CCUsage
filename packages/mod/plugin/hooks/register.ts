import type { EngineInterface, Register, SessionCost, SessionRateLimit } from 'claude-code'

// CCUsage mod (v0.2): reports the subscription rate-limit windows Claude Code
// measures to the CCUsage desktop app over a local socket, with a file log as
// fallback. The app controls how often we poll and can ask for an immediate
// report; the mod never makes network requests except to the local app.

const LOG_DIRECTORY = 'Library/Application Support/CCUsage'
const APPEND = 'mkdir -p "$1" && printf \'%s\\n\' "$2" >> "$1/rate-limits.jsonl"'
/** An unchanged reading is written to the fallback log again once it is this old. */
export const REPEAT_AFTER_MS = 300_000
/** How often the timer wakes to look for app requests. */
export const TICK_MS = 2_000
export const DEFAULT_POLL_MS = 60_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Usage = { rateLimits: readonly SessionRateLimit[]; cost?: SessionCost; entrypoint?: string }

export type BridgeConfig = {
  version?: number
  socketPath?: string
  url?: string
  token: string
  pollMs?: number
  refreshId?: number
  appVersion?: string
}

export type BridgeReading = {
  sessionId: string
  entrypoint?: string
  rateLimits: Array<{ kind: string; percentUsed: number; resetsAt?: number }>
  cost?: { usd: number }
  changed?: boolean
  at: number
}

export type BridgeReply = { ok?: boolean; pollMs?: number; reportNow?: boolean; refreshId?: number }

export type BridgeCandidate = { home?: string; appdata?: string; xdg?: string }

/** Where the app may have written bridge.json, in probe order. */
export function bridgeCandidatePaths(paths: BridgeCandidate): string[] {
  const out: string[] = []
  const join = (base: string, rest: string) => base.replace(/[\\/]+$/, '') + '/' + rest
  if (paths.home) {
    out.push(join(paths.home, 'Library/Application Support/CCUsage/bridge.json'))
  }
  if (paths.appdata) {
    out.push(join(paths.appdata, 'CCUsage/bridge.json'))
  }
  if (paths.xdg) {
    out.push(join(paths.xdg, 'CCUsage/bridge.json'))
  }
  if (paths.home) {
    out.push(join(paths.home, '.config/CCUsage/bridge.json'))
  }
  return out
}

const findLimit = (usage: Usage, kind: string) => usage.rateLimits.find(limit => limit.kind === kind)

const toEpoch = (value: string | number | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The wire payload the app's bridge expects. */
export function buildReading(sessionId: string, usage: Usage, at: number): BridgeReading {
  return {
    sessionId,
    entrypoint: usage.entrypoint,
    rateLimits: usage.rateLimits.map(limit => ({
      kind: limit.kind,
      percentUsed: limit.percentUsed,
      resetsAt: toEpoch(limit.resetsAt),
    })),
    cost: usage.cost === undefined ? undefined : { usd: usage.cost.usd },
    at,
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

const labelOf = (name: string, limit: SessionRateLimit | undefined, hasWeekday: boolean) => {
  if (limit === undefined) return undefined
  const label = name + ' ' + Math.floor(limit.percentUsed) + '%'
  if (limit.resetsAt === undefined) return label
  const reset = new Date(limit.resetsAt)
  const time = pad(reset.getHours()) + ':' + pad(reset.getMinutes())
  return label + ' ↻' + (hasWeekday ? WEEKDAYS[reset.getDay()] + ' ' : '') + time
}

/** The status line Claude Code pins under the prompt. */
export function statusText(usage: Usage): string | undefined {
  const windows = [
    labelOf('5h', findLimit(usage, 'five_hour'), false),
    labelOf('7d', findLimit(usage, 'seven_day'), true),
  ].filter(label => label !== undefined) as string[]
  if (windows.length === 0) return undefined
  const cost = usage.cost === undefined ? [] : ['$' + usage.cost.usd.toFixed(2)]
  return [...windows, ...cost].join(' · ')
}

export type ReportState = {
  lastPushAt: number
  lastRefreshId: number
  lastRateLimits: string
  lastJsonlAt: number
  lastJsonlReading: string
  pollMs: number
}

export function initialReportState(): ReportState {
  return { lastPushAt: 0, lastRefreshId: -1, lastRateLimits: '', lastJsonlAt: 0, lastJsonlReading: '', pollMs: DEFAULT_POLL_MS }
}

/** Whether the app should be told about this reading now. */
export function shouldReport(state: ReportState, config: BridgeConfig, reading: BridgeReading, now: number): boolean {
  const refreshId = config.refreshId ?? 0
  if (state.lastPushAt === 0) return true
  if (refreshId !== state.lastRefreshId) return true
  const rates = JSON.stringify(reading.rateLimits)
  if (rates !== state.lastRateLimits) return true
  const pollMs = Math.max(config.pollMs ?? state.pollMs ?? DEFAULT_POLL_MS, 250)
  return now - state.lastPushAt >= pollMs
}

const windowOf = (limit: SessionRateLimit | undefined) =>
  limit && {
    used_percentage: limit.percentUsed,
    resets_at: toEpoch(limit.resetsAt) === undefined ? undefined : Math.floor((toEpoch(limit.resetsAt) as number) / 1000),
  }

/** The legacy JSONL line the app also reads when the bridge is not up. */
export function jsonlRecord(sessionId: string, usage: Usage, now: number): string | undefined {
  const fiveHour = windowOf(findLimit(usage, 'five_hour'))
  const sevenDay = windowOf(findLimit(usage, 'seven_day'))
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  return JSON.stringify({ ts: Math.floor(now / 1000), session_id: sessionId, five_hour: fiveHour, seven_day: sevenDay })
}

export function shouldWriteJsonl(state: ReportState, record: string | undefined, now: number): boolean {
  if (record === undefined) return false
  if (record !== state.lastJsonlReading) return true
  return now - state.lastJsonlAt >= REPEAT_AFTER_MS
}

async function readBridge($: EngineInterface): Promise<{ config: BridgeConfig; path: string } | undefined> {
  const home = await $.env.get('HOME')
  const appdata = await $.env.get('APPDATA')
  const xdg = await $.env.get('XDG_CONFIG_HOME')
  for (const path of bridgeCandidatePaths({ home, appdata, xdg })) {
    try {
      const text = await $.fs.read(path)
      const config = JSON.parse(text) as BridgeConfig
      if (config === null || typeof config !== 'object') continue
      if (typeof config.token !== 'string') continue
      if (typeof config.socketPath !== 'string' && typeof config.url !== 'string') continue
      return { config, path }
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

async function postReading($: EngineInterface, config: BridgeConfig, reading: BridgeReading): Promise<BridgeReply | undefined> {
  const url = typeof config.socketPath === 'string'
    ? 'http://ccusage.local/report'
    : (config.url as string).replace(/\/+$/, '') + '/report'
  const response = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccusage-token': config.token },
    body: JSON.stringify(reading),
    ...(typeof config.socketPath === 'string' ? { socketPath: config.socketPath } : {}),
  })
  if (!response.ok) return undefined
  try {
    return JSON.parse(response.text) as BridgeReply
  } catch {
    return { ok: true }
  }
}

async function writeJsonl($: EngineInterface, record: string): Promise<void> {
  const home = await $.env.get('HOME')
  if (home === undefined) return
  try {
    await $.process.run(['/bin/sh', '-c', APPEND, 'sh', home + '/' + LOG_DIRECTORY, record])
  } catch {
    // non-POSIX hosts: the bridge is the only path
  }
}

// Per-load state; a reload starts it over. Kept at the top level because the
// engine only lets `$` flow into functions declared at the top of the module.
let timer: { cancel?: () => void } | undefined
let state = initialReportState()
let busy = false
let sessionId: string | undefined

async function push($: EngineInterface, usage: Usage, now: number, changed: boolean): Promise<void> {
  const bridge = await readBridge($)
  if (bridge === undefined) {
    const record = jsonlRecord(sessionId ?? 'unknown', usage, now)
    if (shouldWriteJsonl(state, record, now) && record !== undefined) {
      await writeJsonl($, record)
      state.lastJsonlAt = now
      state.lastJsonlReading = record
    }
    return
  }
  const id = sessionId ?? (await $.session.id())
  sessionId = id
  const reading = buildReading(id, usage, now)
  reading.changed = changed
  if (reading.rateLimits.length === 0) return
  const reply = await postReading($, bridge.config, reading)
  if (reply === undefined) {
    const record = jsonlRecord(id, usage, now)
    if (shouldWriteJsonl(state, record, now) && record !== undefined) {
      await writeJsonl($, record)
      state.lastJsonlAt = now
      state.lastJsonlReading = record
    }
    return
  }
  state.lastPushAt = now
  state.lastRefreshId = bridge.config.refreshId ?? 0
  state.lastRateLimits = JSON.stringify(reading.rateLimits)
  if (typeof reply.pollMs === 'number' && reply.pollMs > 0) state.pollMs = reply.pollMs
  if (reply.reportNow === true) {
    // The app asked for a fresh reading; answer once more on the next tick.
    state.lastPushAt = 0
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (busy) return
  busy = true
  try {
    const now = await $.clock.now()
    const bridge = await readBridge($)
    if (bridge === undefined) return
    const usage = (await $.session.usage()) as Usage
    const id = sessionId ?? (await $.session.id())
    sessionId = id
    const reading = buildReading(id, usage, now)
    state.pollMs = bridge.config.pollMs ?? state.pollMs
    if (!shouldReport(state, bridge.config, reading, now)) return
    await push($, usage, now, false)
  } catch {
    // never break the session
  } finally {
    busy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionId = await $.session.id()
    const usage = (await $.session.usage()) as Usage
    $.ui.status(statusText(usage))
    await push($, usage, await $.clock.now(), true)
    timer?.cancel?.()
    timer = $.clock.every(TICK_MS, () => tick($))
    return started
  })

  on('session.measure', async ($, e, next) => {
    const usage = e as unknown as Usage
    $.ui.status(statusText(usage))
    await push($, usage, await $.clock.now(), true)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel?.()
    timer = undefined
    return next(e)
  })
}
