import AppKit
import CCUsageCore
import SwiftUI

enum Format {
    static func usd(_ value: Double) -> String {
        let digits = value != 0 && abs(value) < 1 ? 3 : 2
        return value.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US")).precision(.fractionLength(digits)))
    }

    static func tokens(_ value: Int) -> String {
        let v = Double(value)
        switch abs(v) {
        case 1_000_000_000...: return String(format: "%.2fB", v / 1_000_000_000)
        case 1_000_000...: return String(format: "%.1fM", v / 1_000_000)
        case 1_000...: return String(format: "%.1fK", v / 1_000)
        default: return "\(value)"
        }
    }

    static func duration(_ interval: TimeInterval) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = interval >= 86400 ? [.day, .hour] : [.hour, .minute]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        return formatter.string(from: max(interval, 60)) ?? ""
    }

    static func dateTime(_ date: Date) -> String {
        date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    static func bucketLabel(_ start: Date, granularity: TimeGranularity) -> String {
        switch granularity {
        case .fiveMinutes, .fifteenMinutes, .hour: dateTime(start)
        case .day: start.formatted(.dateTime.year().month(.twoDigits).day(.twoDigits))
        case .week: "\(start.formatted(.dateTime.year().month(.twoDigits).day(.twoDigits))) 起一周"
        }
    }

    /// The period a bucket covers, e.g. "10/12 14:00 – 14:15".
    static func bucketRange(_ start: Date, granularity: TimeGranularity) -> String {
        let end = granularity.bucketEnd(forStart: start)
        let endText = Calendar.current.isDate(end, inSameDayAs: start)
            ? end.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
            : dateTime(end)
        return "\(dateTime(start)) – \(endText)"
    }

    static func windowStart(_ start: Date, kind: QuotaKind) -> String {
        kind == .fiveHour
            ? dateTime(start)
            : start.formatted(.dateTime.month(.twoDigits).day(.twoDigits).weekday(.abbreviated).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    static func windowEnd(_ end: Date, start: Date, kind: QuotaKind) -> String {
        Calendar.current.isDate(end, inSameDayAs: start)
            ? end.formatted(date: .omitted, time: .shortened)
            : windowStart(end, kind: kind)
    }
}

/// Categorical series colors (fixed order, light/dark steps of the same hues).
enum SeriesPalette {
    private static let steps: [(light: UInt32, dark: UInt32)] = [
        (0x2A78D6, 0x3987E5), // blue
        (0xEB6834, 0xD95926), // orange
        (0x1BAF7A, 0x199E70), // aqua
        (0xEDA100, 0xC98500), // yellow
        (0xE87BA4, 0xD55181), // magenta
        (0x008300, 0x008300), // green
        (0x4A3AA7, 0x9085E9), // violet
        (0xE34948, 0xE66767), // red
    ]

    static let maxSeries = steps.count
    static let otherName = "其他"
    static let otherColor = Color(nsColor: .tertiaryLabelColor)

    static func color(at index: Int) -> Color {
        guard index < steps.count else { return otherColor }
        let step = steps[index]
        return Color(nsColor: NSColor(name: nil) { appearance in
            let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(hex: dark ? step.dark : step.light)
        })
    }

}

/// Ordered series names with their colors, for `chartForegroundStyleScale`.
struct SeriesScale {
    var domain: [String] = []
    var range: [Color] = []

    static let mainVsSubagent = SeriesScale(
        domain: [SeriesName.main, SeriesName.subagent],
        range: [SeriesPalette.color(at: 0), SeriesPalette.color(at: 1)]
    )

    func color(for series: String) -> Color {
        domain.firstIndex(of: series).map { range[$0] } ?? SeriesPalette.otherColor
    }
}

enum SeriesName {
    static let main = "主会话"
    static let subagent = "子代理"
}

private extension NSColor {
    convenience init(hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

struct StatTile: View {
    let title: String
    let value: String
    var caption: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title2.weight(.semibold)).monospacedDigit()
            if let caption {
                Text(caption).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Lays children out with equal widths and the height of the tallest child.
struct EqualHeightRow<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .top, spacing: spacing) { content }
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Section title on the left, controls on the right, baseline-aligned.
struct SectionBar<Controls: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder let controls: Controls

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            SectionHeader(title: title, subtitle: subtitle)
            Spacer(minLength: 12)
            controls
                .labelsHidden()
                .fixedSize()
        }
    }
}

struct SectionHeader: View {
    let title: String
    var subtitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.headline)
            if let subtitle {
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
