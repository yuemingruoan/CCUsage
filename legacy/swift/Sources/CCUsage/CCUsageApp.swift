import AppKit
import CCUsageCore
import SwiftUI

@main
enum Entry {
    static func main() {
        if CommandLine.arguments.contains("--report") {
            Report.run(arguments: CommandLine.arguments)
        } else {
            CCUsageApp.main()
        }
    }
}

struct CCUsageApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = UsageStore()

    var body: some Scene {
        Window("CC 用量", id: "main") {
            ContentView()
                .environment(store)
                .frame(minWidth: 960, minHeight: 640)
        }
        .defaultSize(width: 1200, height: 800)

        MenuBarExtra {
            MenuBarView().environment(store)
        } label: {
            MenuBarLabel().environment(store)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView().environment(store)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Needed when launched as a bare SwiftPM executable (`swift run`) rather than a bundle.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

/// Written once by the scan task, read after the semaphore signals.
private final class ResultBox: @unchecked Sendable {
    var result: Result<UsageSnapshot, Error>?
}

/// `CCUsage --report [--root <projects dir>]`: prints a per-session cost table and exits.
enum Report {
    static func run(arguments: [String]) {
        var root = UsageScanner.defaultProjectsDirectory
        if let index = arguments.firstIndex(of: "--root"), index + 1 < arguments.count {
            root = URL(fileURLWithPath: (arguments[index + 1] as NSString).expandingTildeInPath)
        }
        let config = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude.json")

        let semaphore = DispatchSemaphore(value: 0)
        let box = ResultBox()
        let clock = ContinuousClock()
        let started = clock.now
        Task.detached {
            do { box.result = .success(try await UsageScanner().scan(projectsRoot: root, configFile: config)) }
            catch { box.result = .failure(error) }
            semaphore.signal()
        }
        semaphore.wait()
        let elapsed = clock.now - started

        switch box.result! {
        case .failure(let error):
            FileHandle.standardError.write(Data("error: \(error.localizedDescription)\n".utf8))
            exit(1)
        case .success(let snapshot):
            print("\(snapshot.fileCount) files, \(snapshot.entries.count) requests, \(snapshot.sessions.count) sessions, scanned in \(elapsed)")
            for session in snapshot.sessions {
                let recorded = session.recordedCost.map { String(format: "  (CC lastCost $%.2f)", $0) } ?? ""
                print(String(format: "%@  $%10.2f  %6d req  %@  %@%@",
                             session.id, session.cost.total, session.requestCount,
                             session.projectName, String(session.title.prefix(40)), recorded))
            }
            let total = snapshot.entries.reduce(0) { $0 + $1.cost.total }
            print(String(format: "total $%.2f", total))
            let mode: WindowMode = arguments.contains("--fixed-rolling") ? .fixedRolling : .firstRequest
            let quota = QuotaSnapshot.build(entries: snapshot.entries, limitEvents: snapshot.limitEvents, mode: mode, configFile: config)
            print("observations: \(quota.statusLineObservationCount) status line, \(quota.limitMessageCount) limit messages; 5h mode \(mode.rawValue)")
            for kind in QuotaKind.allCases {
                for window in (quota.windows[kind] ?? []).suffix(kind == .fiveHour ? 8 : 3) {
                    let observed = window.maxObservedPercentage.map { String(format: "  CC max %.0f%%", $0) } ?? ""
                    let fitted = window.latestSample.map { String(format: "  implied 100%% ≈ $%.2f", $0.impliedLimit) } ?? ""
                    let reset = window.resetAt.map {
                        String(format: "  reset after %@ ($%.2f since)", Format.dateTime($0), window.costSinceReset)
                    } ?? ""
                    print(String(format: "%@ %@ – %@ %@ $%8.2f %6d req%@%@%@",
                                 kind.rawValue, Format.dateTime(window.start), Format.dateTime(window.end),
                                 window.isConfirmed ? "confirmed" : "inferred ", window.cost, window.requestCount, observed, fitted, reset))
                }
                if let status = quota.status[kind] {
                    let percentage = status.percentage.map { String(format: "%.1f%%", $0) } ?? "n/a"
                    let estimate = status.estimate.map {
                        String(format: "$%@ (lower bound $%.2f, change %@)",
                               $0.cost.map { String(format: "%.2f", $0) } ?? "?", $0.lowerBound,
                               $0.planChange.map { "\($0.kind) @ \(Format.dateTime($0.date))" } ?? "none")
                    } ?? "n/a"
                    let exhaustion = status.exhaustionDate.map(Format.dateTime) ?? "-"
                    print(String(format: "%@ now: %@  limit %@  rate $%.2f/h  exhausts %@",
                                 kind.rawValue, percentage, estimate, status.burnRatePerHour, exhaustion))
                }
            }
            exit(0)
        }
    }
}
