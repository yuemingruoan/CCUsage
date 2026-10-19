import Foundation

// MARK: - Observations

public enum QuotaKind: String, Sendable, CaseIterable, Identifiable {
    case fiveHour, sevenDay

    public var id: String { rawValue }
    public var duration: TimeInterval { self == .fiveHour ? 5 * 3600 : 7 * 86400 }
    public var label: String { self == .fiveHour ? "5 小时" : "每周" }
}

public enum ObservationSource: String, Sendable {
    /// `rate_limits` passed to the Claude Code status line (exact).
    case statusLine
    /// "You've hit your … limit · resets 10:10pm" transcript messages (minute-rounded, 100% used).
    case limitMessage
}

/// A usage percentage and reset time reported by Claude Code.
public struct QuotaObservation: Sendable, Hashable {
    public let kind: QuotaKind
    public let observedAt: Date
    public let resetsAt: Date
    public let usedPercentage: Double
    public let source: ObservationSource
    /// The Claude Code session that reported it (status line only). Idle sessions keep
    /// reporting stale values, so only one session's own reports are strictly ordered.
    public let sessionId: String?

    public init(kind: QuotaKind, observedAt: Date, resetsAt: Date, usedPercentage: Double, source: ObservationSource,
                sessionId: String? = nil) {
        self.kind = kind
        self.observedAt = observedAt
        self.resetsAt = resetsAt
        self.usedPercentage = usedPercentage
        self.source = source
        self.sessionId = sessionId
    }

    public var windowStart: Date { resetsAt.addingTimeInterval(-kind.duration) }
}

public enum LimitMessageParser {
    /// Parses "You've hit your session limit · resets 10:10pm (Asia/Singapore)".
    public static func observation(from event: LimitEvent) -> QuotaObservation? {
        let lower = event.text.lowercased()
        let kind: QuotaKind
        if lower.contains("session limit") || lower.contains("5-hour limit") {
            kind = .fiveHour
        } else if lower.contains("weekly limit"), !["opus", "fable", "sonnet", "mythos"].contains(where: lower.contains) {
            kind = .sevenDay
        } else {
            return nil
        }
        guard let resetsAt = resetDate(in: event.text, after: event.timestamp) else { return nil }
        return QuotaObservation(kind: kind, observedAt: event.timestamp, resetsAt: resetsAt, usedPercentage: 100, source: .limitMessage)
    }

    /// Next date after `date` matching "10:10pm", "Mon 9am" or "Sep 30, 9am" in the quoted time zone.
    static func resetDate(in text: String, after date: Date) -> Date? {
        guard let marker = text.range(of: "resets ") else { return nil }
        var body = text[marker.upperBound...]
        var timeZone = TimeZone.current
        if let open = body.firstIndex(of: "("), let close = body[open...].firstIndex(of: ")") {
            timeZone = TimeZone(identifier: String(body[body.index(after: open)..<close])) ?? timeZone
            body = body[..<open]
        }
        let lower = body.lowercased()
        guard let match = lower.firstMatch(of: #/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/#),
              let rawHour = Int(match.1)
        else { return nil }

        var components = DateComponents()
        components.hour = rawHour % 12 + (match.3 == "pm" ? 12 : 0)
        components.minute = match.2.flatMap { Int($0) } ?? 0
        components.second = 0

        let weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        for word in lower[..<match.range.lowerBound].split(whereSeparator: { $0 == " " || $0 == "," }) {
            let prefix = String(word.prefix(3))
            if let index = weekdays.firstIndex(of: prefix) {
                components.weekday = index + 1
            } else if let index = months.firstIndex(of: prefix) {
                components.month = index + 1
            } else if let day = Int(word) {
                components.day = day
            }
        }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.nextDate(after: date, matching: components, matchingPolicy: .nextTime)
    }
}

/// Reads the JSONL log written by the CCUsage mod (and by the status line script before it).
public enum StatusLineLog {
    public static func read(_ url: URL) -> [QuotaObservation] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        var observations: [QuotaObservation] = []
        for line in data.split(separator: UInt8(ascii: "\n")) {
            guard let record = try? decoder.decode(Record.self, from: Data(line)) else { continue }
            let observedAt = Date(timeIntervalSince1970: record.ts)
            for (kind, window) in [(QuotaKind.fiveHour, record.fiveHour), (.sevenDay, record.sevenDay)] {
                guard let window, let used = window.usedPercentage, let resets = window.resetsAt else { continue }
                observations.append(QuotaObservation(
                    kind: kind, observedAt: observedAt, resetsAt: Date(timeIntervalSince1970: resets),
                    usedPercentage: used, source: .statusLine, sessionId: record.sessionId
                ))
            }
        }
        return observations
    }

    private struct Record: Decodable {
        let ts: Double
        let sessionId: String?
        let fiveHour: Window?
        let sevenDay: Window?

        enum CodingKeys: String, CodingKey {
            case ts
            case sessionId = "session_id"
            case fiveHour = "five_hour"
            case sevenDay = "seven_day"
        }
    }

    private struct Window: Decodable {
        let usedPercentage: Double?
        let resetsAt: Double?

        enum CodingKeys: String, CodingKey {
            case usedPercentage = "used_percentage"
            case resetsAt = "resets_at"
        }
    }
}

// MARK: - Windows

public enum WindowMode: String, Sendable, CaseIterable, Identifiable {
    /// A window opens with the first request after the previous one ended.
    case firstRequest
    /// Windows repeat back to back from the latest reported reset, used or not.
    case fixedRolling

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .firstRequest: "首条请求开启窗口"
        case .fixedRolling: "固定周期滚动"
        }
    }
}

public struct QuotaWindow: Sendable, Hashable, Identifiable {
    public let kind: QuotaKind
    public let start: Date
    /// The end time was reported by Claude Code rather than inferred.
    public let isConfirmed: Bool
    public var tokens = TokenCounts()
    public var cost = 0.0
    public var requestCount = 0
    public var sessionIds: Set<String> = []
    public var observations: [QuotaObservation] = []
    /// Latest reported percentage in this window with the cost spent up to that moment.
    public var latestSample: LimitSample?
    /// Claude Code reset the usage after this moment, before the window was due to end
    /// (e.g. on a plan upgrade). Earlier usage counted toward the previous limit.
    public var resetAt: Date?
    /// Cost spent up to `resetAt`.
    public var costBeforeReset = 0.0
    /// Normally `start + duration`; earlier when Claude Code opened the next window early.
    public var end: Date

    public init(kind: QuotaKind, start: Date, isConfirmed: Bool) {
        self.kind = kind
        self.start = start
        self.isConfirmed = isConfirmed
        self.end = start.addingTimeInterval(kind.duration)
    }

    public var id: Date { start }
    public var maxObservedPercentage: Double? { observations.map(\.usedPercentage).max() }
    /// Cost counted against the limit in force after `resetAt`.
    public var costSinceReset: Double { cost - costBeforeReset }
    /// Observations reported against the limit in force after `resetAt`.
    public var observationsSinceReset: [QuotaObservation] {
        guard let resetAt else { return observations }
        return observations.filter { $0.observedAt > resetAt }
    }

    public func contains(_ date: Date) -> Bool { start <= date && date < end }

    mutating func add(_ entry: UsageEntry) {
        tokens += entry.tokens
        cost += entry.cost.total
        requestCount += 1
        sessionIds.insert(entry.sessionId)
    }
}

/// A point where the subscription limit changed; windows before it are not used for estimates.
public struct PlanChange: Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        /// Rate-limit tier recorded from `~/.claude.json` changed (`from` → `to`).
        case recorded(from: String?, to: String)
        /// A window spent clearly more than the estimate without hitting the limit.
        case inferredUpgrade
        /// A new fit came out clearly below the estimate.
        case inferredDowngrade
    }

    public let date: Date
    public let kind: Kind

    public init(date: Date, kind: Kind) {
        self.date = date
        self.kind = kind
    }
}

/// Cost spent in a window by the time Claude Code reported a usage percentage.
public struct LimitSample: Sendable, Hashable {
    public let observedAt: Date
    public let usedPercentage: Double
    public let cost: Double

    public init(observedAt: Date, usedPercentage: Double, cost: Double) {
        self.observedAt = observedAt
        self.usedPercentage = usedPercentage
        self.cost = cost
    }

    /// Estimated 100% = spent / used percentage.
    public var impliedLimit: Double { cost / usedPercentage * 100 }
}

public struct LimitEstimate: Sendable, Hashable {
    /// The latest sample of the current plan period; the estimate is taken from it alone.
    public let sample: LimitSample?
    /// Estimated USD-equivalent cost of 100% of the window (spent / used percentage).
    public var cost: Double? { sample?.impliedLimit }
    /// Highest window cost seen without hitting the limit since the last plan change.
    public let lowerBound: Double
    /// The change that started the current plan period, if any was seen.
    public let planChange: PlanChange?
}

/// Where the current window stands and where it is heading.
public struct QuotaStatus: Sendable {
    public let kind: QuotaKind
    public let window: QuotaWindow?
    public let latestObservation: QuotaObservation?
    public let estimate: LimitEstimate?
    /// USD-equivalent per hour over the recent lookback (1 h for 5-hour, 24 h for weekly).
    public let burnRatePerHour: Double
    /// Best current usage estimate in percent; may exceed 100.
    public let percentage: Double?
    /// True when `percentage` is exactly what Claude Code last reported.
    public let percentageIsReported: Bool
    /// Projected time to reach 100%, if that happens before the window resets.
    public let exhaustionDate: Date?
}

public enum QuotaCalculator {
    /// Limit messages round reset times; treat anchors this close as the same window.
    static let matchTolerance: TimeInterval = 15 * 60
    /// How far a recorded plan change may be moved to an observed usage reset.
    static let planChangeSnap: TimeInterval = 86400

    public static func windows(
        kind: QuotaKind, entries: [UsageEntry], observations: [QuotaObservation],
        mode: WindowMode, now: Date = Date()
    ) -> [QuotaWindow] {
        let duration = kind.duration
        // Exact status line data first, then the most recent observation.
        let anchors = observations.filter { $0.kind == kind }.sorted {
            if $0.source != $1.source { return $0.source == .statusLine }
            return $0.observedAt > $1.observedAt
        }

        // Overlapping windows are the same one, unless the status line reported both reset
        // times exactly: then Claude Code opened the later window early.
        var confirmedAnchors: [QuotaObservation] = []
        for anchor in anchors where !confirmedAnchors.contains(where: {
            let distance = abs($0.windowStart.timeIntervalSince(anchor.windowStart))
            return distance < matchTolerance || (distance < duration && ($0.source != .statusLine || anchor.source != .statusLine))
        }) {
            confirmedAnchors.append(anchor)
        }
        var windows = confirmedAnchors.map(\.windowStart).sorted().map { QuotaWindow(kind: kind, start: $0, isConfirmed: true) }
        let confirmedCount = windows.count

        let gridOrigin = mode == .fixedRolling ? anchors.first?.windowStart : nil
        func gridStart(for date: Date, origin: Date) -> Date {
            origin.addingTimeInterval((date.timeIntervalSince(origin) / duration).rounded(.down) * duration)
        }

        var timelines: [[(date: Date, cost: Double)]] = Array(repeating: [], count: confirmedCount)
        var openIndex: Int?
        for entry in entries {
            let time = entry.timestamp
            let index: Int
            if let confirmed = windows[..<confirmedCount].lastIndex(where: { $0.contains(time) }) {
                index = confirmed
            } else if let open = openIndex, windows[open].contains(time) {
                index = open
            } else {
                let start = gridOrigin.map { gridStart(for: time, origin: $0) }
                    ?? Date(timeIntervalSinceReferenceDate: (time.timeIntervalSinceReferenceDate / 60).rounded(.down) * 60)
                windows.append(QuotaWindow(kind: kind, start: start, isConfirmed: false))
                timelines.append([])
                index = windows.count - 1
                openIndex = index
            }
            windows[index].add(entry)
            timelines[index].append((time, entry.cost.total))
        }

        if let origin = gridOrigin, !windows.contains(where: { $0.contains(now) }) {
            windows.append(QuotaWindow(kind: kind, start: gridStart(for: now, origin: origin), isConfirmed: false))
            timelines.append([])
        }

        for observation in anchors {
            let index = windows.firstIndex { abs($0.end.timeIntervalSince(observation.resetsAt)) < matchTolerance }
                ?? windows.firstIndex { $0.contains(observation.observedAt) }
            if let index { windows[index].observations.append(observation) }
        }

        for index in windows.indices {
            windows[index].observations.sort { $0.observedAt < $1.observedAt }
            windows[index].resetAt = inWindowReset(windows[index].observations)
        }

        // A window opened before the previous one ended: the previous one was cut short, and
        // usage reported against it until then belongs to the old limit.
        for index in 0..<max(confirmedCount - 1, 0) where windows[index].end > windows[index + 1].start {
            let next = windows[index + 1]
            let firstNew = next.observations.first?.observedAt ?? .distantFuture
            if let lastOld = windows[index].observations.last(where: { $0.observedAt < firstNew })?.observedAt,
               lastOld > next.start {
                windows[index + 1].resetAt = max(next.resetAt ?? lastOld, lastOld)
            }
            windows[index].end = next.start
        }

        for index in windows.indices {
            if let resetAt = windows[index].resetAt {
                windows[index].costBeforeReset = timelines[index].reduce(0) { $1.date <= resetAt ? $0 + $1.cost : $0 }
            }
            windows[index].latestSample = latestSample(
                observations: windows[index].observationsSinceReset, timeline: timelines[index], after: windows[index].resetAt
            )
        }
        return windows.sorted { $0.start < $1.start }
    }

    /// Smallest drop within one session's reports that counts as a reset. Single-point drops
    /// show up without one (rounding), so they are ignored.
    static let resetDrop = 2.0

    /// The last report before one session saw the percentage drop within the same window.
    static func inWindowReset(_ observations: [QuotaObservation]) -> Date? {
        var last: [String?: QuotaObservation] = [:]
        var reset: Date?
        for observation in observations where observation.source == .statusLine {
            if let previous = last[observation.sessionId],
               previous.usedPercentage - observation.usedPercentage >= resetDrop {
                reset = previous.observedAt
            }
            last[observation.sessionId] = observation
        }
        return reset
    }

    /// The latest observation with a usable percentage, paired with the cost spent by then
    /// (after `resetAt`, if the window was reset).
    /// Very small percentages are skipped: their rounding makes spent / percentage unreliable.
    static func latestSample(
        observations: [QuotaObservation], timeline: [(date: Date, cost: Double)], after resetAt: Date? = nil
    ) -> LimitSample? {
        let since = resetAt ?? .distantPast
        for observation in observations.reversed() where observation.usedPercentage >= 3 {
            let cost = timeline.reduce(0) { $1.date > since && $1.date <= observation.observedAt ? $0 + $1.cost : $0 }
            guard cost > 0 else { continue }
            return LimitSample(observedAt: observation.observedAt, usedPercentage: observation.usedPercentage, cost: cost)
        }
        return nil
    }

    /// Estimates 100% of the window as spent / used percentage from the latest sample of the
    /// current plan period; older plan periods never contribute.
    ///
    /// The period starts at the latest recorded tier change, or at an inferred one: a window
    /// that spent clearly more than the previous estimate without hitting the limit (upgrade),
    /// or a sample implying a clearly different limit (upgrade / downgrade). Without a sample
    /// in the period only a lower bound is known.
    ///
    /// Claude Code does not always update the profile fetch time a recorded change is dated
    /// by, so a recorded change is moved to the nearest usage reset within `planChangeSnap`.
    public static func estimate(from windows: [QuotaWindow], planChanges: [PlanChange] = []) -> LimitEstimate? {
        var recorded = planChanges.max { $0.date < $1.date }
        if let logged = recorded,
           let reset = windows.compactMap(\.resetAt).min(by: { abs($0.timeIntervalSince(logged.date)) < abs($1.timeIntervalSince(logged.date)) }),
           abs(reset.timeIntervalSince(logged.date)) <= planChangeSnap {
            recorded = PlanChange(date: reset, kind: logged.kind)
        }
        var change = recorded
        var sample: LimitSample?
        var lowerBound = 0.0

        func startPeriod(_ newChange: PlanChange) {
            change = newChange
            sample = nil
            lowerBound = 0
        }

        for window in windows.sorted(by: { $0.start < $1.start }) {
            // A window straddling a recorded change mixes both limits, unless it was reset there.
            let periodStart = window.resetAt ?? window.start
            if let recorded, periodStart < recorded.date { continue }
            let previous = sample?.impliedLimit
            if let latest = window.latestSample {
                let implied = latest.impliedLimit
                if let previous, implied < previous * 0.8 || implied < lowerBound * 0.95 {
                    startPeriod(PlanChange(date: periodStart, kind: .inferredDowngrade))
                } else if let previous, implied > previous * 1.25 {
                    startPeriod(PlanChange(date: periodStart, kind: .inferredUpgrade))
                }
                sample = latest
                continue
            }
            let hitLimit = (window.observationsSinceReset.map(\.usedPercentage).max() ?? 0) >= 100
            let cost = window.costSinceReset
            guard !hitLimit, cost > 0 else { continue }
            if let previous, cost > previous * 1.05 {
                startPeriod(PlanChange(date: periodStart, kind: .inferredUpgrade))
            }
            lowerBound = max(lowerBound, cost)
        }

        guard sample != nil || lowerBound > 0 else { return nil }
        return LimitEstimate(sample: sample, lowerBound: lowerBound, planChange: change)
    }

    public static func status(
        kind: QuotaKind, windows: [QuotaWindow], entries: [UsageEntry],
        planChanges: [PlanChange] = [], now: Date = Date()
    ) -> QuotaStatus {
        let current = windows.last { $0.contains(now) }
        let estimate = estimate(from: windows, planChanges: planChanges)
        let latest = current?.observations.last

        func cost(since start: Date) -> Double {
            var low = 0, high = entries.count
            while low < high {
                let mid = (low + high) / 2
                if entries[mid].timestamp < start { low = mid + 1 } else { high = mid }
            }
            return entries[low...].reduce(0) { $1.timestamp <= now ? $0 + $1.cost.total : $0 }
        }

        var burnRate = 0.0
        if let current {
            let lookback: TimeInterval = kind == .fiveHour ? 3600 : 86400
            let since = max(now.addingTimeInterval(-lookback), current.resetAt ?? current.start)
            burnRate = cost(since: since) / (max(now.timeIntervalSince(since), 600) / 3600)
        }

        var percentage: Double?
        var isReported = false
        if let latest {
            let extra = cost(since: latest.observedAt.addingTimeInterval(1))
            if let limit = estimate?.cost, limit > 0 {
                percentage = latest.usedPercentage + extra / limit * 100
                isReported = extra == 0
            } else {
                percentage = latest.usedPercentage
                isReported = true
            }
        } else if let current, let limit = estimate?.cost, limit > 0 {
            percentage = current.costSinceReset / limit * 100
        }

        var exhaustion: Date?
        if let current, let percentage, let limit = estimate?.cost {
            if percentage >= 100 {
                exhaustion = now
            } else if burnRate > 0 {
                let date = now.addingTimeInterval((100 - percentage) / 100 * limit / burnRate * 3600)
                exhaustion = date < current.end ? date : nil
            }
        }

        return QuotaStatus(
            kind: kind, window: current, latestObservation: latest, estimate: estimate,
            burnRatePerHour: burnRate, percentage: percentage, percentageIsReported: isReported,
            exhaustionDate: exhaustion
        )
    }
}
