import Foundation

/// Result of parsing one `.jsonl` transcript file.
public struct ParsedTranscript: Sendable {
    public var path: String
    /// Directory directly under `~/.claude/projects` (the encoded project path).
    public var projectDirectory: String
    public var sessionId: String
    public var agentId: String?
    public var entries: [UsageEntry]
    public var metadata: SessionMetadata
    /// Synthetic "You've hit your … limit · resets …" messages.
    public var limitEvents: [LimitEvent] = []

    public var isSubagent: Bool { agentId != nil }
}

public struct LimitEvent: Sendable, Hashable {
    public let timestamp: Date
    public let text: String
}

/// Reads Claude Code transcripts (`~/.claude/projects/<project>/<session>.jsonl` and
/// `<session>/subagents/agent-<id>.jsonl`) and extracts per-request usage.
public enum TranscriptParser {
    public static func parse(fileAt url: URL, projectsRoot: URL) throws -> ParsedTranscript {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return parse(data: data, fileURL: url, projectsRoot: projectsRoot)
    }

    public static func parse(data: Data, fileURL: URL, projectsRoot: URL) -> ParsedTranscript {
        let components = fileURL.standardizedFileURL.pathComponents
        let rootCount = projectsRoot.standardizedFileURL.pathComponents.count
        let projectDirectory = components.count > rootCount ? components[rootCount] : ""
        let fileStem = fileURL.deletingPathExtension().lastPathComponent
        let isSubagent = components.dropLast().last == "subagents"
        let fallbackSessionId = isSubagent
            ? fileURL.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent
            : fileStem
        let agentId = isSubagent ? String(fileStem.trimmingPrefix("agent-")) : nil

        var state = ParseState(agentId: agentId, wantsFirstPrompt: !isSubagent)
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            let count = raw.count
            while offset < count {
                let start = base + offset
                let remaining = count - offset
                let length: Int
                if let newline = memchr(start, 0x0A, remaining) {
                    length = start.distance(to: UnsafeRawPointer(newline))
                } else {
                    length = remaining
                }
                if length > 0 {
                    state.consume(line: UnsafeRawBufferPointer(start: start, count: length))
                }
                offset += length + 1
            }
        }

        let entries = state.entryOrder.compactMap { state.entries[$0] }
        return ParsedTranscript(
            path: fileURL.path,
            projectDirectory: projectDirectory,
            sessionId: state.sessionId ?? fallbackSessionId,
            agentId: agentId,
            entries: entries,
            metadata: state.metadata,
            limitEvents: state.limitEvents
        )
    }
}

// MARK: - Line handling

private struct ParseState {
    let agentId: String?
    var wantsFirstPrompt: Bool
    var userLinesInspected = 0
    var sessionId: String?
    var metadata = SessionMetadata()
    var entries: [String: UsageEntry] = [:]
    var entryOrder: [String] = []
    var limitEvents: [LimitEvent] = []

    let decoder = JSONDecoder()
    let dateParser = TimestampParser()

    init(agentId: String?, wantsFirstPrompt: Bool) {
        self.agentId = agentId
        self.wantsFirstPrompt = wantsFirstPrompt
    }

    mutating func consume(line: UnsafeRawBufferPointer) {
        if line.contains(Needle.assistant) {
            if line.contains(Needle.rateLimitError) {
                if let record = decode(LimitRecord.self, line), record.type == "assistant" {
                    handle(record)
                }
            } else if let record = decode(AssistantRecord.self, line), record.type == "assistant" {
                handle(record)
            }
        } else if line.contains(Needle.customTitle) || line.contains(Needle.agentName) || line.contains(Needle.summary) {
            if let record = decode(MetaRecord.self, line) {
                handle(record)
            }
        } else if wantsFirstPrompt, line.contains(Needle.user) {
            userLinesInspected += 1
            if userLinesInspected > 50 { wantsFirstPrompt = false }
            if let record = decode(UserRecord.self, line), record.type == "user" {
                handle(record)
            }
        }
    }

    func decode<T: Decodable>(_ type: T.Type, _ line: UnsafeRawBufferPointer) -> T? {
        guard let base = line.baseAddress else { return nil }
        let data = Data(bytesNoCopy: UnsafeMutableRawPointer(mutating: base), count: line.count, deallocator: .none)
        return try? decoder.decode(type, from: data)
    }

    mutating func noteCommonFields(sessionId: String?, cwd: String?, gitBranch: String?, version: String?) {
        if self.sessionId == nil { self.sessionId = sessionId }
        if metadata.cwd == nil { metadata.cwd = cwd }
        if let gitBranch, !gitBranch.isEmpty { metadata.gitBranch = gitBranch }
        if let version { metadata.version = version }
    }

    mutating func handle(_ record: AssistantRecord) {
        noteCommonFields(sessionId: record.sessionId, cwd: record.cwd, gitBranch: record.gitBranch, version: record.version)
        guard let message = record.message, let usage = message.usage,
              let model = message.model, model != "<synthetic>",
              let timestampText = record.timestamp, let timestamp = dateParser.date(from: timestampText)
        else { return }

        let totalWrite = usage.cacheCreationInputTokens ?? 0
        let write1h = usage.cacheCreation?.ephemeral1h ?? 0
        let write5m = max(totalWrite - write1h, usage.cacheCreation?.ephemeral5m ?? 0)
        let tokens = TokenCounts(
            input: usage.inputTokens ?? 0,
            output: usage.outputTokens ?? 0,
            cacheRead: usage.cacheReadInputTokens ?? 0,
            cacheWrite5m: write5m,
            cacheWrite1h: write1h,
            webSearches: usage.serverToolUse?.webSearchRequests ?? 0
        )
        guard tokens.total > 0 || tokens.webSearches > 0 else { return }

        let key = "\(message.id ?? record.uuid ?? UUID().uuidString):\(record.requestId ?? "")"
        // Claude Code writes one line per content block with the same message id; later
        // lines carry the final (largest) output count.
        if let existing = entries[key], existing.tokens.output > tokens.output { return }
        if entries[key] == nil { entryOrder.append(key) }
        entries[key] = UsageEntry(
            id: key,
            sessionId: record.sessionId ?? sessionId ?? "",
            timestamp: timestamp,
            model: model,
            tokens: tokens,
            isFast: usage.speed == "fast",
            agentId: agentId
        )
    }

    mutating func handle(_ record: LimitRecord) {
        guard let timestampText = record.timestamp, let timestamp = dateParser.date(from: timestampText),
              let text = record.message?.content?.first(where: { $0.type == "text" })?.text
        else { return }
        limitEvents.append(LimitEvent(timestamp: timestamp, text: text))
    }

    mutating func handle(_ record: MetaRecord) {
        switch record.type {
        case "custom-title": if let title = record.customTitle?.nonEmpty { metadata.customTitle = title }
        case "agent-name": if let name = record.agentName?.nonEmpty { metadata.agentName = name }
        case "summary": if let summary = record.summary?.nonEmpty { metadata.summary = summary }
        default: break
        }
    }

    mutating func handle(_ record: UserRecord) {
        noteCommonFields(sessionId: record.sessionId, cwd: record.cwd, gitBranch: record.gitBranch, version: record.version)
        guard record.isMeta != true, let text = record.message?.content?.firstText else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Skip slash-command wrappers, caveats and injected reminders.
        guard !trimmed.isEmpty, !trimmed.hasPrefix("<"), !trimmed.hasPrefix("Caveat:") else { return }
        metadata.firstPrompt = String(trimmed.prefix(200)).replacingOccurrences(of: "\n", with: " ")
        wantsFirstPrompt = false
    }
}

private enum Needle {
    static let assistant = Array(#""type":"assistant""#.utf8)
    static let rateLimitError = Array(#""error":"rate_limit""#.utf8)
    static let user = Array(#""type":"user""#.utf8)
    static let customTitle = Array(#""type":"custom-title""#.utf8)
    static let agentName = Array(#""type":"agent-name""#.utf8)
    static let summary = Array(#""type":"summary""#.utf8)
}

private extension UnsafeRawBufferPointer {
    func contains(_ needle: [UInt8]) -> Bool {
        guard let base = baseAddress else { return false }
        return needle.withUnsafeBytes { n in
            memmem(base, count, n.baseAddress, n.count) != nil
        }
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// ISO-8601 timestamps as written by Claude Code (`2026-09-26T05:33:38.007Z`).
private struct TimestampParser {
    let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    let plain = ISO8601DateFormatter()

    func date(from text: String) -> Date? {
        fractional.date(from: text) ?? plain.date(from: text)
    }
}

// MARK: - Records

private struct AssistantRecord: Decodable {
    let type: String?
    let uuid: String?
    let sessionId: String?
    let requestId: String?
    let timestamp: String?
    let cwd: String?
    let gitBranch: String?
    let version: String?
    let message: Message?

    struct Message: Decodable {
        let id: String?
        let model: String?
        let usage: Usage?
    }
}

private struct Usage: Decodable {
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheReadInputTokens: Int?
    let cacheCreationInputTokens: Int?
    let cacheCreation: CacheCreation?
    let serverToolUse: ServerToolUse?
    let speed: String?

    enum CodingKeys: String, CodingKey {
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case cacheReadInputTokens = "cache_read_input_tokens"
        case cacheCreationInputTokens = "cache_creation_input_tokens"
        case cacheCreation = "cache_creation"
        case serverToolUse = "server_tool_use"
        case speed
    }

    struct CacheCreation: Decodable {
        let ephemeral5m: Int?
        let ephemeral1h: Int?

        enum CodingKeys: String, CodingKey {
            case ephemeral5m = "ephemeral_5m_input_tokens"
            case ephemeral1h = "ephemeral_1h_input_tokens"
        }
    }

    struct ServerToolUse: Decodable {
        let webSearchRequests: Int?

        enum CodingKeys: String, CodingKey {
            case webSearchRequests = "web_search_requests"
        }
    }
}

private struct LimitRecord: Decodable {
    let type: String?
    let timestamp: String?
    let message: Message?

    struct Message: Decodable {
        let content: [Block]?
    }

    struct Block: Decodable {
        let type: String?
        let text: String?
    }
}

private struct MetaRecord: Decodable {
    let type: String?
    let customTitle: String?
    let agentName: String?
    let summary: String?
}

private struct UserRecord: Decodable {
    let type: String?
    let sessionId: String?
    let cwd: String?
    let gitBranch: String?
    let version: String?
    let isMeta: Bool?
    let message: Message?

    struct Message: Decodable {
        let content: Content?
    }

    enum Content: Decodable {
        case text(String)
        case blocks([Block])

        struct Block: Decodable {
            let type: String?
            let text: String?
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let text = try? container.decode(String.self) {
                self = .text(text)
            } else {
                self = .blocks((try? container.decode([Block].self)) ?? [])
            }
        }

        var firstText: String? {
            switch self {
            case .text(let text): text
            case .blocks(let blocks): blocks.first { $0.type == "text" }?.text
            }
        }
    }
}
