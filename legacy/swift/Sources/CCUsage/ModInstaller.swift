import Foundation

/// Installs the `ccusage` mod into Claude Code so the app receives the `rate_limits`
/// (5-hour / 7-day usage percentage and reset time) Claude Code measures after each turn.
struct ModInstaller {
    enum State: Equatable {
        case notInstalled
        case installed
        /// The installed files differ from the ones this build ships.
        case outdated
        /// The status line script of earlier versions is still hooked into `settings.json`.
        case legacyStatusLine
    }

    let claudeDirectory: URL

    static var supportDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CCUsage")
    }

    static var logURL: URL { supportDirectory.appendingPathComponent("rate-limits.jsonl") }
    static var legacyScriptURL: URL { supportDirectory.appendingPathComponent("statusline.sh") }
    static var chainedCommandURL: URL { supportDirectory.appendingPathComponent("chained-command") }

    var settingsURL: URL { claudeDirectory.appendingPathComponent("settings.json") }

    /// Claude Code loads a plugin folder under `skills/` as `ccusage@skills-dir`.
    var modURL: URL { claudeDirectory.appendingPathComponent("skills/ccusage") }

    func state() -> State {
        if hasLegacyStatusLine((try? readSettings()) ?? nil) { return .legacyStatusLine }
        let installed = Self.files.map { try? String(contentsOf: modURL.appendingPathComponent($0.path), encoding: .utf8) }
        if installed.allSatisfy({ $0 == nil }) { return .notInstalled }
        return installed == Self.files.map(\.content) ? .installed : .outdated
    }

    /// Writes the mod, and unhooks the status line script if an earlier version installed it.
    func install() throws {
        let fileManager = FileManager.default
        for file in Self.files {
            let url = modURL.appendingPathComponent(file.path)
            try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try file.content.write(to: url, atomically: true, encoding: .utf8)
        }
        try removeLegacyStatusLine()
    }

    func uninstall() throws {
        if FileManager.default.fileExists(atPath: modURL.path) {
            try FileManager.default.removeItem(at: modURL)
        }
        try removeLegacyStatusLine()
    }

    private func hasLegacyStatusLine(_ settings: [String: Any]?) -> Bool {
        let command = (settings?["statusLine"] as? [String: Any])?["command"] as? String
        return command?.contains("CCUsage/statusline.sh") == true
    }

    /// Restores the status line command the script was chained to, or removes the entry.
    private func removeLegacyStatusLine() throws {
        guard var settings = try readSettings(), hasLegacyStatusLine(settings) else { return }
        try backupSettings()
        if let previous = try? String(contentsOf: Self.chainedCommandURL, encoding: .utf8), !previous.isEmpty {
            var statusLine = settings["statusLine"] as? [String: Any] ?? ["type": "command"]
            statusLine["command"] = previous
            settings["statusLine"] = statusLine
        } else {
            settings.removeValue(forKey: "statusLine")
        }
        try writeSettings(settings)
        try? FileManager.default.removeItem(at: Self.chainedCommandURL)
        try? FileManager.default.removeItem(at: Self.legacyScriptURL)
    }

    private func readSettings() throws -> [String: Any]? {
        guard FileManager.default.fileExists(atPath: settingsURL.path) else { return nil }
        let data = try Data(contentsOf: settingsURL)
        guard !data.isEmpty else { return [:] }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func writeSettings(_ settings: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: settingsURL, options: .atomic)
    }

    private func backupSettings() throws {
        guard FileManager.default.fileExists(atPath: settingsURL.path) else { return }
        let directory = Self.supportDirectory.appendingPathComponent("backups")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let stamp = Date().formatted(.verbatim("\(year: .defaultDigits)\(month: .twoDigits)\(day: .twoDigits)-\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased))\(minute: .twoDigits)\(second: .twoDigits)", timeZone: .current, calendar: .current))
        try FileManager.default.copyItem(at: settingsURL, to: directory.appendingPathComponent("settings-\(stamp).json"))
    }

    /// The mod's files, relative to `modURL`.
    static let files: [(path: String, content: String)] = [
        (".claude-plugin/plugin.json", manifest),
        ("hooks/hooks.json", hooks),
        ("hooks/register.ts", module),
    ]

    private static let manifest = #"""
    {
      "name": "ccusage",
      "version": "0.1.0",
      "description": "Records the subscription rate-limit windows Claude Code reports for the CCUsage app and shows them under the prompt.",
      "author": { "name": "CCUsage" }
    }

    """#

    private static let hooks = #"""
    { "modules": ["./register.ts"] }

    """#

    private static let module = #"""
    import type { EngineInterface, Register, SessionCost, SessionRateLimit } from 'claude-code'

    // Where the CCUsage app reads the reported windows from, under $HOME.
    const LOG_DIRECTORY = 'Library/Application Support/CCUsage'
    const APPEND = 'mkdir -p "$1" && printf \'%s\\n\' "$2" >> "$1/rate-limits.jsonl"'
    // An unchanged reading is written again once it is this old.
    const REPEAT_AFTER_MS = 300_000
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

    type Usage = { rateLimits: readonly SessionRateLimit[]; cost?: SessionCost }

    let written = ''
    let writtenAt = 0

    const find = (usage: Usage, kind: string) => usage.rateLimits.find(limit => limit.kind === kind)

    // The status line's own spelling of a window, which the app's log reader expects.
    const windowOf = (limit: SessionRateLimit | undefined) =>
      limit && {
        used_percentage: limit.percentUsed,
        resets_at: limit.resetsAt === undefined ? undefined : Math.floor(Date.parse(limit.resetsAt) / 1000),
      }

    const pad = (value: number) => String(value).padStart(2, '0')

    const labelOf = (name: string, limit: SessionRateLimit | undefined, hasWeekday: boolean) => {
      if (limit === undefined) return undefined
      const label = `${name} ${Math.floor(limit.percentUsed)}%`
      if (limit.resetsAt === undefined) return label
      const reset = new Date(limit.resetsAt)
      const time = `${pad(reset.getHours())}:${pad(reset.getMinutes())}`
      return `${label} ↻${hasWeekday ? `${WEEKDAYS[reset.getDay()]} ` : ''}${time}`
    }

    const statusOf = (usage: Usage) => {
      const windows = [
        labelOf('5h', find(usage, 'five_hour'), false),
        labelOf('7d', find(usage, 'seven_day'), true),
      ].filter(label => label !== undefined)
      if (windows.length === 0) return undefined
      const cost = usage.cost === undefined ? [] : [`$${usage.cost.usd.toFixed(2)}`]
      return [...windows, ...cost].join(' · ')
    }

    async function report($: EngineInterface, usage: Usage) {
      $.ui.status(statusOf(usage))

      const five_hour = windowOf(find(usage, 'five_hour'))
      const seven_day = windowOf(find(usage, 'seven_day'))
      if (five_hour === undefined && seven_day === undefined) return

      const reading = JSON.stringify([five_hour, seven_day])
      const now = await $.clock.now()
      if (reading === written && now - writtenAt < REPEAT_AFTER_MS) return

      const home = await $.env.get('HOME')
      if (home === undefined) return
      const record = JSON.stringify({
        ts: Math.floor(now / 1000),
        session_id: await $.session.id(),
        five_hour,
        seven_day,
      })
      const { exitCode } = await $.process.run(['/bin/sh', '-c', APPEND, 'sh', `${home}/${LOG_DIRECTORY}`, record])
      if (exitCode === 0) {
        written = reading
        writtenAt = now
      }
    }

    export const register: Register = on => {
      on('session.start', async ($, e, next) => {
        const started = await next(e)
        await report($, await $.session.usage())

        return started
      })

      on('session.measure', async ($, e, next) => {
        await report($, e)

        return next(e)
      })
    }

    """#
}
