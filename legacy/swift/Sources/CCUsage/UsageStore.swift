import CCUsageCore
import Foundation
import Observation

enum DateRange: String, CaseIterable, Identifiable {
    case today, week, month, all

    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: "今天"
        case .week: "近 7 天"
        case .month: "近 30 天"
        case .all: "全部"
        }
    }

    func start(now: Date, calendar: Calendar = .current) -> Date? {
        let today = calendar.startOfDay(for: now)
        switch self {
        case .today: return today
        case .week: return calendar.date(byAdding: .day, value: -6, to: today)
        case .month: return calendar.date(byAdding: .day, value: -29, to: today)
        case .all: return nil
        }
    }
}

enum ChartMetric: String, CaseIterable, Identifiable {
    case cost, tokens

    var id: String { rawValue }
    var label: String { self == .cost ? "折算金额" : "Tokens" }

    func value(_ bucket: UsageBucket) -> Double {
        self == .cost ? bucket.cost : Double(bucket.tokens.total)
    }

    func format(_ value: Double) -> String {
        self == .cost ? Format.usd(value) : Format.tokens(Int(value))
    }
}

/// Subscription windows and their current status, derived from usage plus what
/// Claude Code reported (status line log and limit messages).
struct QuotaSnapshot: Sendable {
    var windows: [QuotaKind: [QuotaWindow]] = [:]
    var status: [QuotaKind: QuotaStatus] = [:]
    var statusLineObservationCount = 0
    var limitMessageCount = 0
    var plan: PlanInfo?

    static var planLogURL: URL { ModInstaller.supportDirectory.appendingPathComponent("plan-history.jsonl") }

    static func build(
        entries: [UsageEntry], limitEvents: [LimitEvent], mode: WindowMode,
        configFile: URL, now: Date = Date()
    ) -> QuotaSnapshot {
        let statusLine = StatusLineLog.read(ModInstaller.logURL)
        let messages = limitEvents.compactMap(LimitMessageParser.observation(from:))
        let observations = statusLine + messages
        let history = PlanHistory.record(PlanInfo.read(configFile: configFile), in: planLogURL)
        let planChanges = PlanHistory.changes(in: history)

        var snapshot = QuotaSnapshot(statusLineObservationCount: statusLine.count, limitMessageCount: messages.count, plan: history.last)
        for kind in QuotaKind.allCases {
            // Weekly limits reset on a fixed schedule; the 5-hour mode is configurable.
            let windows = QuotaCalculator.windows(
                kind: kind, entries: entries, observations: observations,
                mode: kind == .sevenDay ? .fixedRolling : mode, now: now
            )
            snapshot.windows[kind] = windows
            snapshot.status[kind] = QuotaCalculator.status(kind: kind, windows: windows, entries: entries, planChanges: planChanges, now: now)
        }
        return snapshot
    }
}

@MainActor
@Observable
final class UsageStore {
    private(set) var snapshot = UsageSnapshot.empty
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var lastError: String?
    private(set) var lastScanDuration: Duration = .zero
    /// Model display names ordered by all-time cost; drives stable series colors.
    private(set) var modelOrder: [String] = []
    private(set) var quota = QuotaSnapshot()
    private(set) var modState: ModInstaller.State = .notInstalled

    var projectsPath: String {
        didSet {
            UserDefaults.standard.set(projectsPath, forKey: Keys.projectsPath)
            Task { await refresh() }
        }
    }

    var refreshInterval: Int {
        didSet {
            UserDefaults.standard.set(refreshInterval, forKey: Keys.refreshInterval)
            startAutoRefresh()
        }
    }

    var windowMode: WindowMode {
        didSet {
            UserDefaults.standard.set(windowMode.rawValue, forKey: Keys.windowMode)
            Task { await recomputeQuota() }
        }
    }

    private let scanner = UsageScanner()
    private var autoRefreshTask: Task<Void, Never>?

    private enum Keys {
        static let projectsPath = "projectsPath"
        static let refreshInterval = "refreshInterval"
        static let windowMode = "windowMode"
    }

    init() {
        let defaults = UserDefaults.standard
        projectsPath = defaults.string(forKey: Keys.projectsPath) ?? UsageScanner.defaultProjectsDirectory.path
        let interval = defaults.integer(forKey: Keys.refreshInterval)
        refreshInterval = interval > 0 ? interval : 60
        windowMode = defaults.string(forKey: Keys.windowMode).flatMap(WindowMode.init(rawValue:)) ?? .firstRequest
        startAutoRefresh()
    }

    var projectsURL: URL {
        URL(fileURLWithPath: (projectsPath as NSString).expandingTildeInPath)
    }

    var modInstaller: ModInstaller {
        ModInstaller(claudeDirectory: projectsURL.deletingLastPathComponent())
    }

    /// `~/.claude.json` for the default layout, otherwise `<config dir>/.claude.json`.
    var configFileURL: URL {
        let claudeDirectory = projectsURL.deletingLastPathComponent()
        let home = FileManager.default.homeDirectoryForCurrentUser
        if claudeDirectory.standardizedFileURL == home.appendingPathComponent(".claude").standardizedFileURL {
            return home.appendingPathComponent(".claude.json")
        }
        return claudeDirectory.appendingPathComponent(".claude.json")
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        let clock = ContinuousClock()
        let started = clock.now
        do {
            let snapshot = try await scanner.scan(projectsRoot: projectsURL, configFile: configFileURL)
            self.snapshot = snapshot
            modelOrder = UsageAggregator.modelTotals(snapshot.entries).map(\.name)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
        modState = modInstaller.state()
        await recomputeQuota()
        lastScanDuration = clock.now - started
        hasLoaded = true
    }

    func recomputeQuota() async {
        let entries = snapshot.entries
        let limitEvents = snapshot.limitEvents
        let mode = windowMode
        let configFile = configFileURL
        quota = await Task.detached(priority: .userInitiated) {
            QuotaSnapshot.build(entries: entries, limitEvents: limitEvents, mode: mode, configFile: configFile)
        }.value
    }

    func installMod() {
        do {
            try modInstaller.install()
            lastError = nil
        } catch {
            lastError = "安装 CC mod 失败：\(error.localizedDescription)"
        }
        modState = modInstaller.state()
    }

    func uninstallMod() {
        do {
            try modInstaller.uninstall()
            lastError = nil
        } catch {
            lastError = "卸载 CC mod 失败：\(error.localizedDescription)"
        }
        modState = modInstaller.state()
    }

    private func startAutoRefresh() {
        autoRefreshTask?.cancel()
        let interval = refreshInterval
        autoRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    func session(id: String) -> SessionSummary? {
        snapshot.sessions.first { $0.id == id }
    }

    /// Series name for per-model charts, folding models past the palette size into "其他".
    func modelSeries(for entry: UsageEntry) -> String {
        let name = Pricing.displayName(for: entry.model)
        guard let index = modelOrder.firstIndex(of: name), index < SeriesPalette.maxSeries - 1 else {
            return SeriesPalette.otherName
        }
        return name
    }

    /// Scale for the model series present in a chart; each model keeps its all-time color slot.
    func modelScale(present: Set<String>) -> SeriesScale {
        var scale = SeriesScale()
        for (index, name) in modelOrder.prefix(SeriesPalette.maxSeries - 1).enumerated() where present.contains(name) {
            scale.domain.append(name)
            scale.range.append(SeriesPalette.color(at: index))
        }
        if present.contains(SeriesPalette.otherName) {
            scale.domain.append(SeriesPalette.otherName)
            scale.range.append(SeriesPalette.otherColor)
        }
        return scale
    }
}
