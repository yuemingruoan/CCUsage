import CCUsageCore
import SwiftUI

enum SidebarItem: Hashable {
    case overview
    case session(String)
}

enum SessionSort: String, CaseIterable, Identifiable {
    case recent, cost
    var id: String { rawValue }
    var label: String { self == .recent ? "最近活动" : "金额" }
}

struct ContentView: View {
    @Environment(UsageStore.self) private var store
    @State private var selection: SidebarItem? = .overview
    @State private var search = ""
    @AppStorage("dateRange") private var range: DateRange = .week
    @AppStorage("sessionSort") private var sort: SessionSort = .recent

    private var visibleSessions: [SessionSummary] {
        let start = range.start(now: Date())
        var sessions = store.snapshot.sessions.filter { start == nil || $0.end >= start! }
        let query = search.trimmingCharacters(in: .whitespaces)
        if !query.isEmpty {
            sessions = sessions.filter {
                $0.title.localizedCaseInsensitiveContains(query)
                    || $0.projectName.localizedCaseInsensitiveContains(query)
                    || $0.id.hasPrefix(query)
            }
        }
        if sort == .cost { sessions.sort { $0.cost.total > $1.cost.total } }
        return sessions
    }

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 260, ideal: 320)
        } detail: {
            detail
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("时间范围", selection: $range) {
                    ForEach(DateRange.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            ToolbarItem {
                Button {
                    Task { await store.refresh() }
                } label: {
                    if store.isLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("刷新", systemImage: "arrow.clockwise")
                    }
                }
                .keyboardShortcut("r")
                .help("重新扫描会话记录（⌘R）")
            }
        }
    }

    private var sidebar: some View {
        let sessions = visibleSessions
        return List(selection: $selection) {
            Label("概览", systemImage: "chart.bar.xaxis").tag(SidebarItem.overview)
            Section {
                ForEach(sessions) { session in
                    SessionRow(session: session).tag(SidebarItem.session(session.id))
                }
            } header: {
                HStack {
                    Text("会话 (\(sessions.count))")
                    Spacer()
                    Menu {
                        Picker("排序", selection: $sort) {
                            ForEach(SessionSort.allCases) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.inline)
                    } label: {
                        Label("按\(sort.label)排序", systemImage: "arrow.up.arrow.down")
                            .labelStyle(.titleAndIcon)
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                }
            }
        }
        .searchable(text: $search, placement: .sidebar, prompt: "搜索标题 / 项目 / ID")
        .safeAreaInset(edge: .bottom) { statusBar }
    }

    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let error = store.lastError {
                Text(error).foregroundStyle(.red).lineLimit(2)
            } else if store.hasLoaded {
                Text("\(store.snapshot.fileCount) 个记录文件 · 扫描 \(store.lastScanDuration.formatted(.units(allowed: [.seconds, .milliseconds], width: .narrow)))")
                Text("更新于 \(store.snapshot.generatedAt.formatted(date: .omitted, time: .standard))")
            } else {
                Text("正在扫描…")
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    @ViewBuilder
    private var detail: some View {
        switch selection {
        case .session(let id):
            if let session = store.session(id: id) {
                SessionDetailView(session: session)
            } else {
                ContentUnavailableView("会话不存在", systemImage: "questionmark.folder")
            }
        case .overview, nil:
            if store.hasLoaded || !store.snapshot.entries.isEmpty {
                OverviewView(range: range, selection: $selection)
            } else {
                ProgressView("正在读取 \(store.projectsPath)…")
            }
        }
    }
}

struct SessionRow: View {
    let session: SessionSummary

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).lineLimit(1)
                HStack(spacing: 4) {
                    Text(session.projectName)
                    Text("·")
                    Text(session.end, format: .relative(presentation: .named))
                    if session.subagentCount > 0 {
                        Text("· \(session.subagentCount) 子代理")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(Format.usd(session.cost.total))
                .font(.callout.weight(.medium))
                .monospacedDigit()
        }
        .padding(.vertical, 2)
    }
}
