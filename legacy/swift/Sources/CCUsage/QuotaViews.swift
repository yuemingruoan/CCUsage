import CCUsageCore
import SwiftUI

enum QuotaLevel {
    case normal, warning, critical

    init(percentage: Double) {
        switch percentage {
        case ..<75: self = .normal
        case ..<90: self = .warning
        default: self = .critical
        }
    }

    var color: Color {
        switch self {
        case .normal: SeriesPalette.color(at: 0)
        case .warning: .orange
        case .critical: .red
        }
    }

    var icon: String? {
        switch self {
        case .normal: nil
        case .warning: "exclamationmark.triangle.fill"
        case .critical: "xmark.octagon.fill"
        }
    }
}

struct QuotaBar: View {
    let percentage: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(QuotaLevel(percentage: percentage).color)
                    .frame(width: proxy.size.width * min(max(percentage, 0), 100) / 100)
            }
        }
        .frame(height: 8)
        .accessibilityLabel("已用 \(Int(percentage))%")
    }
}

/// Current 5-hour or weekly window: usage percentage, reset countdown and projection.
struct QuotaCard: View {
    let status: QuotaStatus?
    let kind: QuotaKind
    var compact = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            content(now: context.date)
        }
        .padding(compact ? 10 : 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        VStack(alignment: .leading, spacing: compact ? 8 : 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(kind.label)额度").font(compact ? .subheadline.weight(.semibold) : .headline)
                Spacer()
                if let window = status?.window {
                    Text("\(Self.resetText(window.end, kind: kind)) 重置 · 还有 \(Format.duration(window.end.timeIntervalSince(now)))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }

            if let status, let window = status.window {
                metrics(status: status, window: window, now: now)
                QuotaBar(percentage: status.percentage ?? 0)
                if !compact {
                    Text(footnote(status: status, window: window))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(kind == .fiveHour ? "没有进行中的窗口，下一条请求将开启新窗口" : "暂无本周窗口数据")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                QuotaBar(percentage: 0)
            }
        }
    }

    /// Used / limit / remaining side by side, each with a one-line explanation.
    private func metrics(status: QuotaStatus, window: QuotaWindow, now: Date) -> some View {
        let limit = status.estimate?.cost
        let percentage = status.percentage
        let level = percentage.map(QuotaLevel.init(percentage:))

        let used = Metric(
            title: "已用",
            value: percentage.map { "\(Int($0.rounded()))%" } ?? "—",
            detail: "折算 \(Format.usd(window.costSinceReset))",
            icon: level?.icon, iconColor: level?.color
        )
        let limitMetric: Metric
        if let limit, let sample = status.estimate?.sample {
            limitMetric = Metric(title: "限额（预估）", value: "≈ \(Format.usd(limit))",
                                 detail: "\(Format.usd(sample.cost)) ÷ \(Int(sample.usedPercentage.rounded()))%")
        } else if let lowerBound = status.estimate?.lowerBound, lowerBound > window.costSinceReset + 0.005 {
            limitMetric = Metric(title: "限额（预估）", value: "未知", detail: "至少 \(Format.usd(lowerBound))")
        } else {
            limitMetric = Metric(title: "限额（预估）", value: "未知", detail: "等待 CC 上报百分比")
        }
        let remaining: Metric
        if let limit, let percentage {
            remaining = Metric(title: "剩余", value: "≈ \(Format.usd(max(limit * (1 - percentage / 100), 0)))",
                               detail: projection(status: status, now: now))
        } else {
            remaining = Metric(title: "剩余", value: "—", detail: "速率 \(Format.usd(status.burnRatePerHour))/小时")
        }

        return HStack(alignment: .top, spacing: 12) {
            ForEach([used, limitMetric, remaining], id: \.title) { metric in
                VStack(alignment: .leading, spacing: 2) {
                    Text(metric.title).font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 4) {
                        if let icon = metric.icon {
                            Image(systemName: icon).foregroundStyle(metric.iconColor ?? .primary)
                        }
                        Text(metric.value)
                            .font(.system(size: compact ? 17 : 24, weight: .semibold))
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    Text(metric.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private struct Metric {
        let title: String
        let value: String
        let detail: String
        var icon: String? = nil
        var iconColor: Color? = nil
    }

    private func projection(status: QuotaStatus, now: Date) -> String {
        if let date = status.exhaustionDate {
            return date <= now ? "已用尽" : "约 \(Self.resetText(date, kind: kind)) 用尽"
        }
        return status.burnRatePerHour > 0 ? "按当前速率够用到重置" : "近期无用量"
    }

    private func footnote(status: QuotaStatus, window: QuotaWindow) -> String {
        let range = "窗口 \(Format.windowStart(window.start, kind: kind)) – \(Self.resetText(window.end, kind: kind))"
        let source = window.isConfirmed ? "重置时间来自 CC" : "重置时间为推断"
        let reset = window.resetAt.map { "CC 于 \(Format.dateTime($0)) 后提前重置，此前的 \(Format.usd(window.costBeforeReset)) 不计入" }
        if let observation = status.latestObservation {
            let reported = "CC 上报 \(Int(observation.usedPercentage.rounded()))%（\(Format.dateTime(observation.observedAt))）"
            return [range, source, reset, reported, status.percentageIsReported ? nil : "之后的用量按预估限额折算"]
                .compactMap { $0 }.joined(separator: " · ")
        }
        return [range, source, reset, "尚无 CC 上报的百分比"].compactMap { $0 }.joined(separator: " · ")
    }

    static func resetText(_ date: Date, kind: QuotaKind) -> String {
        if kind == .fiveHour, Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return Format.dateTime(date)
    }
}

/// Offers to install the recorder mod into Claude Code, or to bring it up to date.
struct ModBanner: View {
    @Environment(UsageStore.self) private var store
    @State private var confirming = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "link.badge.plus").font(.title2).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.callout.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button("\(action)…") { confirming = true }
        }
        .padding(12)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
        .confirmationDialog("\(action) Claude Code mod？", isPresented: $confirming) {
            Button(action) { store.installMod() }
        } message: {
            Text(confirmationText)
        }
    }

    private var action: String {
        switch store.modState {
        case .outdated: "更新"
        case .legacyStatusLine: "升级"
        case .notInstalled, .installed: "安装"
        }
    }

    private var title: String {
        switch store.modState {
        case .outdated: "CC mod 有更新"
        case .legacyStatusLine: "升级为 CC mod，不再占用 Claude Code 的状态栏命令"
        case .notInstalled, .installed: "安装 CC mod，获取精确的重置时间和用量百分比"
        }
    }

    private var detail: String {
        switch store.modState {
        case .outdated:
            "已安装的 mod 与本版本自带的不一致。"
        case .legacyStatusLine:
            "订阅额度目前由旧版的状态栏脚本记录。升级后改由 mod 记录，settings.json 的 statusLine 恢复为你原先的命令。"
        case .notInstalled, .installed:
            "Claude Code 每轮对话后会测得订阅额度（5 小时 / 每周的已用百分比与重置时间）。安装后由一个 mod 把它记录下来供本 app 读取，并显示在输入框下方。当前窗口时间仅由请求记录和撞限提示推断。"
        }
    }

    private var confirmationText: String {
        var text = "将把 mod 写入 \(store.modInstaller.modURL.path)，新开的 Claude Code 会话会自动加载它（ccusage@skills-dir）。"
        if store.modState == .legacyStatusLine {
            text += "\n\n同时会修改 \(store.modInstaller.settingsURL.path) 的 statusLine（原文件会先备份）：恢复旧脚本接管前的命令，没有则移除该项。"
        }
        return text
    }
}

struct QuotaWindowTable: View {
    let windows: [QuotaWindow]
    let kind: QuotaKind
    let estimate: LimitEstimate?

    var body: some View {
        let now = Date()
        Table(windows) {
            TableColumn("窗口") { window in
                HStack(spacing: 6) {
                    Text("\(Format.windowStart(window.start, kind: kind)) – \(Format.windowEnd(window.end, start: window.start, kind: kind))")
                        .monospacedDigit()
                    if window.contains(now) {
                        Text("进行中")
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .background(.quaternary, in: Capsule())
                    }
                }
            }
            .width(min: 210)
            TableColumn("来源") { Text($0.isConfirmed ? "CC 确认" : "推断").foregroundStyle($0.isConfirmed ? .primary : .secondary) }
                .width(64)
            TableColumn("请求") { Text("\($0.requestCount)").monospacedDigit() }.width(56)
            TableColumn("会话") { Text("\($0.sessionIds.count)").monospacedDigit() }.width(44)
            TableColumn("Tokens") { Text(Format.tokens($0.tokens.total)).monospacedDigit() }.width(72)
            TableColumn("折算金额") { Text(Format.usd($0.cost)).monospacedDigit() }.width(80)
            TableColumn("CC 最高") { window in
                Text(window.maxObservedPercentage.map { "\(Int($0.rounded()))%" } ?? "—").monospacedDigit()
            }
            .width(60)
            TableColumn("预估占比") { window in
                Text(estimate?.cost.map { "≈ \(Int((window.costSinceReset / $0 * 100).rounded()))%" } ?? "—")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            .width(min: 64)
        }
    }
}
