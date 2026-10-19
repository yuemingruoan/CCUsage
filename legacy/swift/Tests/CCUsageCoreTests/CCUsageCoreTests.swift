import Foundation
import Testing
@testable import CCUsageCore

private let root = URL(fileURLWithPath: "/tmp/projects")

private func assistantLine(
    id: String, request: String = "req_1", time: String, model: String = "claude-opus-5-5",
    input: Int = 0, output: Int = 0, cacheRead: Int = 0, write5m: Int = 0, write1h: Int = 0,
    session: String = "s1"
) -> String {
    """
    {"type":"assistant","uuid":"u-\(id)-\(output)","sessionId":"\(session)","requestId":"\(request)","timestamp":"\(time)","cwd":"/work/demo","gitBranch":"main","version":"2.1.0","message":{"id":"\(id)","model":"\(model)","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":\(input),"output_tokens":\(output),"cache_read_input_tokens":\(cacheRead),"cache_creation_input_tokens":\(write5m + write1h),"cache_creation":{"ephemeral_5m_input_tokens":\(write5m),"ephemeral_1h_input_tokens":\(write1h)},"server_tool_use":{"web_search_requests":0},"speed":"standard"}}}
    """
}

private func parse(_ lines: [String], path: String = "/tmp/projects/-work-demo/s1.jsonl") -> ParsedTranscript {
    TranscriptParser.parse(data: Data(lines.joined(separator: "\n").utf8), fileURL: URL(fileURLWithPath: path), projectsRoot: root)
}

@Test func pricingMatchesPublishedRates() throws {
    let tokens = TokenCounts(input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000)
    let cost = try #require(Pricing.cost(tokens: tokens, model: "claude-opus-5-5", isFast: false))
    #expect(cost.input == 4)
    #expect(cost.output == 20)
    #expect(abs(cost.cacheRead - 0.2) < 1e-9)
    #expect(cost.cacheWrite == 5 + 8)

    let fast = try #require(Pricing.cost(tokens: TokenCounts(output: 1_000_000), model: "claude-opus-5-5", isFast: true))
    #expect(fast.output == 40)
}

@Test func sonnet55PricingMatchesPublishedRates() throws {
    let tokens = TokenCounts(input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000)
    let cost = try #require(Pricing.cost(tokens: tokens, model: "claude-sonnet-5-5", isFast: false))
    #expect(cost.input == 2)
    #expect(cost.output == 10)
    #expect(abs(cost.cacheRead - 0.2) < 1e-9)
    #expect(cost.cacheWrite == 2.5 + 4)
}

@Test func haiku55PricingMatchesPublishedRates() throws {
    let tokens = TokenCounts(input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000)
    // Prompt is over 100K tokens, so the long-prompt tier applies.
    let long = try #require(Pricing.cost(tokens: tokens, model: "claude-haiku-5-5", isFast: false))
    #expect(long.input == 0.5)
    #expect(long.output == 2.5)
    #expect(abs(long.cacheRead - 0.05) < 1e-9)
    #expect(abs(long.cacheWrite - (0.625 + 1)) < 1e-9)
}

@Test func haiku55ShortPromptUsesBaseTier() throws {
    let tokens = TokenCounts(input: 100_000, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0)
    // Exactly 100K tokens is not "over 100,000", so the base tier applies.
    let atThreshold = try #require(Pricing.cost(tokens: tokens, model: "claude-haiku-5-5", isFast: false))
    #expect(abs(atThreshold.input - 0.01) < 1e-9)
    #expect(atThreshold.output == 0.5)

    // Prompt is 90K tokens (input + cache read), still under the threshold.
    let base = TokenCounts(input: 50_000, output: 1_000_000, cacheRead: 40_000)
    let cost = try #require(Pricing.cost(tokens: base, model: "claude-haiku-5-5", isFast: false))
    #expect(abs(cost.input - 0.005) < 1e-9)
    #expect(abs(cost.cacheRead - 0.0004) < 1e-9)
    #expect(cost.output == 0.5)
}

@Test func haiku55DisplayNameAndHaiku45Unaffected() {
    #expect(Pricing.displayName(for: "claude-haiku-5-5") == "Haiku 5.5")
    #expect(Pricing.displayName(for: "claude-haiku-5-5-20261001") == "Haiku 5.5")
    #expect(Pricing.displayName(for: "claude-haiku-4-5-20251001") == "Haiku 4.5")
    let cost = Pricing.cost(tokens: TokenCounts(input: 1_000_000), model: "claude-haiku-4-5", isFast: false)
    #expect(cost?.input == 1)
}

@Test func modelPrefixesResolveLongestMatch() {
    #expect(Pricing.displayName(for: "claude-opus-5-5") == "Opus 5.5")
    #expect(Pricing.displayName(for: "claude-opus-5") == "Opus 5")
    #expect(Pricing.displayName(for: "claude-haiku-4-5-20251001") == "Haiku 4.5")
    #expect(Pricing.displayName(for: "us.anthropic.claude-sonnet-5[1m]") == "Sonnet 5")
    #expect(Pricing.displayName(for: "claude-sonnet-5-5") == "Sonnet 5.5")
    #expect(Pricing.displayName(for: "us.anthropic.claude-sonnet-5-5[1m]") == "Sonnet 5.5")
    #expect(Pricing.pricedModel(for: "gpt-unknown") == nil)
}

@Test func duplicateContentBlockLinesCountOnce() {
    let transcript = parse([
        assistantLine(id: "m1", time: "2026-09-26T05:33:38.007Z", input: 2, output: 10, write1h: 100),
        assistantLine(id: "m1", time: "2026-09-26T05:33:39.007Z", input: 2, output: 300, write1h: 100),
        assistantLine(id: "m2", request: "req_2", time: "2026-09-26T05:40:00Z", cacheRead: 500, write5m: 7),
    ])
    #expect(transcript.entries.count == 2)
    #expect(transcript.entries[0].tokens.output == 300)
    #expect(transcript.entries[0].tokens.cacheWrite1h == 100)
    #expect(transcript.entries[1].tokens.cacheWrite5m == 7)
    #expect(transcript.metadata.cwd == "/work/demo")
    #expect(transcript.projectDirectory == "-work-demo")
}

@Test func titlesAndFirstPromptAreCollected() {
    let transcript = parse([
        #"{"type":"user","sessionId":"s1","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>x</local-command-caveat>"}}"#,
        #"{"type":"user","sessionId":"s1","message":{"role":"user","content":[{"type":"text","text":"帮我写个 app"}]}}"#,
        #"{"type":"custom-title","customTitle":"Old","sessionId":"s1"}"#,
        #"{"type":"custom-title","customTitle":"New title","sessionId":"s1"}"#,
    ])
    #expect(transcript.metadata.firstPrompt == "帮我写个 app")
    #expect(transcript.metadata.customTitle == "New title")
}

@Test func subagentTranscriptsRollUpIntoParentSession() {
    let main = parse([assistantLine(id: "m1", time: "2026-09-26T01:00:00Z", output: 1_000_000)])
    let sub = parse(
        [assistantLine(id: "m9", request: "req_9", time: "2026-09-26T01:10:00Z", model: "claude-haiku-4-5-20251001", output: 1_000_000)],
        path: "/tmp/projects/-work-demo/s1/subagents/agent-abc.jsonl"
    )
    #expect(sub.agentId == "abc")

    let snapshot = UsageSnapshot.build(transcripts: [sub, main], recordedCosts: ["s1": 12.5])
    #expect(snapshot.sessions.count == 1)
    let session = snapshot.sessions[0]
    #expect(session.cost.total == 20 + 5)
    #expect(session.subagentCost == 5)
    #expect(session.subagentCount == 1)
    #expect(session.recordedCost == 12.5)
    #expect(session.projectName == "demo")
}

