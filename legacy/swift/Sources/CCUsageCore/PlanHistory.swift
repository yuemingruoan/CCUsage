import Foundation

/// The subscription plan Claude Code last fetched (`oauthAccount` in `~/.claude.json`).
public struct PlanInfo: Sendable, Hashable, Codable {
    /// e.g. `default_claude_max_5x`.
    public let tier: String
    /// e.g. `claude_max`.
    public let organizationType: String?
    /// When Claude Code fetched this profile.
    public let fetchedAt: Date

    public var displayName: String { Self.displayName(forTier: tier) }

    /// `default_claude_max_5x` -> `Max 5x`.
    public static func displayName(forTier tier: String) -> String {
        let parts = tier.replacingOccurrences(of: "default_", with: "").split(separator: "_")
        guard parts.first == "claude" else { return tier }
        return parts.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    public static func read(configFile: URL) -> PlanInfo? {
        guard let data = try? Data(contentsOf: configFile),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let account = root["oauthAccount"] as? [String: Any],
              let tier = (account["organizationRateLimitTier"] as? String) ?? (account["userRateLimitTier"] as? String)
        else { return nil }
        let fetched = (account["profileFetchedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
        return PlanInfo(tier: tier, organizationType: account["organizationType"] as? String, fetchedAt: fetched)
    }
}

/// Append-only log of plan tiers, so later estimates can ignore windows from an older plan.
public enum PlanHistory {
    /// Records `plan` if its tier differs from the last logged one; returns the whole log.
    @discardableResult
    public static func record(_ plan: PlanInfo?, in logURL: URL) -> [PlanInfo] {
        var history = read(logURL)
        guard let plan, history.last?.tier != plan.tier else { return history }
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard var line = try? encoder.encode(plan) else { return history }
        line.append(UInt8(ascii: "\n"))
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            handle.write(line)
            try? handle.close()
        } else {
            try? line.write(to: logURL)
        }
        history.append(plan)
        return history
    }

    public static func read(_ logURL: URL) -> [PlanInfo] {
        guard let data = try? Data(contentsOf: logURL) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return data.split(separator: UInt8(ascii: "\n")).compactMap { try? decoder.decode(PlanInfo.self, from: Data($0)) }
    }

    /// Tier changes between consecutive log entries, dated at the profile fetch time stored
    /// with the new tier. Claude Code can update the tier without that time, so the date may
    /// be off either way; `QuotaCalculator.estimate` moves it to the usage reset it caused.
    public static func changes(in history: [PlanInfo]) -> [PlanChange] {
        zip(history, history.dropFirst()).compactMap { previous, next in
            previous.tier == next.tier ? nil : PlanChange(date: next.fetchedAt, kind: .recorded(from: previous.tier, to: next.tier))
        }
    }
}
