import AppKit
import CCUsageCore
import SwiftUI

struct SettingsView: View {
    @Environment(UsageStore.self) private var store

    var body: some View {
        @Bindable var store = store
        TabView {
            Form {
                LabeledContent("会话记录目录") {
                    HStack {
                        TextField("", text: $store.projectsPath).labelsHidden()
                        Button("选择…", action: chooseDirectory)
                        Button("默认") { store.projectsPath = UsageScanner.defaultProjectsDirectory.path }
                    }
                }
                Picker("自动刷新", selection: $store.refreshInterval) {
                    Text("30 秒").tag(30)
                    Text("1 分钟").tag(60)
                    Text("5 分钟").tag(300)
                    Text("15 分钟").tag(900)
                }
                LabeledContent("CC 成本记录") {
                    Text(store.configFileURL.path).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            .padding(20)
            .tabItem { Label("通用", systemImage: "gearshape") }

            Form {
                LabeledContent("当前套餐") {
                    Text(store.quota.plan.map { "\($0.displayName)（\($0.tier)）" } ?? "未知")
                }
                LabeledContent("CC mod") {
                    HStack {
                        Text(modText)
                        Spacer()
                        switch store.modState {
                        case .installed:
                            Button("卸载") { store.uninstallMod() }
                        case .outdated:
                            Button("更新") { store.installMod() }
                            Button("卸载") { store.uninstallMod() }
                        case .legacyStatusLine:
                            Button("升级") { store.installMod() }
                        case .notInstalled:
                            Button("安装") { store.installMod() }
                        }
                    }
                }
                LabeledContent("上报记录") {
                    Text("\(store.quota.statusLineObservationCount) 条 · \(ModInstaller.logURL.path)")
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Picker("5 小时窗口", selection: $store.windowMode) {
                    ForEach(WindowMode.allCases) { Text($0.label).tag($0) }
                }
                Text("仅影响没有 CC 上报的时段。首条请求开启窗口：与历史撞限提示的重置时间一致；固定周期滚动：从最近一次上报的重置时间起每 5 小时一个窗口。每周窗口始终按上报的重置时间滚动。套餐升降级（记录或推断）之前的窗口不参与额度估算。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(20)
            .tabItem { Label("额度", systemImage: "gauge.with.dots.needle.33percent") }

            PricingTable()
                .padding(20)
                .tabItem { Label("定价", systemImage: "dollarsign.circle") }
        }
        .frame(width: 640, height: 420)
    }

    private var modText: String {
        switch store.modState {
        case .installed: "已安装"
        case .outdated: "已安装（有更新）"
        case .notInstalled: "未安装"
        case .legacyStatusLine: "仍在使用旧的状态栏脚本，升级后恢复原 statusLine"
        }
    }

    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.showsHiddenFiles = true
        panel.directoryURL = store.projectsURL
        if panel.runModal() == .OK, let url = panel.url {
            store.projectsPath = url.path
        }
    }
}

private struct PricingTable: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Anthropic API 标价（美元 / 百万 tokens）。缓存写入 5m = 1.25× 输入，1h = 2× 输入；网页搜索 $10 / 千次。订阅用户看到的是按此价格折算的等值金额，并非实际扣费。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Table(Pricing.models.sorted { $0.displayName < $1.displayName }) {
                TableColumn("模型", value: \.displayName)
                TableColumn("输入") { Text(price($0.price.input)) }
                TableColumn("输出") { Text(price($0.price.output)) }
                TableColumn("缓存读") { Text(price($0.price.cacheRead)) }
                TableColumn("缓存写 5m") { Text(price($0.price.cacheWrite5m)) }
                TableColumn("缓存写 1h") { Text(price($0.price.cacheWrite1h)) }
                TableColumn("Fast") { Text($0.price.fastMultiplier.map { "\($0.formatted())×" } ?? "—") }
            }
        }
    }

    private func price(_ value: Double) -> String {
        "$" + value.formatted(.number.precision(.fractionLength(0...3)))
    }
}
