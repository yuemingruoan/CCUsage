import Foundation

/// Anthropic API list prices in USD per million tokens.
public struct ModelPrice: Sendable, Hashable {
    public let input: Double
    public let output: Double
    public let cacheRead: Double
    public let cacheWrite5m: Double
    public let cacheWrite1h: Double
    /// Multiplier applied to every component when `usage.speed == "fast"`; nil if fast mode is unpriced.
    public let fastMultiplier: Double?

    public init(input: Double, output: Double, cacheRead: Double, fastMultiplier: Double? = nil) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite5m = input * 1.25
        self.cacheWrite1h = input * 2
        self.fastMultiplier = fastMultiplier
    }
}

public struct PricedModel: Sendable, Hashable, Identifiable {
    public let prefix: String
    public let displayName: String
    public let price: ModelPrice
    /// Higher rates for requests whose prompt (input + cache tokens) exceeds `longPromptThreshold`; nil if the model has no tier.
    public let longPrompt: ModelPrice?
    public let longPromptThreshold: Int

    public init(
        prefix: String, displayName: String, price: ModelPrice,
        longPrompt: ModelPrice? = nil, longPromptThreshold: Int = 100_000
    ) {
        self.prefix = prefix
        self.displayName = displayName
        self.price = price
        self.longPrompt = longPrompt
        self.longPromptThreshold = longPromptThreshold
    }

    public var id: String { prefix }
}

public enum Pricing {
    public static let webSearchPerRequest = 10.0 / 1000

    /// Matched by longest prefix, so dated IDs like `claude-haiku-4-5-20251001` resolve too.
    public static let models: [PricedModel] = [
        PricedModel(prefix: "claude-fable-5-1", displayName: "Fable 5.1", price: .init(input: 10, output: 50, cacheRead: 0.25)),
        PricedModel(prefix: "claude-mythos-5-1", displayName: "Mythos 5.1", price: .init(input: 10, output: 50, cacheRead: 0.25)),
        PricedModel(prefix: "claude-fable-5", displayName: "Fable 5", price: .init(input: 10, output: 50, cacheRead: 1)),
        PricedModel(prefix: "claude-mythos-5", displayName: "Mythos 5", price: .init(input: 10, output: 50, cacheRead: 1)),
        PricedModel(prefix: "claude-opus-5-5", displayName: "Opus 5.5", price: .init(input: 4, output: 20, cacheRead: 0.2, fastMultiplier: 2)),
        PricedModel(prefix: "claude-opus-5", displayName: "Opus 5", price: .init(input: 5, output: 25, cacheRead: 0.5, fastMultiplier: 2)),
        PricedModel(prefix: "claude-opus-4-8", displayName: "Opus 4.8", price: .init(input: 5, output: 25, cacheRead: 0.5)),
        PricedModel(prefix: "claude-opus-4-7", displayName: "Opus 4.7", price: .init(input: 5, output: 25, cacheRead: 0.5)),
        PricedModel(prefix: "claude-opus-4-6", displayName: "Opus 4.6", price: .init(input: 5, output: 25, cacheRead: 0.5)),
        PricedModel(prefix: "claude-opus-4-5", displayName: "Opus 4.5", price: .init(input: 5, output: 25, cacheRead: 0.5)),
        PricedModel(prefix: "claude-opus-4-1", displayName: "Opus 4.1", price: .init(input: 15, output: 75, cacheRead: 1.5)),
        PricedModel(prefix: "claude-opus-4", displayName: "Opus 4", price: .init(input: 15, output: 75, cacheRead: 1.5)),
        PricedModel(prefix: "claude-sonnet-5-5", displayName: "Sonnet 5.5", price: .init(input: 2, output: 10, cacheRead: 0.2)),
        PricedModel(prefix: "claude-sonnet-5", displayName: "Sonnet 5", price: .init(input: 2, output: 10, cacheRead: 0.2)),
        PricedModel(prefix: "claude-sonnet-4-6", displayName: "Sonnet 4.6", price: .init(input: 3, output: 15, cacheRead: 0.3)),
        PricedModel(prefix: "claude-sonnet-4-5", displayName: "Sonnet 4.5", price: .init(input: 3, output: 15, cacheRead: 0.3)),
        PricedModel(prefix: "claude-sonnet-4", displayName: "Sonnet 4", price: .init(input: 3, output: 15, cacheRead: 0.3)),
        PricedModel(prefix: "claude-3-7-sonnet", displayName: "Sonnet 3.7", price: .init(input: 3, output: 15, cacheRead: 0.3)),
        PricedModel(
            prefix: "claude-haiku-5-5", displayName: "Haiku 5.5", price: .init(input: 0.1, output: 0.5, cacheRead: 0.01),
            longPrompt: .init(input: 0.5, output: 2.5, cacheRead: 0.05)
        ),
        PricedModel(prefix: "claude-haiku-4-5", displayName: "Haiku 4.5", price: .init(input: 1, output: 5, cacheRead: 0.1)),
        PricedModel(prefix: "claude-3-5-haiku", displayName: "Haiku 3.5", price: .init(input: 0.8, output: 4, cacheRead: 0.08)),
    ].sorted { $0.prefix.count > $1.prefix.count }

    /// Strips provider prefixes (`us.anthropic.`) and suffixes (`[1m]`, `@date`) from a model ID.
    public static func normalize(_ model: String) -> String {
        var id = model
        if let range = id.range(of: "claude-") { id = String(id[range.lowerBound...]) }
        if let bracket = id.firstIndex(of: "[") { id = String(id[..<bracket]) }
        if let at = id.firstIndex(of: "@") { id = String(id[..<at]) }
        return id
    }

    public static func pricedModel(for model: String) -> PricedModel? {
        let id = normalize(model)
        return models.first { id.hasPrefix($0.prefix) }
    }

    public static func displayName(for model: String) -> String {
        pricedModel(for: model)?.displayName ?? model
    }

    public static func cost(tokens: TokenCounts, model: String, isFast: Bool) -> CostBreakdown? {
        guard let priced = pricedModel(for: model) else { return nil }
        let prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
        let price = (prompt > priced.longPromptThreshold ? priced.longPrompt : nil) ?? priced.price
        let multiplier = isFast ? (price.fastMultiplier ?? 1) : 1
        let perToken = multiplier / 1_000_000
        return CostBreakdown(
            input: Double(tokens.input) * price.input * perToken,
            output: Double(tokens.output) * price.output * perToken,
            cacheRead: Double(tokens.cacheRead) * price.cacheRead * perToken,
            cacheWrite: (Double(tokens.cacheWrite5m) * price.cacheWrite5m + Double(tokens.cacheWrite1h) * price.cacheWrite1h) * perToken,
            webSearch: Double(tokens.webSearches) * webSearchPerRequest
        )
    }
}
