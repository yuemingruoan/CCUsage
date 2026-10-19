import CCUsageCore
import SwiftUI

struct MenuBarLabel: View {
    @Environment(UsageStore.self) private var store

    var body: some View {
        if !store.hasLoaded {
            Text("CC")
        } else if let percentage = store.quota.status[.fiveHour]?.percentage {
            Text("5h \(Int(percentage.rounded()))%")
        } else {
            let today = store.snapshot.entries(since: Calendar.current.startOfDay(for: Date()))
            Text(Format.usd(today.reduce(0) { $0 + $1.cost.total }))
        }
    }
}

struct MenuBarView: View {
    @Environment(UsageStore.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let today = store.snapshot.entries(since: Calendar.current.startOfDay(for: Date()))
        var costBySession: [String: Double] = [:]
        today.forEach { costBySession[$0.sessionId, default: 0] += $0.cost.total }
        let top = costBySession.sorted { $0.value > $1.value }.prefix(5)

        return VStack(alignment: .leading, spacing: 10) {
            EqualHeightRow(spacing: 8) {
                QuotaCard(status: store.quota.status[.fiveHour], kind: .fiveHour, compact: true)
                QuotaCard(status: store.quota.status[.sevenDay], kind: .sevenDay, compact: true)
            }
            HStack {
                Text("今天折算").foregroundStyle(.secondary)
                Spacer()
                Text(Format.usd(today.reduce(0) { $0 + $1.cost.total })).monospacedDigit()
            }
            .font(.callout)
            if !top.isEmpty {
                Divider()
                ForEach(Array(top), id: \.key) { id, cost in
                    HStack {
                        Text(store.session(id: id)?.title ?? id).lineLimit(1)
                        Spacer()
                        Text(Format.usd(cost)).monospacedDigit()
                    }
                    .font(.callout)
                }
            }
            Divider()
            HStack {
                Button("打开主窗口") {
                    openWindow(id: "main")
                    NSApp.activate()
                }
                Button("刷新") { Task { await store.refresh() } }
                Spacer()
                Button("退出") { NSApp.terminate(nil) }
            }
        }
        .padding(12)
        .frame(width: 400)
    }
}
