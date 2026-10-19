// Settings / filesystem paths for the CCUsage Electron app.
//
// Port of the path resolution in the Swift app (UsageStore.swift / ModInstaller.swift) to a
// cross-platform layout:
//
//   appConfigDir()  CCUSAGE_DEMO_DIR when set (demo mode; no real ~/.claude access),
//                   else macOS ~/Library/Application Support/CCUsage,
//                        Linux $XDG_CONFIG_HOME (or ~/.config)/CCUsage,
//                        Windows %APPDATA%\CCUsage.
//
// settings.json lives in appConfigDir(); the legacy observation logs live next to it
// (in demo mode under <demo>/CCUsage/ to keep the original Swift app layout).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppSettings, ServerConfig, WindowMode } from "@ccusage/core";
import { UsageScanner } from "@ccusage/core";

export const APP_NAME = "CCUsage";
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";
/** Refresh interval choices offered by the settings UI (Swift: 30 秒 / 1 分钟 / 5 分钟 / 15 分钟). */
export const REFRESH_INTERVAL_CHOICES = [30, 60, 300, 900] as const;
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 60;
/** The mod bridge heartbeat poll interval (clamped; also written to bridge.json). */
export const MIN_BRIDGE_POLL_MS = 5_000;
export const MAX_BRIDGE_POLL_MS = 300_000;

/** CCUSAGE_DEMO_DIR (absolute), or undefined in live mode. */
export function demoDir(): string | undefined {
  const raw = process.env.CCUSAGE_DEMO_DIR?.trim();
  if (!raw) return undefined;
  return resolve(raw);
}

/** Root directory for settings.json / bridge.json / sync state (and demo fixture root). */
export function appConfigDir(): string {
  const demo = demoDir();
  if (demo) return demo;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, APP_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(xdg, APP_NAME);
}

export function settingsFilePath(dir = appConfigDir()): string {
  return join(dir, "settings.json");
}
export function bridgeConfigPath(): string {
  return join(appConfigDir(), "bridge.json");
}
export function bridgeSocketPath(): string {
  return join(appConfigDir(), "bridge.sock");
}
export function syncStatePath(): string {
  return join(appConfigDir(), "sync-state.json");
}
export function backupsDir(): string {
  return join(appConfigDir(), "backups");
}

/**
 * Legacy observation log written by the app's mod bridge and the mod's fallback.
 * Demo fixtures keep the Swift app layout: <demo>/CCUsage/rate-limits.jsonl.
 */
export function rateLimitsLogPath(): string {
  const demo = demoDir();
  return demo ? join(demo, "CCUsage", "rate-limits.jsonl") : join(appConfigDir(), "rate-limits.jsonl");
}
/** Plan tier history (PlanHistory.swift); same location rules as rate-limits.jsonl. */
export function planHistoryPath(): string {
  const demo = demoDir();
  return demo ? join(demo, "CCUsage", "plan-history.jsonl") : join(appConfigDir(), "plan-history.jsonl");
}

/** Expand a leading "~" (the Swift app stores user-entered paths with tilde support). */
export function resolveUserPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

/** Default projects directory: demo fixture projects, else the scanner's ~/.claude/projects. */
export function defaultProjectsPath(): string {
  const demo = demoDir();
  if (demo) return join(demo, "projects");
  try {
    return UsageScanner.defaultProjectsDirectory();
  } catch {
    return join(homedir(), ".claude", "projects");
  }
}

/** Default Claude config file (~/.claude.json for the default layout). */
export function defaultConfigFilePath(): string {
  const demo = demoDir();
  if (demo) return join(demo, ".claude.json");
  return join(homedir(), ".claude.json");
}

/** Absolute projects root for a settings payload. */
export function projectsRoot(settings: AppSettings): string {
  const configured = settings.projectsPath?.trim();
  return resolveUserPath(configured || defaultProjectsPath());
}

/** The Claude directory: parent of the projects directory (where skills/ and settings.json live). */
export function claudeDirectory(settings: AppSettings): string {
  return dirname(projectsRoot(settings));
}

/**
 * ~/.claude.json for the default layout, otherwise <claude dir>/.claude.json
 * (mirrors UsageStore.configFileURL in the Swift app).
 */
export function claudeConfigFile(settings: AppSettings): string {
  const claudeDir = claudeDirectory(settings);
  const home = homedir();
  if (resolve(claudeDir) === resolve(join(home, ".claude"))) {
    return join(home, ".claude.json");
  }
  return join(claudeDir, ".claude.json");
}

function defaultDeviceId(): string {
  return randomUUID();
}

function defaultDeviceName(): string {
  const name = hostname().trim();
  return name || (process.platform === "darwin" ? "macOS 设备" : "设备");
}

export function defaultSettings(): AppSettings {
  return {
    projectsPath: defaultProjectsPath(),
    refreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
    windowMode: "firstRequest",
    server: {
      enabled: false,
      url: DEFAULT_SERVER_URL,
      deviceId: defaultDeviceId(),
      deviceName: defaultDeviceName(),
    },
    theme: "system",
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function sanitizeWindowMode(value: unknown, fallback: WindowMode): WindowMode {
  return value === "fixedRolling" || value === "firstRequest" ? value : fallback;
}

function sanitizeTheme(value: unknown, fallback: AppSettings["theme"]): AppSettings["theme"] {
  return value === "light" || value === "dark" || value === "system" ? value : fallback;
}

function sanitizeUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed || fallback;
}

function sanitizeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

export function sanitizeServerConfig(value: unknown, base: ServerConfig): ServerConfig {
  const input = isObject(value) ? value : {};
  const server: ServerConfig = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
    url: sanitizeUrl(input.url, base.url || DEFAULT_SERVER_URL),
    username: typeof input.username === "string" && input.username.trim() ? input.username.trim() : base.username,
    deviceId: sanitizeString(input.deviceId, base.deviceId || defaultDeviceId()),
    deviceName: sanitizeString(input.deviceName, base.deviceName || defaultDeviceName()),
    token: typeof input.token === "string" && input.token.trim() ? input.token.trim() : base.token,
  };
  // An explicit undefined/null token from an update is how logout clears the saved token.
  if ("token" in input && (input.token === undefined || input.token === null)) server.token = undefined;
  if (server.username === undefined) delete server.username;
  if (server.token === undefined) delete server.token;
  return server;
}

/** Merge a (possibly partial / malformed) settings payload over base. Unknown fields are dropped. */
export function sanitizeSettings(value: unknown, base: AppSettings = defaultSettings()): AppSettings {
  const input = isObject(value) ? value : {};
  const projectsPath = typeof input.projectsPath === "string" && input.projectsPath.trim() ? input.projectsPath.trim() : base.projectsPath;
  return {
    projectsPath,
    refreshIntervalSeconds: sanitizeNumber(input.refreshIntervalSeconds, base.refreshIntervalSeconds, 5, 86_400),
    windowMode: sanitizeWindowMode(input.windowMode, base.windowMode),
    server: sanitizeServerConfig(input.server, base.server),
    theme: sanitizeTheme(input.theme, base.theme),
  };
}

/** Settings store backed by <appConfigDir>/settings.json (atomic writes). */
export class SettingsStore {
  readonly filePath: string;
  private value: AppSettings;

  constructor(dir = appConfigDir()) {
    this.filePath = settingsFilePath(dir);
    this.value = this.load();
    // Persist generated deviceId / filled-in defaults once so they stay stable.
    this.save();
  }

  get(): AppSettings {
    return structuredClone(this.value);
  }

  get server(): ServerConfig {
    return { ...this.value.server };
  }

  /** Merge a partial settings payload, persist, and return the new settings. */
  update(patch: unknown): AppSettings {
    this.value = sanitizeSettings(patch, this.value);
    this.save();
    return this.get();
  }

  /** Merge a partial server config (used by sync login/configure); unlike update() this may clear the token. */
  updateServer(patch: Partial<ServerConfig>): AppSettings {
    const next = sanitizeServerConfig(patch, this.value.server);
    this.value = { ...this.value, server: next };
    this.save();
    return this.get();
  }

  save(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const content = JSON.stringify(this.value, null, 2) + "\n";
    try {
      if (readFileSync(this.filePath, "utf8") === content) return;
    } catch {
      // file missing: fall through to write
    }
    const temp = this.filePath + ".tmp-" + process.pid;
    writeFileSync(temp, content, "utf8");
    renameSync(temp, this.filePath);
  }

  private load(): AppSettings {
    const base = defaultSettings();
    try {
      if (!existsSync(this.filePath)) return base;
      const data = readFileSync(this.filePath, "utf8");
      if (!data.trim()) return base;
      return sanitizeSettings(JSON.parse(data), base);
    } catch (error) {
      console.error("[settings] failed to read", this.filePath, error);
      return base;
    }
  }
}

/** Bridge heartbeat poll interval derived from the scan refresh interval (clamped). */
export function bridgePollMs(settings: AppSettings): number {
  const milliseconds = Math.round(settings.refreshIntervalSeconds * 1000);
  return Math.min(MAX_BRIDGE_POLL_MS, Math.max(MIN_BRIDGE_POLL_MS, milliseconds));
}

/** Directory where the app writes its runtime state; created on demand. */
export function ensureConfigDir(): string {
  const dir = appConfigDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
