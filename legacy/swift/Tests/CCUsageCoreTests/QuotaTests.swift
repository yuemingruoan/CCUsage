import Foundation
import Testing
@testable import CCUsageCore

private func date(_ text: String) -> Date { try! Date(text, strategy: .iso8601) }

private func entry(_ time: String, cost: Double = 1, index: Int) -> UsageEntry {
    // Haiku 4.5 output is $5 per million tokens.
    UsageEntry(id: "e\(index)", sessionId: "s", timestamp: date(time), model: "claude-haiku-4-5",
               tokens: TokenCounts(output: Int(cost * 200_000)))
}

private func entries(_ times: [String], cost: Double = 1) -> [UsageEntry] {
    times.enumerated().map { entry($1, cost: cost, index: $0) }
}

@Test func limitMessageResolvesNextLocalResetTime() throws {
    let event = LimitEvent(timestamp: date("2026-09-24T11:09:37Z"), text: "You've hit your session limit · resets 10:10pm (Asia/Singapore)")
    let observation = try #require(LimitMessageParser.observation(from: event))
    #expect(observation.kind == .fiveHour)
    #expect(observation.resetsAt == date("2026-09-24T14:10:00Z"))
    #expect(observation.usedPercentage == 100)

    let weekly = LimitEvent(timestamp: date("2026-09-24T11:00:00Z"), text: "You've hit your weekly limit · resets Mon 9am (UTC)")
    #expect(LimitMessageParser.observation(from: weekly)?.resetsAt == date("2026-09-28T09:00:00Z"))
    let opus = LimitEvent(timestamp: date("2026-09-24T11:00:00Z"), text: "You've hit your Opus weekly limit · resets Mon 9am (UTC)")
    #expect(LimitMessageParser.observation(from: opus) == nil)
}

@Test func firstRequestWindowsMatchObservedResets() {
    // Real history: first request 09:12 -> reset ~14:10; next request 14:23 -> reset ~19:20.
    let usage = entries(["2026-09-24T09:12:07Z", "2026-09-24T11:06:02Z", "2026-09-24T14:23:23Z", "2026-09-24T15:50:00Z"])
    let windows = QuotaCalculator.windows(kind: .fiveHour, entries: usage, observations: [], mode: .firstRequest, now: date("2026-09-25T00:00:00Z"))
    #expect(windows.map(\.start) == [date("2026-09-24T09:12:00Z"), date("2026-09-24T14:23:00Z")])
    #expect(windows.map(\.requestCount) == [2, 2])
    #expect(windows.allSatisfy { !$0.isConfirmed })
}

@Test func reportedResetTimesTakePrecedence() {
    let usage = entries(["2026-09-24T09:12:07Z", "2026-09-24T11:06:02Z", "2026-09-24T14:23:23Z"])
    let anchor = QuotaObservation(kind: .fiveHour, observedAt: date("2026-09-24T11:09:37Z"),
                                  resetsAt: date("2026-09-24T14:10:00Z"), usedPercentage: 100, source: .limitMessage)
    let windows = QuotaCalculator.windows(kind: .fiveHour, entries: usage, observations: [anchor], mode: .firstRequest)
    #expect(windows[0].start == date("2026-09-24T09:10:00Z"))
    #expect(windows[0].isConfirmed)
    #expect(windows[0].requestCount == 2)
    #expect(windows[1].start == date("2026-09-24T14:23:00Z"))
}

@Test func fixedRollingRepeatsFromLatestReset() {
    let usage = entries(["2026-09-24T20:05:00Z"])
    let anchor = QuotaObservation(kind: .fiveHour, observedAt: date("2026-09-24T12:00:00Z"),
                                  resetsAt: date("2026-09-24T14:10:00Z"), usedPercentage: 40, source: .statusLine)
    let windows = QuotaCalculator.windows(kind: .fiveHour, entries: usage, observations: [anchor], mode: .fixedRolling,
                                          now: date("2026-09-24T20:30:00Z"))
    #expect(windows.map(\.start) == [date("2026-09-24T09:10:00Z"), date("2026-09-24T19:10:00Z")])
}

@Test func statusExtrapolatesFromReportedPercentage() throws {
    let usage = entries(["2026-09-26T10:00:00Z", "2026-09-26T10:30:00Z", "2026-09-26T11:00:00Z"], cost: 10)
    let report = QuotaObservation(kind: .fiveHour, observedAt: date("2026-09-26T10:45:00Z"),
                                  resetsAt: date("2026-09-26T15:00:00Z"), usedPercentage: 20, source: .statusLine)
    let now = date("2026-09-26T11:10:00Z")
    let windows = QuotaCalculator.windows(kind: .fiveHour, entries: usage, observations: [report], mode: .firstRequest, now: now)
    #expect(windows.count == 1)
    // $20 spent by the 20% report -> 100% ≈ $100.
    #expect(abs((windows[0].latestSample?.impliedLimit ?? 0) - 100) < 1e-6)

    let status = QuotaCalculator.status(kind: .fiveHour, windows: windows, entries: usage, now: now)
    #expect(abs((status.percentage ?? 0) - 30) < 1e-6)
    #expect(!status.percentageIsReported)
}

private func window(start: String, cost: Double, fitted: Double? = nil, hit: Bool = false) -> QuotaWindow {
    var window = QuotaWindow(kind: .fiveHour, start: date(start), isConfirmed: false)
    window.cost = cost
    window.latestSample = fitted.map { LimitSample(observedAt: date(start), usedPercentage: 50, cost: $0 / 2) }
    if hit {
        window.observations = [QuotaObservation(kind: .fiveHour, observedAt: date(start), resetsAt: window.end,
                                                usedPercentage: 100, source: .limitMessage)]
    }
    return window
}

@Test func upgradeDropsOlderSamples() throws {
    let windows = [
        window(start: "2026-09-24T09:00:00Z", cost: 40, fitted: 40, hit: true),
        window(start: "2026-09-24T14:00:00Z", cost: 44, fitted: 44, hit: true),
        window(start: "2026-09-25T09:00:00Z", cost: 84),
        window(start: "2026-09-25T14:00:00Z", cost: 110),
    ]
    let estimate = try #require(QuotaCalculator.estimate(from: windows))
    #expect(estimate.cost == nil)
    #expect(estimate.lowerBound == 110)
    #expect(estimate.planChange == PlanChange(date: date("2026-09-25T09:00:00Z"), kind: .inferredUpgrade))
}

@Test func downgradeStartsNewPeriod() throws {
    let windows = [
        window(start: "2026-09-24T09:00:00Z", cost: 150),
        window(start: "2026-09-24T14:00:00Z", cost: 100, fitted: 200),
        window(start: "2026-09-25T09:00:00Z", cost: 40, fitted: 45, hit: true),
    ]
    let estimate = try #require(QuotaCalculator.estimate(from: windows))
    #expect(estimate.cost == 45)
    #expect(estimate.planChange?.kind == .inferredDowngrade)
}

@Test func recordedTierChangeExcludesEarlierWindows() throws {
    let windows = [
        window(start: "2026-09-24T09:00:00Z", cost: 40, fitted: 40, hit: true),
        window(start: "2026-09-25T09:00:00Z", cost: 30, fitted: 150),
    ]
    let change = PlanChange(date: date("2026-09-25T00:00:00Z"), kind: .recorded(from: "default_claude_pro", to: "default_claude_max_5x"))
    let estimate = try #require(QuotaCalculator.estimate(from: windows, planChanges: [change]))
    #expect(estimate.cost == 150)
    #expect(estimate.planChange == change)
    #expect(PlanInfo.displayName(forTier: "default_claude_max_5x") == "Max 5x")
}

@Test func latestSampleOfPlanWinsOverOlderOnes() throws {
    let windows = [
        window(start: "2026-09-25T09:00:00Z", cost: 50, fitted: 100),
        window(start: "2026-09-25T14:00:00Z", cost: 60, fitted: 110),
        window(start: "2026-09-25T19:00:00Z", cost: 20),
    ]
    let estimate = try #require(QuotaCalculator.estimate(from: windows))
    #expect(abs((estimate.cost ?? 0) - 110) < 1e-9)
    #expect(estimate.planChange == nil)
}

private func report(_ kind: QuotaKind, _ time: String, resets: String, _ percentage: Double, session: String = "a") -> QuotaObservation {
    QuotaObservation(kind: kind, observedAt: date(time), resetsAt: date(resets), usedPercentage: percentage,
                     source: .statusLine, sessionId: session)
}

// Real history: Max 5x -> 20x reset both counters around 13:02Z, but the tier change was
// recorded with a profile fetch time of 08:56Z.
private let upgrade = PlanChange(date: date("2026-10-07T08:56:53Z"),
                                 kind: .recorded(from: "default_claude_max_5x", to: "default_claude_max_20x"))

@Test func weeklyResetWithinWindowStartsNewPlanPeriod() throws {
    let usage = entries(["2026-10-07T12:00:00Z", "2026-10-07T12:30:00Z", "2026-10-07T13:10:00Z", "2026-10-07T13:20:00Z"], cost: 10)
    let resets = "2026-10-13T05:00:00Z"
    let observations = [
        report(.sevenDay, "2026-10-07T12:31:00Z", resets: resets, 37),
        // A stale idle session dipping by one point is not a reset.
        report(.sevenDay, "2026-10-07T12:40:00Z", resets: resets, 36, session: "idle"),
        report(.sevenDay, "2026-10-07T13:01:36Z", resets: resets, 37),
        report(.sevenDay, "2026-10-07T13:04:22Z", resets: resets, 0),
        report(.sevenDay, "2026-10-07T13:25:00Z", resets: resets, 4),
    ]
    let now = date("2026-10-07T13:30:00Z")
    let windows = QuotaCalculator.windows(kind: .sevenDay, entries: usage, observations: observations, mode: .fixedRolling, now: now)
    let window = try #require(windows.last { $0.contains(now) })
    #expect(window.resetAt == date("2026-10-07T13:01:36Z"))
    #expect(window.cost == 40)
    #expect(window.costSinceReset == 20)
    // $20 spent after the reset by the 4% report -> 100% ≈ $500.
    #expect(abs((window.latestSample?.impliedLimit ?? 0) - 500) < 1e-6)

    let estimate = try #require(QuotaCalculator.estimate(from: windows, planChanges: [upgrade]))
    #expect(abs((estimate.cost ?? 0) - 500) < 1e-6)
    #expect(estimate.planChange?.date == date("2026-10-07T13:01:36Z"))
}

@Test func earlyFiveHourResetCutsPreviousWindow() throws {
    let usage = entries(["2026-10-07T11:40:30Z", "2026-10-07T12:30:00Z", "2026-10-07T13:01:00Z", "2026-10-07T13:10:00Z"], cost: 10)
    let observations = [
        report(.fiveHour, "2026-10-07T12:31:00Z", resets: "2026-10-07T16:40:00Z", 12),
        report(.fiveHour, "2026-10-07T13:01:36Z", resets: "2026-10-07T16:40:00Z", 18),
        report(.fiveHour, "2026-10-07T13:04:22Z", resets: "2026-10-07T18:00:00Z", 0),
        report(.fiveHour, "2026-10-07T13:08:53Z", resets: "2026-10-07T18:00:00Z", 1, session: "b"),
    ]
    let now = date("2026-10-07T13:15:00Z")
    let windows = QuotaCalculator.windows(kind: .fiveHour, entries: usage, observations: observations, mode: .firstRequest, now: now)
    #expect(windows.map(\.start) == [date("2026-10-07T11:40:00Z"), date("2026-10-07T13:00:00Z")])
    #expect(windows.allSatisfy { $0.isConfirmed })
    #expect(windows[0].end == date("2026-10-07T13:00:00Z"))
    #expect(windows[0].observations.count == 2)
    #expect(windows[1].resetAt == date("2026-10-07T13:01:36Z"))
    #expect(windows[1].costSinceReset == 10)

    // The 5x sample of the cut window no longer sets the 20x limit.
    let status = QuotaCalculator.status(kind: .fiveHour, windows: windows, entries: usage, planChanges: [upgrade], now: now)
    #expect(status.window?.start == date("2026-10-07T13:00:00Z"))
    #expect(status.estimate?.cost == nil)
    #expect(status.estimate?.lowerBound == 10)
    #expect(status.percentage == 1)
    #expect(status.percentageIsReported)
}

@Test func recordedChangeFarFromAnyResetKeepsItsDate() throws {
    var window = QuotaWindow(kind: .fiveHour, start: date("2026-09-25T09:00:00Z"), isConfirmed: true)
    window.resetAt = date("2026-09-25T10:00:00Z")
    window.cost = 30
    let change = PlanChange(date: date("2026-09-27T00:00:00Z"), kind: .recorded(from: "default_claude_pro", to: "default_claude_max_5x"))
    #expect(QuotaCalculator.estimate(from: [window], planChanges: [change]) == nil)
}
