// Installs the CCUsage mod into Claude Code (port of legacy/swift/Sources/CCUsage/ModInstaller.swift).
//
// Claude Code loads a plugin folder under <claudeDir>/skills/ as "ccusage@skills-dir", so the
// installer writes MOD_PLUGIN_FILES (embedded from packages/mod/plugin by scripts/gen-mod-source.mjs)
// into <claudeDir>/skills/ccusage/. Earlier app versions hooked a status line script into
// ~/.claude/settings.json; install()/uninstall() undo that with a backup of the file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModState } from "@ccusage/core";
import { MOD_PLUGIN_FILES } from "@ccusage/core";
import { appConfigDir, backupsDir } from "./settings.js";

const LEGACY_STATUS_LINE_MARKER = "CCUsage/statusline.sh";

type SettingsObject = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.stringify with recursively sorted keys (Swift uses .sortedKeys). */
function stableStringify(value: unknown, indent = ""): string {
  const nextIndent = indent + "  ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => nextIndent + stableStringify(item, nextIndent));
    return "[\n" + items.join(",\n") + "\n" + indent + "]";
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return "{}";
    const items = keys.map((key) => nextIndent + JSON.stringify(key) + ": " + stableStringify(value[key], nextIndent));
    return "{\n" + items.join(",\n") + "\n" + indent + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + ".tmp-" + process.pid;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}

function timestampSlug(date = new Date()): string {
  const pad = (n: number, length = 2) => String(n).padStart(length, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

export interface ModInstallerOptions {
  /** Absolute path of the Claude directory (parent of the projects directory). */
  getClaudeDirectory: () => string;
  /** App support directory holding backups / old status line scripts. Defaults to appConfigDir(). */
  supportDirectory?: () => string;
}

export class ModInstaller {
  private readonly options: ModInstallerOptions;

  constructor(options: ModInstallerOptions) {
    this.options = options;
  }

  get claudeDirectory(): string {
    return this.options.getClaudeDirectory();
  }

  get supportDirectory(): string {
    return this.options.supportDirectory?.() ?? appConfigDir();
  }

  get settingsURL(): string {
    return join(this.claudeDirectory, "settings.json");
  }

  /** Claude Code loads a plugin folder under skills/ as ccusage@skills-dir. */
  get modURL(): string {
    return join(this.claudeDirectory, "skills", "ccusage");
  }

  get logURL(): string {
    return join(this.supportDirectory, "rate-limits.jsonl");
  }

  get legacyScriptURL(): string {
    return join(this.supportDirectory, "statusline.sh");
  }

  get chainedCommandURL(): string {
    return join(this.supportDirectory, "chained-command");
  }

  state(): ModState {
    if (this.hasLegacyStatusLine(this.readSettings())) return "legacyStatusLine";
    const files = Object.entries(MOD_PLUGIN_FILES);
    if (files.length === 0) return "notInstalled";
    const installed = files.map(([relativePath]) => this.readModFile(relativePath));
    if (installed.every((content) => content === null)) return "notInstalled";
    return installed.every((content, index) => content === files[index]?.[1]) ? "installed" : "outdated";
  }

  /** Writes the mod, then unhooks the status line script of earlier versions. */
  install(): ModState {
    const files = Object.entries(MOD_PLUGIN_FILES);
    if (files.length === 0) {
      throw new Error("CC mod 源文件缺失（packages/core/src/mod-source.generated.ts 未生成）");
    }
    for (const [relativePath, content] of files) {
      atomicWrite(join(this.modURL, relativePath), content);
    }
    this.removeLegacyStatusLine();
    return this.state();
  }

  uninstall(): ModState {
    if (existsSync(this.modURL)) {
      rmSync(this.modURL, { recursive: true, force: true });
    }
    this.removeLegacyStatusLine();
    return this.state();
  }

  private readModFile(relativePath: string): string | null {
    try {
      return readFileSync(join(this.modURL, relativePath), "utf8");
    } catch {
      return null;
    }
  }

  private hasLegacyStatusLine(settings: SettingsObject | null): boolean {
    const statusLine = settings?.statusLine;
    return isObject(statusLine) && typeof statusLine.command === "string" && statusLine.command.includes(LEGACY_STATUS_LINE_MARKER);
  }

  /**
   * Restores the status line command the old script was chained to, or removes the entry,
   * after backing up settings.json to <support>/backups/settings-<stamp>.json.
   */
  private removeLegacyStatusLine(): void {
    const settings = this.readSettings();
    if (!settings || !this.hasLegacyStatusLine(settings)) return;
    this.backupSettings();
    let previous: string | undefined;
    try {
      const chained = readFileSync(this.chainedCommandURL, "utf8");
      if (chained.length > 0) previous = chained;
    } catch {
      // no chained command recorded
    }
    const next: SettingsObject = { ...settings };
    if (previous !== undefined) {
      const statusLine: Record<string, unknown> = isObject(next.statusLine) ? { ...next.statusLine } : { type: "command" };
      statusLine.command = previous;
      next.statusLine = statusLine;
    } else {
      delete next.statusLine;
    }
    this.writeSettings(next);
    rmSync(this.chainedCommandURL, { force: true });
    rmSync(this.legacyScriptURL, { force: true });
  }

  private readSettings(): SettingsObject | null {
    if (!existsSync(this.settingsURL)) return null;
    try {
      const data = readFileSync(this.settingsURL, "utf8");
      if (!data.trim()) return {};
      const parsed: unknown = JSON.parse(data);
      return isObject(parsed) ? parsed : null;
    } catch (error) {
      console.error("[mod-installer] failed to read", this.settingsURL, error);
      return null;
    }
  }

  private writeSettings(settings: SettingsObject): void {
    atomicWrite(this.settingsURL, stableStringify(settings) + "\n");
  }

  private backupSettings(): void {
    if (!existsSync(this.settingsURL)) return;
    try {
      const directory = backupsDir();
      mkdirSync(directory, { recursive: true });
      let stamp = timestampSlug();
      let target = join(directory, "settings-" + stamp + ".json");
      let counter = 1;
      while (existsSync(target)) {
        target = join(directory, "settings-" + stamp + "-" + counter + ".json");
        counter += 1;
      }
      copyFileSync(this.settingsURL, target);
    } catch (error) {
      console.error("[mod-installer] failed to back up settings.json", error);
    }
  }
}
