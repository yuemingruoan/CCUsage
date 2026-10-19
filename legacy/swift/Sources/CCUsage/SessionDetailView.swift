import AppKit
import CCUsageCore
import SwiftUI

struct SessionDetailView: View {
    @Environment(UsageStore.self) private var store
    let session: SessionSummary

    @State private var granularity: TimeGranularity = .fifteenMinutes
    @State private var metric: ChartMetric = .cost
    @State private var seriesMode: SeriesMode = .model

    enum SeriesMode: String, CaseIterable, Identifiable {
        case model, agent
        var id: String { rawValue }
        var label: String { self == .model ? "按模型" : "主会话 / 子代理" }
    }

    var body: some View {
        let entries = store.snapshot.entriesBySession[session.id] ?? []
        let buckets = UsageAggregator.buckets(entries, granularity: granularity) { entry in
            switch seriesMode {
            case .model: store.modelSeries(for: entry)
            case .agent: entry.isSubagent ? SeriesName.subagent : SeriesName.main
            }
        }
        let scale = seriesMode == .model
            ? store.modelScale(present: Set(buckets.map(\.series)))
            : SeriesScale.mainVsSubagent

        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                tiles
                costComposition
                VStack(alignment: .leading, spacing: 10) {
                    SectionBar(title: "按时间段", subtitle: "悬停查看明细；下表为同一粒度的逐段数据") {
                        Picker("系列", selection: $seriesMode) {
                            ForEach(SeriesMode.allCases) { Text($0.label).tag($0) }
                        }
                        ChartControls(metric: $metric, granularity: $granularity)
                    }
                    UsageChart(buckets: buckets, scale: scale, metric: metric, granularity: granularity)
                        .frame(height: 240)
                    BucketTable(rows: BucketRow.rows(from: buckets), granularity: granularity)
                        .frame(height: 260)
                }
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(title: "按模型")
                    ModelTable(totals: UsageAggregator.modelTotals(entries), scale: store.modelScale(present: Set(store.modelOrder)))
                        .frame(height: 140)
                }
            }
            .padding(20)
        }
        .navigationTitle(session.title)
        .task(id: session.id) {
            granularity = .suggested(for: session.end.timeIntervalSince(session.start))
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(session.title).font(.title2.weight(.semibold)).lineLimit(2).textSelection(.enabled)
            HStack(spacing: 12) {
                Label(session.cwd ?? session.projectName, systemImage: "folder")
                if let branch = session.gitBranch {
                    Label(branch, systemImage: "arrow.triangle.branch")
                }
                if let version = session.version {
                    Label("v\(version)", systemImage: "terminal")
                }
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Text(session.id).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                Button("复制 resume 命令", systemImage: "doc.on.doc") {
                    var command = "claude --resume \(session.id)"
                    if let cwd = session.cwd { command = "cd \(shellQuoted(cwd)) && \(command)" }
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(command, forType: .string)
                }
                .buttonStyle(.borderless)
                .font(.caption)
            }
        }
    }

    private var tiles: some View {
        EqualHeightRow {
                StatTile(
                    title: "折算金额（API 价）",
                    value: Format.usd(session.cost.total),
                    caption: session.subagentCount > 0
                        ? "含 \(session.subagentCount) 个子代理 \(Format.usd(session.subagentCost))"
                        : (session.hasUnpricedRequests ? "部分模型无定价，未计入" : nil)
                )
                if let recorded = session.recordedCost {
                    StatTile(title: "CC 记录的 lastCost", value: Format.usd(recorded),
                             caption: "来自 ~/.claude.json，CC 进程最后一次退出时写入")
                }
                StatTile(title: "Tokens", value: Format.tokens(session.tokens.total),
                         caption: "\(session.requestCount) 次请求")
                StatTile(title: "时长", value: Format.duration(session.end.timeIntervalSince(session.start)),
                         caption: "\(Format.dateTime(session.start)) – \(Format.dateTime(session.end))")
        }
    }

    private var costComposition: some View {
        let cost = session.cost
        let tokens = session.tokens
        let rows: [(String, String, Double)] = [
            ("输入", Format.tokens(tokens.input), cost.input),
            ("输出", Format.tokens(tokens.output), cost.output),
            ("缓存读取", Format.tokens(tokens.cacheRead), cost.cacheRead),
            ("缓存写入", "\(Format.tokens(tokens.cacheWrite5m)) 5m · \(Format.tokens(tokens.cacheWrite1h)) 1h", cost.cacheWrite),
            ("网页搜索", "\(tokens.webSearches) 次", cost.webSearch),
        ]
        let total = max(cost.total, .leastNonzeroMagnitude)
        return VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "费用构成")
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                ForEach(rows, id: \.0) { name, amount, value in
                    GridRow {
                        Text(name).foregroundStyle(.secondary)
                        Text(amount).monospacedDigit()
                        Text(Format.usd(value)).monospacedDigit().gridColumnAlignment(.trailing)
                        GeometryReader { proxy in
                            RoundedRectangle(cornerRadius: 3)
                                .fill(SeriesPalette.color(at: 0))
                                .frame(width: max(value > 0 ? 2 : 0, proxy.size.width * value / total), height: 8)
                                .frame(maxHeight: .infinity, alignment: .center)
                        }
                        .frame(height: 14)
                        Text((value / total).formatted(.percent.precision(.fractionLength(1))))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .gridColumnAlignment(.trailing)
                    }
                }
            }
        }
    }

    private func shellQuoted(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
