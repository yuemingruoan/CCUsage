import CCUsageCore
import SwiftUI

struct OverviewView: View {
    @Environment(UsageStore.self) private var store
    let range: DateRange
    @Binding var selection: SidebarItem?

    @State private var granularity: TimeGranularity = .hour
    @State private var metric: ChartMetric = .cost
    @State private var windowKind: QuotaKind = .fiveHour
    @State private var topSessionSelection: String?

    var body: some View {
        let rangeStart = range.start(now: Date())
        let entries = store.snapshot.entries(since: rangeStart)

        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                quotaSection
                summaryTiles(entries: entries)
                chartSection(entries: entries)
                windowSection(rangeStart: rangeStart)
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(title: "按模型")
                    ModelTable(totals: UsageAggregator.modelTotals(entries), scale: store.modelScale(present: Set(store.modelOrder)))
                        .frame(height: 150)
                }
                topSessions(entries: entries)
            }
            .padding(20)
        }
        .navigationTitle("概览 · \(range.label)")
        // "全部" spans from the first recorded request, known once the scan has loaded.
        .task(id: "\(range.rawValue)|\(store.hasLoaded)") {
            let now = Date()
            let start = range.start(now: now) ?? store.snapshot.entries.first?.timestamp ?? now
            granularity = .suggested(for: now.timeIntervalSince(start))
        }
        .onChange(of: topSessionSelection) { _, id in
            if let id { selection = .session(id) }
        }
    }

    private var quotaSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(
                title: "订阅额度",
                subtitle: "百分比与重置时间来自 Claude Code；预估额度 = 已用折算金额 ÷ CC 上报的已用百分比，只取当前套餐的最新数据，CC 上报的百分比也包含 claude.ai 等其他端的用量"
            )
            EqualHeightRow {
                QuotaCard(status: store.quota.status[.fiveHour], kind: .fiveHour)
                QuotaCard(status: store.quota.status[.sevenDay], kind: .sevenDay)
            }
            switch store.modState {
            case .notInstalled, .outdated, .legacyStatusLine:
                ModBanner()
            case .installed:
                if store.quota.statusLineObservationCount == 0 {
                    Label("CC mod 已安装，新开的 Claude Code 会话在下一次响应后开始上报", systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func summaryTiles(entries: ArraySlice<UsageEntry>) -> some View {
        var tokens = TokenCounts()
        var cost = 0.0
        var sessions = Set<String>()
        for entry in entries {
            tokens += entry.tokens
            cost += entry.cost.total
            sessions.insert(entry.sessionId)
        }
        return EqualHeightRow {
            StatTile(title: "折算金额（API 价）", value: Format.usd(cost), caption: range.label)
            StatTile(title: "请求", value: entries.count.formatted(), caption: "\(sessions.count) 个会话")
            StatTile(title: "Tokens", value: Format.tokens(tokens.total),
                     caption: "输入 \(Format.tokens(tokens.input)) · 输出 \(Format.tokens(tokens.output))")
            StatTile(title: "缓存", value: Format.tokens(tokens.cacheRead + tokens.cacheWrite),
                     caption: "读 \(Format.tokens(tokens.cacheRead)) · 写 \(Format.tokens(tokens.cacheWrite))")
        }
    }

    private func chartSection(entries: ArraySlice<UsageEntry>) -> some View {
        let buckets = UsageAggregator.buckets(entries, granularity: granularity) { store.modelSeries(for: $0) }
        return VStack(alignment: .leading, spacing: 10) {
            SectionBar(title: "按时间段", subtitle: "悬停查看每个时间段的明细") {
                ChartControls(metric: $metric, granularity: $granularity)
            }
            UsageChart(
                buckets: buckets,
                scale: store.modelScale(present: Set(buckets.map(\.series))),
                metric: metric,
                granularity: granularity
            )
            .frame(height: 260)
        }
    }

    private func windowSection(rangeStart: Date?) -> some View {
        let windows = (store.quota.windows[windowKind] ?? [])
            .filter { rangeStart == nil || $0.end >= rangeStart! }
            .reversed()
        return VStack(alignment: .leading, spacing: 10) {
            SectionBar(
                title: "额度窗口",
                subtitle: windowKind == .fiveHour
                    ? "5 小时窗口 · \(store.windowMode.label)（可在设置中切换）；“CC 确认”表示重置时间来自 Claude Code"
                    : "每周窗口 · 有 CC 上报时按其重置时间对齐"
            ) {
                Picker("窗口", selection: $windowKind) {
                    ForEach(QuotaKind.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            QuotaWindowTable(windows: Array(windows), kind: windowKind, estimate: store.quota.status[windowKind]?.estimate)
                .frame(height: 240)
        }
    }

    private func topSessions(entries: ArraySlice<UsageEntry>) -> some View {
        var costBySession: [String: Double] = [:]
        for entry in entries { costBySession[entry.sessionId, default: 0] += entry.cost.total }
        let total = max(costBySession.values.reduce(0, +), .leastNonzeroMagnitude)
        let rows = costBySession.sorted { $0.value > $1.value }.prefix(10).map { id, cost in
            TopSessionRow(id: id, session: store.session(id: id), cost: cost, share: cost / total)
        }

        return VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "花费最多的会话", subtitle: "金额为所选时间范围内的部分，点击查看详情")
            Table(rows, selection: $topSessionSelection) {
                TableColumn("会话") { Text($0.session?.title ?? $0.id).lineLimit(1) }
                    .width(min: 200)
                TableColumn("项目") { Text($0.session?.projectName ?? "").foregroundStyle(.secondary) }
                    .width(min: 80, ideal: 120)
                TableColumn("占比") { row in
                    GeometryReader { proxy in
                        RoundedRectangle(cornerRadius: 3)
                            .fill(SeriesPalette.color(at: 0))
                            .frame(width: max(2, proxy.size.width * row.share), height: 8)
                            .frame(maxHeight: .infinity, alignment: .center)
                    }
                }
                .width(min: 100, ideal: 180)
                TableColumn("折算金额") { Text(Format.usd($0.cost)).monospacedDigit() }
                    .width(80)
            }
            .frame(height: 300)
        }
    }
}

private struct TopSessionRow: Identifiable {
    let id: String
    let session: SessionSummary?
    let cost: Double
    let share: Double
}

struct ChartControls: View {
    @Binding var metric: ChartMetric
    @Binding var granularity: TimeGranularity

    var body: some View {
        Picker("指标", selection: $metric) {
            ForEach(ChartMetric.allCases) { Text($0.label).tag($0) }
        }
        .pickerStyle(.segmented)
        Picker("粒度", selection: $granularity) {
            ForEach(TimeGranularity.allCases) { Text("按\($0.label)").tag($0) }
        }
    }
}

struct ModelTable: View {
    let totals: [ModelTotal]
    let scale: SeriesScale

    var body: some View {
        let sum = max(totals.reduce(0) { $0 + $1.cost }, .leastNonzeroMagnitude)
        Table(totals) {
            TableColumn("模型") { total in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2).fill(scale.color(for: total.name)).frame(width: 8, height: 8)
                    Text(total.name)
                    if total.hasUnpricedRequests {
                        Text("无定价").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .width(min: 120)
            TableColumn("请求") { Text("\($0.requestCount)").monospacedDigit() }.width(60)
            TableColumn("输入") { Text(Format.tokens($0.tokens.input)).monospacedDigit() }.width(70)
            TableColumn("输出") { Text(Format.tokens($0.tokens.output)).monospacedDigit() }.width(70)
            TableColumn("缓存读") { Text(Format.tokens($0.tokens.cacheRead)).monospacedDigit() }.width(80)
            TableColumn("缓存写") { Text(Format.tokens($0.tokens.cacheWrite)).monospacedDigit() }.width(80)
            TableColumn("折算金额") { Text(Format.usd($0.cost)).monospacedDigit() }.width(90)
            TableColumn("占比") { Text(($0.cost / sum).formatted(.percent.precision(.fractionLength(1)))).monospacedDigit() }
                .width(min: 60)
        }
    }
}
