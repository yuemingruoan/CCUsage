import CCUsageCore
import Charts
import SwiftUI

/// One line per series over the time buckets, with a hover tooltip listing each series.
struct UsageChart: View {
    let scale: SeriesScale
    let metric: ChartMetric
    let granularity: TimeGranularity
    private let columns: [Column]
    private let points: [Point]
    private let markers: [Point]

    @State private var hoverDate: Date?

    private struct Point: Identifiable {
        let id: String
        let start: Date
        let series: String
        let value: Double
        /// False for a zero added in an idle bucket.
        let isUsage: Bool
    }

    private struct Column {
        let start: Date
        let parts: [UsageBucket]
        var total: Double
    }

    /// Markers on every bucket stay readable up to this many buckets.
    private static let maxMarkedColumns = 31

    // Derived once here: the body runs again on every hover move.
    init(buckets: [UsageBucket], scale: SeriesScale, metric: ChartMetric, granularity: TimeGranularity) {
        self.scale = scale
        self.metric = metric
        self.granularity = granularity

        let order = Dictionary(uniqueKeysWithValues: scale.domain.enumerated().map { ($1, $0) })
        columns = Dictionary(grouping: buckets, by: \.start)
            .map { start, parts in
                let sorted = parts.sorted { (order[$0.series] ?? .max) < (order[$1.series] ?? .max) }
                return Column(start: start, parts: sorted, total: sorted.reduce(0) { $0 + metric.value($1) })
            }
            .sorted { $0.start < $1.start }
        let points = Self.points(buckets, metric: metric, granularity: granularity)
        self.points = points
        markers = columns.count <= Self.maxMarkedColumns ? points.filter(\.isUsage) : []
    }

    /// A point per bucket, with every series at zero in its idle buckets across the whole
    /// chart. Only the zeros a line turns at are added: both ends of the chart and the
    /// buckets next to usage.
    private static func points(_ buckets: [UsageBucket], metric: ChartMetric, granularity: TimeGranularity) -> [Point] {
        guard let first = buckets.map(\.start).min(), let last = buckets.map(\.start).max() else { return [] }
        return Dictionary(grouping: buckets, by: \.series).flatMap { series, parts -> [Point] in
            var values = Dictionary(uniqueKeysWithValues: parts.map { ($0.start, (value: metric.value($0), isUsage: true)) })
            let turns = parts.flatMap { [granularity.bucketStart(for: $0.start.addingTimeInterval(-1)), $0.end] }
            for start in [first, last] + turns where first...last ~= start && values[start] == nil {
                values[start] = (0, false)
            }
            return values.sorted { $0.key < $1.key }.map { start, point in
                Point(id: "\(start.timeIntervalSinceReferenceDate)|\(series)", start: start, series: series,
                      value: point.value, isUsage: point.isUsage)
            }
        }
    }

    var body: some View {
        let hovered = hoverDate.flatMap { date in
            columns.min { abs($0.start.timeIntervalSince(date)) < abs($1.start.timeIntervalSince(date)) }
        }

        Chart {
            ForEach(points) { point in
                LineMark(x: .value("时间", point.start), y: .value(metric.label, point.value))
                    .foregroundStyle(by: .value("系列", point.series))
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            ForEach(markers) { point in
                PointMark(x: .value("时间", point.start), y: .value(metric.label, point.value))
                    .foregroundStyle(by: .value("系列", point.series))
                    .symbolSize(28)
            }
            if let hovered {
                RuleMark(x: .value("时间", hovered.start))
                    .foregroundStyle(.secondary.opacity(0.35))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        tooltip(for: hovered)
                    }
                ForEach(hovered.parts) { part in
                    PointMark(x: .value("时间", hovered.start), y: .value(metric.label, metric.value(part)))
                        .foregroundStyle(by: .value("系列", part.series))
                        .symbolSize(64)
                }
            }
        }
        .chartForegroundStyleScale(domain: scale.domain, range: scale.range)
        .chartLegend(position: .top, alignment: .leading)
        .chartXSelection(value: $hoverDate)
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine().foregroundStyle(.quaternary)
                AxisValueLabel {
                    if let number = value.as(Double.self) { Text(metric.format(number)) }
                }
            }
        }
        .chartXAxis {
            AxisMarks { _ in
                AxisGridLine().foregroundStyle(.clear)
                AxisTick()
                AxisValueLabel()
            }
        }
        .overlay {
            if points.isEmpty {
                Text("该时间范围内没有用量").foregroundStyle(.secondary)
            }
        }
    }

    private func tooltip(for column: Column) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(Format.bucketRange(column.start, granularity: granularity))
                .font(.caption.weight(.semibold))
                .monospacedDigit()
            ForEach(column.parts.reversed(), id: \.id) { part in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2).fill(scale.color(for: part.series)).frame(width: 8, height: 8)
                    Text(part.series)
                    Spacer(minLength: 12)
                    Text(metric.format(metric.value(part))).monospacedDigit()
                }
                .font(.caption)
            }
            Divider()
            HStack {
                Text("合计 · \(column.parts.reduce(0) { $0 + $1.requestCount }) 次请求")
                Spacer(minLength: 12)
                Text(metric.format(column.total)).monospacedDigit()
            }
            .font(.caption.weight(.semibold))
        }
        .padding(8)
        .frame(minWidth: 180)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
        .shadow(radius: 2)
    }
}

/// One row per time bucket, all series combined.
struct BucketRow: Identifiable {
    let start: Date
    let tokens: TokenCounts
    let cost: Double
    let requestCount: Int

    var id: Date { start }

    static func rows(from buckets: [UsageBucket]) -> [BucketRow] {
        Dictionary(grouping: buckets, by: \.start)
            .map { start, parts in
                var tokens = TokenCounts()
                parts.forEach { tokens += $0.tokens }
                return BucketRow(
                    start: start, tokens: tokens,
                    cost: parts.reduce(0) { $0 + $1.cost },
                    requestCount: parts.reduce(0) { $0 + $1.requestCount }
                )
            }
            .sorted { $0.start > $1.start }
    }
}

struct BucketTable: View {
    let rows: [BucketRow]
    let granularity: TimeGranularity

    var body: some View {
        Table(rows) {
            TableColumn("时间段") { Text(Format.bucketLabel($0.start, granularity: granularity)).monospacedDigit() }
                .width(min: 140)
            TableColumn("请求") { Text("\($0.requestCount)").monospacedDigit() }
                .width(60)
            TableColumn("输入") { Text(Format.tokens($0.tokens.input)).monospacedDigit() }
                .width(70)
            TableColumn("输出") { Text(Format.tokens($0.tokens.output)).monospacedDigit() }
                .width(70)
            TableColumn("缓存读") { Text(Format.tokens($0.tokens.cacheRead)).monospacedDigit() }
                .width(80)
            TableColumn("缓存写") { Text(Format.tokens($0.tokens.cacheWrite)).monospacedDigit() }
                .width(80)
            TableColumn("折算金额") { Text(Format.usd($0.cost)).monospacedDigit() }
                .width(min: 80)
        }
    }
}
