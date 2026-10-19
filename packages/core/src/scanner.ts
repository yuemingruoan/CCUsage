// Port of legacy/swift/Sources/CCUsageCore/UsageScanner.swift.
//
// Walks `~/.claude/projects`, re-parsing only files whose size or modification time
// changed since the previous scan (cache key: absolute path + size + mtime).

import { promises as fsp, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ParsedTranscript, UsageSnapshot } from "./types.js";
import { buildSnapshot } from "./aggregation.js";
import { parseTranscriptData } from "./transcript-parser.js";
import { expandTilde } from "./time-utils.js";

interface CachedFile {
  size: number;
  modified: number;
  transcript: ParsedTranscript;
}

interface ScannedFile {
  url: string;
  size: number;
  modified: number;
}

/** Per-scan cache statistics (used by the Electron scan stats and by tests). */
export interface ScanCacheStats {
  parsedFiles: number;
  cachedFiles: number;
  durationMs: number;
}

/** Scans a Claude Code projects directory, parsing incrementally. */
export class UsageScanner {
  private cache = new Map<string, CachedFile>();
  private cachedRoot: string | undefined;
  private stats: ScanCacheStats = { parsedFiles: 0, cachedFiles: 0, durationMs: 0 };

  constructor() {}

  /** `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
  static defaultClaudeDirectory(): string {
    const custom = process.env["CLAUDE_CONFIG_DIR"];
    if (custom !== undefined && custom !== "") {
      return path.resolve(expandTilde(custom, homedir()));
    }
    return path.join(homedir(), ".claude");
  }

  /** `<defaultClaudeDirectory>/projects`. */
  static defaultProjectsDirectory(): string {
    return path.join(UsageScanner.defaultClaudeDirectory(), "projects");
  }

  /** Statistics of the most recent scan. */
  get lastScanStats(): ScanCacheStats {
    return { ...this.stats };
  }

  /**
   * @param projectsRoot usually `~/.claude/projects`.
   * @param configFile `~/.claude.json`, read for Claude Code's own `lastCost` records.
   */
  async scan(projectsRoot: string, configFile?: string): Promise<UsageSnapshot> {
    const startedAt = Date.now();
    if (this.cachedRoot !== projectsRoot) {
      this.cache.clear();
      this.cachedRoot = projectsRoot;
    }

    const files = await transcriptFiles(projectsRoot);
    const fresh = new Map<string, CachedFile>();
    const stale: ScannedFile[] = [];
    for (const file of files) {
      const hit = this.cache.get(file.url);
      if (hit !== undefined && hit.size === file.size && hit.modified === file.modified) {
        fresh.set(file.url, hit);
      } else {
        stale.push(file);
      }
    }

    const parsed = await parseFiles(stale, projectsRoot);
    for (const file of parsed) fresh.set(file.transcript.path, file);
    const parsedCount = parsed.length;
    this.cache = fresh;

    const recorded = configFile !== undefined ? recordedCosts(configFile) : {};
    const snapshot = buildSnapshot(
      [...fresh.values()].map((file) => file.transcript),
      recorded
    );
    this.stats = {
      parsedFiles: parsedCount,
      cachedFiles: fresh.size - parsedCount,
      durationMs: Date.now() - startedAt
    };
    return snapshot;
  }

  /** Drops the incremental cache; the next scan reparses everything. */
  clearCache(): void {
    this.cache.clear();
    this.cachedRoot = undefined;
  }
}

/** Recursively lists `.jsonl` regular files with size/mtime (Swift transcriptFiles). */
async function transcriptFiles(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  // Mirror FileManager.enumerator: a missing root throws for the caller to report.
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop() as string;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const url = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(url);
      } else if (entry.isFile() && path.extname(entry.name) === ".jsonl") {
        let stat;
        try {
          stat = await fsp.stat(url);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size <= 0) continue;
        files.push({ url, size: stat.size, modified: stat.mtimeMs });
      }
    }
  }
  return files;
}

/** Parses files with bounded concurrency; unreadable/broken files are skipped like `try?`. */
async function parseFiles(files: ScannedFile[], projectsRoot: string): Promise<CachedFile[]> {
  const results: CachedFile[] = [];
  const queue = [...files];
  const concurrency = Math.min(8, queue.length);
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const file = queue.pop();
      if (file === undefined) return;
      try {
        const data = await fsp.readFile(file.url);
        const transcript = parseTranscriptData(data, file.url, projectsRoot);
        results.push({ size: file.size, modified: file.modified, transcript });
      } catch {
        // Swift `try?` also skips a file that disappears or cannot be read.
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * `lastSessionId -> lastCost` from each project entry in `~/.claude.json`
 * (Swift UsageScanner.recordedCosts).
 */
export function recordedCosts(configFile: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const projects = (parsed as Record<string, unknown>)["projects"];
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return {};
  const result: Record<string, number> = {};
  for (const project of Object.values(projects as Record<string, unknown>)) {
    if (typeof project !== "object" || project === null || Array.isArray(project)) continue;
    const record = project as Record<string, unknown>;
    const sessionId = record["lastSessionId"];
    const cost = record["lastCost"];
    if (typeof sessionId === "string" && typeof cost === "number" && cost > 0) {
      result[sessionId] = cost;
    }
  }
  return result;
}
