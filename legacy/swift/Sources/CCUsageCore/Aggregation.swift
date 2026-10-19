import Foundation

/// Immutable view of all usage found in one scan.
public struct UsageSnapshot: Sendable {
    /// Deduplicated requests, sorted by timestamp.
    public var entries: [UsageEntry]
    /// Sessions sorted by most recent activity first.
    public var sessions: [SessionSummary]
    public var entriesBySession: [String: [UsageEntry]]
    /// Deduplicated usage-limit messages, sorted by time.
    public var limitEvents: [LimitEvent]
    public var fileCount: Int
    public var generatedAt: Date

    public static let empty = UsageSnapshot(entries: [], sessions: [], entriesBySession: [:], limitEvents: [], fileCount: 0, generatedAt: .distantPast)

    /// Builds a snapshot from parsed transcripts.
    /// - Parameter recordedCosts: `lastSessionId -> lastCost` pairs from `~/.claude.json`.
    public static func build(transcripts: [ParsedTranscript], recordedCosts: [String: Double] = [:]) -> UsageSnapshot {
        // Main transcripts sort before their `<session>/subagents/` directory, so the first
        // occurrence of a request (e.g. copied into a resumed session) keeps ownership.
        let ordered = transcripts.sorted { $0.path < $1.path }

        var seen = Set<String>()
        var entriesBySession: [String: [UsageEntry]] = [:]
        var metadata: [String: SessionMetadata] = [:]
        var projectDirectories: [String: String] = [:]
        var subagents: [String: Set<String>] = [:]

        for transcript in ordered {
            let sessionId = transcript.sessionId
            if transcript.isSubagent {
                var fallback = SessionMetadata()
                fallback.cwd = transcript.metadata.cwd
                metadata[sessionId, default: SessionMetadata()].fillMissing(from: fallback)
            } else {
                var merged = transcript.metadata
                merged.fillMissing(from: metadata[sessionId] ?? SessionMetadata())
                metadata[sessionId] = merged
            }
            projectDirectories[sessionId] = projectDirectories[sessionId] ?? transcript.projectDirectory

            for entry in transcript.entries where seen.insert(entry.id).inserted {
                entriesBySession[sessionId, default: []].append(entry)
                if let agentId = entry.agentId { subagents[sessionId, default: []].insert(agentId) }
            }
        }

        var sessions: [SessionSummary] = []
        for (sessionId, unsorted) in entriesBySession {
            let entries = unsorted.sorted { $0.timestamp < $1.timestamp }
            entriesBySession[sessionId] = entries
            let meta = metadata[sessionId] ?? SessionMetadata()

            var tokens = TokenCounts()
            var cost = CostBreakdown()
            var subagentCost = 0.0
            var modelCost: [String: Double] = [:]
            var unpriced = false
            for entry in entries {
                tokens += entry.tokens
                cost += entry.cost
                if entry.isSubagent { subagentCost += entry.cost.total }
                modelCost[Pricing.displayName(for: entry.model), default: 0] += entry.cost.total
                unpriced = unpriced || !entry.isPriced
            }

            let title = meta.customTitle ?? meta.agentName ?? meta.summary ?? meta.firstPrompt
                ?? "未命名会话 \(sessionId.prefix(8))"
            let projectName = meta.cwd.map { URL(fileURLWithPath: $0).lastPathComponent }
                ?? projectDirectories[sessionId] ?? "未知项目"

            sessions.append(SessionSummary(
                id: sessionId,
                title: title,
                projectName: projectName,
                cwd: meta.cwd,
                gitBranch: meta.gitBranch,
                version: meta.version,
                start: entries.first?.timestamp ?? .distantPast,
                end: entries.last?.timestamp ?? .distantPast,
                models: modelCost.sorted { $0.value > $1.value }.map(\.key),
                tokens: tokens,
                cost: cost,
                subagentCost: subagentCost,
                requestCount: entries.count,
                subagentCount: subagents[sessionId]?.count ?? 0,
                hasUnpricedRequests: unpriced,
                recordedCost: recordedCosts[sessionId]
            ))
        }

        return UsageSnapshot(
            entries: entriesBySession.values.flatMap { $0 }.sorted { $0.timestamp < $1.timestamp },
            sessions: sessions.sorted { $0.end > $1.end },
            entriesBySession: entriesBySession,
            limitEvents: Array(Set(transcripts.flatMap(\.limitEvents))).sorted { $0.timestamp < $1.timestamp },
            fileCount: transcripts.count,
            generatedAt: Date()
        )
    }

    /// Entries with `timestamp >= start`, using binary search on the sorted list.
    public func entries(since start: Date?) -> ArraySlice<UsageEntry> {
        guard let start else { return entries[...] }
        var low = 0, high = entries.count
        while low < high {
            let mid = (low + high) / 2
            if entries[mid].timestamp < start { low = mid + 1 } else { high = mid }
        }
        return entries[low...]
    }
}

// MARK: - Time buckets

public enum TimeGranularity: String, CaseIterable, Identifiable, Sendable {
    case fiveMinutes, fifteenMinutes, hour, day, week

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .fiveMinutes: "5 分钟"
        case .fifteenMinutes: "15 分钟"
        case .hour: "小时"
        case .day: "天"
        case .week: "周"
        }
    }

    public func bucketStart(for date: Date, calendar: Calendar = .current) -> Date {
        switch self {
        case .fiveMinutes, .fifteenMinutes:
            let hour = calendar.dateInterval(of: .hour, for: date)?.start ?? date
            let step: TimeInterval = self == .fiveMinutes ? 300 : 900
            return hour.addingTimeInterval((date.timeIntervalSince(hour) / step).rounded(.down) * step)
        case .hour:
            return calendar.dateInterval(of: .hour, for: date)?.start ?? date
        case .day:
            return calendar.startOfDay(for: date)
        case .week:
            return calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? date
        }
    }

    public func bucketEnd(forStart start: Date, calendar: Calendar = .current) -> Date {
        switch self {
        case .fiveMinutes: start.addingTimeInterval(300)
        case .fifteenMinutes: start.addingTimeInterval(900)
        case .hour: calendar.date(byAdding: .hour, value: 1, to: start) ?? start
        case .day: calendar.date(byAdding: .day, value: 1, to: start) ?? start
        case .week: calendar.date(byAdding: .weekOfYear, value: 1, to: start) ?? start
        }
    }

    /// A granularity that yields a readable number of points on a line for the given span.
    public static func suggested(for span: TimeInterval) -> TimeGranularity {
        switch span {
        case ..<(2 * 86400): .fiveMinutes
        case ..<(10 * 86400): .fifteenMinutes
        case ..<(60 * 86400): .hour
        default: .day
        }
    }
}

public struct UsageBucket: Sendable, Hashable, Identifiable {
    public let start: Date
    public let end: Date
    public let series: String
    public var tokens: TokenCounts
    public var cost: Double
    public var requestCount: Int

    public var id: String { "\(start.timeIntervalSinceReferenceDate)|\(series)" }
}

public struct ModelTotal: Sendable, Hashable, Identifiable {
    public let name: String
    public var tokens: TokenCounts
    public var cost: Double
    public var requestCount: Int
    public var hasUnpricedRequests = false

    public var id: String { name }
}

private struct BucketKey: Hashable {
    let start: Date
    let series: String
}

public enum UsageAggregator {
    public static func buckets<S: Sequence<UsageEntry>>(
        _ entries: S, granularity: TimeGranularity, calendar: Calendar = .current,
        series: (UsageEntry) -> String
    ) -> [UsageBucket] {
        var buckets: [BucketKey: UsageBucket] = [:]
        for entry in entries {
            let start = granularity.bucketStart(for: entry.timestamp, calendar: calendar)
            let key = BucketKey(start: start, series: series(entry))
            if buckets[key] == nil {
                let end = granularity.bucketEnd(forStart: start, calendar: calendar)
                buckets[key] = UsageBucket(start: start, end: end, series: key.series, tokens: TokenCounts(), cost: 0, requestCount: 0)
            }
            buckets[key]!.tokens += entry.tokens
            buckets[key]!.cost += entry.cost.total
            buckets[key]!.requestCount += 1
        }
        return buckets.values.sorted { ($0.start, $0.series) < ($1.start, $1.series) }
    }

    public static func modelTotals<S: Sequence<UsageEntry>>(_ entries: S) -> [ModelTotal] {
        var totals: [String: ModelTotal] = [:]
        for entry in entries {
            let name = Pricing.displayName(for: entry.model)
            totals[name, default: ModelTotal(name: name, tokens: TokenCounts(), cost: 0, requestCount: 0)].tokens += entry.tokens
            totals[name]!.cost += entry.cost.total
            totals[name]!.requestCount += 1
            if !entry.isPriced { totals[name]!.hasUnpricedRequests = true }
        }
        return totals.values.sorted { $0.cost > $1.cost }
    }
}
