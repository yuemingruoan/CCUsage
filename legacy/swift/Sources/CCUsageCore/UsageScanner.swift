import Foundation

/// Scans a Claude Code projects directory, re-parsing only files whose size or
/// modification date changed since the previous scan.
public actor UsageScanner {
    private struct CachedFile {
        let size: Int
        let modified: Date
        let transcript: ParsedTranscript
    }

    private var cache: [String: CachedFile] = [:]
    private var cachedRoot: URL?

    public init() {}

    public static var defaultClaudeDirectory: URL {
        if let custom = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !custom.isEmpty {
            return URL(fileURLWithPath: (custom as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
    }

    public static var defaultProjectsDirectory: URL {
        defaultClaudeDirectory.appendingPathComponent("projects")
    }

    /// - Parameters:
    ///   - projectsRoot: usually `~/.claude/projects`.
    ///   - configFile: `~/.claude.json`, read for Claude Code's own `lastCost` records.
    public func scan(projectsRoot: URL, configFile: URL? = nil) async throws -> UsageSnapshot {
        if cachedRoot != projectsRoot {
            cache.removeAll()
            cachedRoot = projectsRoot
        }

        let files = try Self.transcriptFiles(in: projectsRoot)
        var fresh: [String: CachedFile] = [:]
        var stale: [(url: URL, size: Int, modified: Date)] = []
        for file in files {
            if let hit = cache[file.url.path], hit.size == file.size, hit.modified == file.modified {
                fresh[file.url.path] = hit
            } else {
                stale.append(file)
            }
        }

        let parsed = await withTaskGroup(of: CachedFile?.self) { group in
            for file in stale {
                group.addTask {
                    guard let transcript = try? TranscriptParser.parse(fileAt: file.url, projectsRoot: projectsRoot) else { return nil }
                    return CachedFile(size: file.size, modified: file.modified, transcript: transcript)
                }
            }
            var results: [CachedFile] = []
            for await result in group {
                if let result { results.append(result) }
            }
            return results
        }
        for file in parsed { fresh[file.transcript.path] = file }
        cache = fresh

        let recorded = configFile.map(Self.recordedCosts(in:)) ?? [:]
        return UsageSnapshot.build(transcripts: fresh.values.map(\.transcript), recordedCosts: recorded)
    }

    private static func transcriptFiles(in root: URL) throws -> [(url: URL, size: Int, modified: Date)] {
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else {
            throw CocoaError(.fileReadNoSuchFile, userInfo: [NSFilePathErrorKey: root.path])
        }
        var files: [(URL, Int, Date)] = []
        for case let url as URL in enumerator where url.pathExtension == "jsonl" {
            let values = try? url.resourceValues(forKeys: Set(keys))
            guard values?.isRegularFile == true, let size = values?.fileSize, size > 0 else { continue }
            files.append((url, size, values?.contentModificationDate ?? .distantPast))
        }
        return files
    }

    /// `lastSessionId -> lastCost` from each project entry in `~/.claude.json`.
    public static func recordedCosts(in configFile: URL) -> [String: Double] {
        guard let data = try? Data(contentsOf: configFile),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let projects = root["projects"] as? [String: Any]
        else { return [:] }
        var result: [String: Double] = [:]
        for case let project as [String: Any] in projects.values {
            if let sessionId = project["lastSessionId"] as? String,
               let cost = project["lastCost"] as? Double, cost > 0 {
                result[sessionId] = cost
            }
        }
        return result
    }
}
