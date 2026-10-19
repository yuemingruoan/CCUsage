import Foundation

/// Token counts for one or more API requests, split the way they are billed.
public struct TokenCounts: Sendable, Hashable {
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite5m: Int
    public var cacheWrite1h: Int
    public var webSearches: Int

    public init(
        input: Int = 0, output: Int = 0, cacheRead: Int = 0,
        cacheWrite5m: Int = 0, cacheWrite1h: Int = 0, webSearches: Int = 0
    ) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite5m = cacheWrite5m
        self.cacheWrite1h = cacheWrite1h
        self.webSearches = webSearches
    }

    public var cacheWrite: Int { cacheWrite5m + cacheWrite1h }
    public var total: Int { input + output + cacheRead + cacheWrite }

    public static func += (lhs: inout TokenCounts, rhs: TokenCounts) {
        lhs.input += rhs.input
        lhs.output += rhs.output
        lhs.cacheRead += rhs.cacheRead
        lhs.cacheWrite5m += rhs.cacheWrite5m
        lhs.cacheWrite1h += rhs.cacheWrite1h
        lhs.webSearches += rhs.webSearches
    }
}

/// API-equivalent cost in USD, split by billing component.
public struct CostBreakdown: Sendable, Hashable {
    public var input: Double
    public var output: Double
    public var cacheRead: Double
    public var cacheWrite: Double
    public var webSearch: Double

    public init(input: Double = 0, output: Double = 0, cacheRead: Double = 0, cacheWrite: Double = 0, webSearch: Double = 0) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.webSearch = webSearch
    }

    public var total: Double { input + output + cacheRead + cacheWrite + webSearch }

    public static func += (lhs: inout CostBreakdown, rhs: CostBreakdown) {
        lhs.input += rhs.input
        lhs.output += rhs.output
        lhs.cacheRead += rhs.cacheRead
        lhs.cacheWrite += rhs.cacheWrite
        lhs.webSearch += rhs.webSearch
    }
}

/// One deduplicated API request recorded in a Claude Code transcript.
public struct UsageEntry: Sendable, Hashable, Identifiable {
    /// `message.id:requestId`; stable across the duplicated per-content-block lines.
    public let id: String
    public let sessionId: String
    public let timestamp: Date
    public let model: String
    public let tokens: TokenCounts
    public let isFast: Bool
    /// Non-nil when the request came from a subagent transcript.
    public let agentId: String?
    public let cost: CostBreakdown
    /// False when the model has no entry in the pricing table (cost is then zero).
    public let isPriced: Bool

    public var isSubagent: Bool { agentId != nil }

    public init(
        id: String, sessionId: String, timestamp: Date, model: String, tokens: TokenCounts,
        isFast: Bool = false, agentId: String? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.timestamp = timestamp
        self.model = model
        self.tokens = tokens
        self.isFast = isFast
        self.agentId = agentId
        if let cost = Pricing.cost(tokens: tokens, model: model, isFast: isFast) {
            self.cost = cost
            self.isPriced = true
        } else {
            self.cost = CostBreakdown()
            self.isPriced = false
        }
    }
}

/// Descriptive fields collected from a session transcript.
public struct SessionMetadata: Sendable, Hashable {
    public var customTitle: String?
    public var agentName: String?
    public var summary: String?
    public var firstPrompt: String?
    public var cwd: String?
    public var gitBranch: String?
    public var version: String?

    public init() {}

    /// Fills fields that are still nil from `other`.
    public mutating func fillMissing(from other: SessionMetadata) {
        customTitle = customTitle ?? other.customTitle
        agentName = agentName ?? other.agentName
        summary = summary ?? other.summary
        firstPrompt = firstPrompt ?? other.firstPrompt
        cwd = cwd ?? other.cwd
        gitBranch = gitBranch ?? other.gitBranch
        version = version ?? other.version
    }
}

public struct SessionSummary: Sendable, Hashable, Identifiable {
    public let id: String
    public let title: String
    public let projectName: String
    public let cwd: String?
    public let gitBranch: String?
    public let version: String?
    public let start: Date
    public let end: Date
    public let models: [String]
    public let tokens: TokenCounts
    public let cost: CostBreakdown
    public let subagentCost: Double
    public let requestCount: Int
    public let subagentCount: Int
    public let hasUnpricedRequests: Bool
    /// `lastCost` that Claude Code itself wrote to `~/.claude.json` for this session, if any.
    public let recordedCost: Double?
}
