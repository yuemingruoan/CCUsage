// Electron main process entry for CCUsage 2.0.
//
// Responsibilities (see docs/ARCHITECTURE.md and docs/CONTRACTS.md):
//  - app lifecycle + single instance lock, main window / settings window / tray popover windows
//  - app menu, tray title (5h N% or today's USD)
//  - wires the ScanService (worker threads), QuotaService, mod bridge HTTP server, mod installer
//    and multi-device SyncManager together and pushes AppState to every renderer
//  - optional screenshot mode (CCUSAGE_SCREENSHOT_DIR) used by scripts/screenshot.ts
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, nativeTheme, screen } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AppSettings,
  AppState,
  AuthMode,
  BridgeAuthFingerprint,
  BridgeReading,
  BridgeStatus,
  ModState,
  QuotaSnapshot,
  ScanStats,
  ServerConfig,
  SyncState,
  UsageSnapshot,
} from "@ccusage/core";
import { Format } from "@ccusage/core";
import { BridgeServer } from "./bridge";
import { broadcastState, registerIpc } from "./ipc";
import type { AppPathsInfo, IpcHandlers, ModOperationResult } from "./ipc";
import { ModInstaller } from "./mod-installer";
import { QuotaService } from "./quota";
import { ScanService } from "./scan";
import type { ScanResult } from "./scan";
import {
  APP_NAME,
  SettingsStore,
  appConfigDir,
  bridgePollMs,
  claudeConfigFile,
  claudeDirectory,
  defaultProjectsPath,
  planHistoryPath,
  projectsRoot,
  rateLimitsLogPath,
  syncStatePath,
} from "./settings";
import { SyncManager } from "./sync";

const DIST_DIR = __dirname;
const INDEX_HTML = join(DIST_DIR, "index.html");
const TRAY_HTML = join(DIST_DIR, "tray.html");
const PRELOAD = join(DIST_DIR, "preload.cjs");
const TRAY_WINDOW_WIDTH = 400;
const TRAY_WINDOW_HEIGHT = 600;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref?.();
  });
}

function readAppVersion(): string {
  for (const candidate of [join(DIST_DIR, "..", "package.json"), join(DIST_DIR, "..", "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version) return parsed.version;
    } catch {
      // try next candidate
    }
  }
  return "2.0.0";
}

function resolveAsset(name: string): string | undefined {
  for (const candidate of [join(DIST_DIR, "assets", name), join(DIST_DIR, "..", "assets", name)]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function emptySnapshot(): UsageSnapshot {
  return { entries: [], sessions: [], entriesBySession: {}, limitEvents: [], fileCount: 0, generatedAt: 0 };
}

function emptyScanStats(): ScanStats {
  return { fileCount: 0, scanDurationMs: 0, scannedAt: 0 };
}

function windowPreferences(): Electron.WebPreferences {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
    backgroundThrottling: false,
  };
}

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ececec";
}

/** Owns the app data model: local snapshot + quota + sync + bridge + settings. */
class AppController {
  readonly settingsStore: SettingsStore;
  readonly scan: ScanService;
  readonly quota: QuotaService;
  readonly bridge: BridgeServer;
  readonly sync: SyncManager;
  readonly modInstaller: ModInstaller;
  readonly appVersion: string;

  /** Set by index.ts once the windows exist. */
  publish: ((state: AppState) => void) | undefined;

  private localSnapshot: UsageSnapshot = emptySnapshot();
  private scanStats: ScanStats = emptyScanStats();
  private modState: ModState = "notInstalled";
  private lastError: string | undefined;
  private firstScanResolve: (() => void) | undefined;
  private readonly firstScanPromise: Promise<void>;
  private pushScheduled = false;
  private serverQuotaRef: QuotaSnapshot | undefined;
  private remoteObservationsRef: readonly unknown[] | undefined;
  private mergedCache:
    | { local: UsageSnapshot; remoteEntries: readonly unknown[]; deviceNames: ReadonlyMap<string, string>; snapshot: UsageSnapshot }
    | undefined;
  /** Authoritative auth source per session, reported by the mod running inside Claude Code. */
  private readonly authHints = new Map<string, BridgeAuthFingerprint & { at: number }>();
  private authHintsSaveTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.appVersion = readAppVersion();
    this.settingsStore = new SettingsStore();
    this.loadAuthHints();
    this.scan = new ScanService(
      () => {
        const settings = this.settingsStore.get();
        return { projectsRoot: projectsRoot(settings), configFile: claudeConfigFile(settings) };
      },
      () => this.settingsStore.get().refreshIntervalSeconds,
    );
    this.quota = new QuotaService(() => {
      const settings = this.settingsStore.get();
      return {
        configFile: claudeConfigFile(settings),
        statusLineLogPath: rateLimitsLogPath(),
        planHistoryPath: planHistoryPath(),
      };
    });
    this.bridge = new BridgeServer({
      appVersion: this.appVersion,
      getRateLimitsLogPath: () => rateLimitsLogPath(),
      getDeviceId: () => this.settingsStore.get().server.deviceId,
      getDeviceName: () => this.settingsStore.get().server.deviceName,
      getPollMs: () => bridgePollMs(this.settingsStore.get()),
      onReport: (reading) => this.handleBridgeReport(reading),
      onStatusChange: () => this.push(),
    });
    this.sync = new SyncManager({
      appVersion: this.appVersion,
      getSettings: () => this.settingsStore.get(),
      updateServer: (patch) => this.settingsStore.updateServer(patch),
      statePath: () => syncStatePath(),
      getLocalSnapshot: () => this.localSnapshot,
      getLocalObservations: () => this.quota.localObservations(),
      getPlan: () => this.quota.plan(),
    });
    this.modInstaller = new ModInstaller({
      getClaudeDirectory: () => claudeDirectory(this.settingsStore.get()),
    });

    this.firstScanPromise = new Promise<void>((resolveFirstScan) => {
      this.firstScanResolve = resolveFirstScan;
    });

    this.scan.on("snapshot", (result: ScanResult) => this.handleSnapshot(result));
    this.scan.on("scanError", (error: unknown) => {
      this.lastError = "扫描会话记录失败：" + messageOf(error);
      this.push();
    });
    this.bridge.on("status", () => this.push());
    this.sync.on("state", () => {
      this.applySyncQuota();
      this.push();
    });
    this.sync.on("quota", () => {
      this.applySyncQuota();
      this.push();
    });
  }

  async start(): Promise<void> {
    nativeTheme.themeSource = this.settingsStore.get().theme;
    this.modState = this.safeModState();
    try {
      await this.bridge.start();
    } catch (error) {
      this.lastError = "mod 桥接启动失败：" + messageOf(error);
      console.error("[main] bridge failed to start", error);
    }
    this.push();
    this.scan.start();
    this.sync.start();
  }

  async shutdown(): Promise<void> {
    this.scan.stop();
    this.sync.stop();
    await this.bridge.close();
  }

  getState(): AppState {
    const settings = this.settingsStore.get();
    const syncState = this.sync.getState();
    const state: AppState = {
      snapshot: this.mergedSnapshot(),
      quota: this.quota.displayQuota(),
      sync: syncState,
      settings,
      modState: this.modState,
      bridge: this.bridge.status(),
      scan: this.scanStats,
    };
    if (this.lastError) state.lastError = this.lastError;
    return state;
  }

  push(): void {
    if (this.pushScheduled) return;
    this.pushScheduled = true;
    setImmediate(() => {
      this.pushScheduled = false;
      this.publish?.(this.getState());
    });
  }

  async refresh(): Promise<void> {
    await this.scan.refresh();
    this.push();
  }

  getSettings(): AppSettings {
    return this.settingsStore.get();
  }

  updateSettings(patch: unknown): AppSettings {
    const before = this.settingsStore.get();
    const after = this.settingsStore.update(patch);
    this.applySettingsEffects(before, after);
    this.push();
    return after;
  }

  getModState(): ModState {
    this.modState = this.safeModState();
    return this.modState;
  }

  async installMod(): Promise<ModOperationResult> {
    let error: string | undefined;
    try {
      this.modState = this.modInstaller.install();
      this.lastError = undefined;
    } catch (installError) {
      error = messageOf(installError);
      this.lastError = "安装 CC mod 失败：" + error;
      this.modState = this.safeModState();
    }
    this.push();
    return error === undefined ? { state: this.modState } : { state: this.modState, error };
  }

  async uninstallMod(): Promise<ModOperationResult> {
    let error: string | undefined;
    try {
      this.modState = this.modInstaller.uninstall();
      this.lastError = undefined;
    } catch (uninstallError) {
      error = messageOf(uninstallError);
      this.lastError = "卸载 CC mod 失败：" + error;
      this.modState = this.safeModState();
    }
    this.push();
    return error === undefined ? { state: this.modState } : { state: this.modState, error };
  }

  getBridgeStatus(): BridgeStatus {
    return this.bridge.status();
  }

  bridgeRefresh(): void {
    this.bridge.refresh();
    this.push();
  }

  getSyncState(): SyncState {
    return this.sync.getState();
  }

  configureServer(patch: Partial<ServerConfig>): AppSettings {
    const before = this.settingsStore.get();
    const after = this.settingsStore.updateServer(patch);
    this.applySettingsEffects(before, after);
    this.push();
    return after;
  }

  async login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    const result = await this.sync.login(username, password);
    this.push();
    return result;
  }

  async register(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    const result = await this.sync.register(username, password);
    this.push();
    return result;
  }

  async logout(): Promise<void> {
    await this.sync.logout();
    this.push();
  }

  async syncNow(): Promise<{ ok: boolean; error?: string }> {
    const result = await this.sync.syncNow();
    this.push();
    return result;
  }

  getPathsInfo(): AppPathsInfo {
    const settings = this.settingsStore.get();
    return {
      appConfigDir: appConfigDir(),
      rateLimitsLog: rateLimitsLogPath(),
      planHistoryLog: planHistoryPath(),
      configFile: claudeConfigFile(settings),
      projectsPath: projectsRoot(settings),
      modDirectory: this.modInstaller.modURL,
    };
  }

  defaultProjectsPath(): string {
    return defaultProjectsPath();
  }

  /** Resolves when the first scan finished (or after the timeout). */
  async waitForFirstScan(timeoutMilliseconds = 20_000): Promise<void> {
    await Promise.race([
      this.firstScanPromise,
      new Promise<void>((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, timeoutMilliseconds);
        timer.unref?.();
      }),
    ]);
  }

  private safeModState(): ModState {
    try {
      return this.modInstaller.state();
    } catch (error) {
      console.error("[main] failed to compute mod state", error);
      return this.modState;
    }
  }

  private handleSnapshot(result: ScanResult): void {
    const snapshot = this.applyAuthHints(result.snapshot);
    this.localSnapshot = snapshot;
    this.scanStats = result.stats;
    this.quota.setLocalSnapshot(snapshot);
    this.modState = this.safeModState();
    this.refreshQuota();
    this.sync.requestSyncSoon();
    this.firstScanResolve?.();
    this.firstScanResolve = undefined;
    this.push();
  }

  private handleBridgeReport(reading: BridgeReading): void {
    if (reading.auth !== undefined) {
      this.authHints.set(reading.sessionId, { ...reading.auth, at: reading.at });
      this.scheduleAuthHintsSave();
      const hinted = this.applyAuthHints(this.localSnapshot);
      if (hinted !== this.localSnapshot) {
        this.localSnapshot = hinted;
        this.quota.setLocalSnapshot(hinted);
        this.mergedCache = undefined;
      }
    }
    this.refreshQuota();
    this.sync.requestSyncSoon();
    this.push();
  }

  // MARK: - Auth hints (mod fingerprint)

  private authHintsPath(): string {
    return join(appConfigDir(), "session-auth.json");
  }

  private loadAuthHints(): void {
    try {
      const path = this.authHintsPath();
      if (!existsSync(path)) return;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, BridgeAuthFingerprint & { at?: number }>;
      for (const [sessionId, hint] of Object.entries(parsed ?? {})) {
        if (hint === null || typeof hint !== "object" || typeof hint.credential !== "string") continue;
        this.authHints.set(sessionId, { ...hint, at: typeof hint.at === "number" ? hint.at : 0 });
      }
    } catch (error) {
      console.warn("[auth] failed to load session auth hints", error);
    }
  }

  private scheduleAuthHintsSave(): void {
    if (this.authHintsSaveTimer !== undefined) return;
    this.authHintsSaveTimer = setTimeout(() => {
      this.authHintsSaveTimer = undefined;
      this.saveAuthHints();
    }, 1_000);
    this.authHintsSaveTimer.unref?.();
  }

  private saveAuthHints(): void {
    try {
      const record: Record<string, BridgeAuthFingerprint & { at: number }> = {};
      for (const [sessionId, hint] of this.authHints) record[sessionId] = hint;
      mkdirSync(appConfigDir(), { recursive: true });
      writeFileSync(this.authHintsPath(), JSON.stringify(record, null, 2) + "\n", "utf8");
    } catch (error) {
      console.warn("[auth] failed to persist session auth hints", error);
    }
  }

  private fingerprintMode(auth: BridgeAuthFingerprint): AuthMode {
    if (auth.thirdPartyBase === true) return "thirdParty";
    switch (auth.credential) {
      case "authToken":
      case "apiKey":
      case "apiKeyHelper":
        return "thirdParty";
      case "managedKey":
      case "oauthToken":
        return "subscription";
      default:
        return "unknown";
    }
  }

  /** Overlay authoritative mod fingerprints onto the scanner's heuristic session verdicts. */
  private applyAuthHints(snapshot: UsageSnapshot): UsageSnapshot {
    if (this.authHints.size === 0) return snapshot;
    let changed = false;
    const sessions = snapshot.sessions.map((session) => {
      const hint = this.authHints.get(session.id);
      if (hint === undefined) return session;
      const mode = this.fingerprintMode(hint);
      if (session.authMode === mode) return session;
      changed = true;
      return { ...session, authMode: mode };
    });
    return changed ? { ...snapshot, sessions } : snapshot;
  }

  /** Server quota is the display quota while sync is online; local quota otherwise. */
  private refreshQuota(): QuotaSnapshot {
    this.applySyncQuota();
    return this.quota.recompute();
  }

  /** Cheap sync update: only rebuild the local quota when the remote inputs actually changed. */
  private applySyncQuota(): void {
    const syncState = this.sync.getState();
    const serverQuota = syncState.status === "online" ? this.sync.getServerQuota() : undefined;
    const remoteObservations = this.sync.getRemoteObservations();
    if (serverQuota === this.serverQuotaRef && remoteObservations === this.remoteObservationsRef) return;
    this.serverQuotaRef = serverQuota;
    this.remoteObservationsRef = remoteObservations;
    this.quota.setServerQuota(serverQuota);
    this.quota.setRemoteObservations(remoteObservations);
    this.quota.recompute();
  }

  /** Cached merge of local + remote entries (CPU heavy for large multi-device snapshots). */
  private mergedSnapshot(): UsageSnapshot {
    const remoteEntries = this.sync.getRemoteEntries();
    if (remoteEntries.length === 0) return this.localSnapshot;
    const deviceNames = this.sync.getDeviceNames();
    const cached = this.mergedCache;
    if (
      cached &&
      cached.local === this.localSnapshot &&
      cached.remoteEntries === remoteEntries &&
      cached.deviceNames === deviceNames
    ) {
      return cached.snapshot;
    }
    const snapshot = this.sync.mergedSnapshot(this.localSnapshot);
    this.mergedCache = { local: this.localSnapshot, remoteEntries, deviceNames, snapshot };
    return snapshot;
  }

  private applySettingsEffects(before: AppSettings, after: AppSettings): void {
    nativeTheme.themeSource = after.theme;
    this.quota.setWindowMode(after.windowMode);
    this.bridge.updatePollMs(bridgePollMs(after));
    if (after.projectsPath !== before.projectsPath) {
      this.modState = this.safeModState();
      void this.scan.refresh();
    }
    if (JSON.stringify(after.server) !== JSON.stringify(before.server)) {
      this.sync.applySettings();
    }
    this.refreshQuota();
  }
}

// MARK: - Windows / tray

let controller: AppController | undefined;
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let trayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function loadWindow(win: BrowserWindow, file: string, query?: Record<string, string>): void {
  if (!existsSync(file)) {
    console.error("[main] missing renderer file (run npm run build:desktop):", file);
    return;
  }
  if (process.env.CCUSAGE_DEBUG) {
    win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level >= 2) console.error("[renderer]", message, "(" + sourceId + ":" + line + ")");
    });
  }
  const load = query ? win.loadFile(file, { query }) : win.loadFile(file);
  load.catch((error: unknown) => console.error("[main] failed to load", file, error));
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "CC 用量",
    show: false,
    backgroundColor: windowBackground(),
    webPreferences: windowPreferences(),
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", (event) => {
    // Tray app: closing the main window hides it (quit from the menu / IPC really quits).
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  loadWindow(win, INDEX_HTML);
  return win;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createSettingsWindow(tab?: string): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  const win = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    title: "设置",
    show: false,
    backgroundColor: windowBackground(),
    webPreferences: windowPreferences(),
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (settingsWindow === win) settingsWindow = null;
  });
  const query: Record<string, string> = { view: "settings" };
  if (tab) query.tab = tab;
  loadWindow(win, INDEX_HTML, query);
  settingsWindow = win;
  return win;
}

function showSettingsWindow(): void {
  createSettingsWindow();
}

function createTrayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: TRAY_WINDOW_WIDTH,
    height: TRAY_WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: windowBackground(),
    webPreferences: windowPreferences(),
  });
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.on("blur", () => {
    if (!win.isDestroyed() && !win.webContents.isDevToolsOpened()) win.hide();
  });
  win.on("closed", () => {
    if (trayWindow === win) trayWindow = null;
  });
  // Auto-size the frameless popover to its content (Swift MenuBarExtra behavior).
  win.webContents.on("did-finish-load", () => scheduleTrayFit(win));
  loadWindow(win, TRAY_HTML);
  return win;
}

/** Measures the popover content and resizes the frameless tray window to fit it. */
function fitTrayWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  const script =
    "(() => { const el = document.querySelector('.tray') || document.body; if (!el) return 0; " +
    "const rect = el.getBoundingClientRect(); return Math.ceil(rect.bottom + (window.scrollY || 0)); })()";
  win.webContents
    .executeJavaScript(script)
    .then((height: unknown) => {
      if (win.isDestroyed() || typeof height !== "number" || !Number.isFinite(height) || height <= 0) return;
      const contentHeight = Math.min(760, Math.max(240, Math.ceil(height) + 2));
      const bounds = win.getBounds();
      if (Math.abs(bounds.height - contentHeight) > 2) {
        win.setBounds({ ...bounds, height: contentHeight });
      }
    })
    .catch(() => undefined);
}

/** The popover renders asynchronously (first AppState + fonts): fit it a few times after load. */
function scheduleTrayFit(win: BrowserWindow): void {
  for (const milliseconds of [0, 120, 400, 900, 1_600]) {
    const timer = setTimeout(() => fitTrayWindow(win), milliseconds);
    timer.unref?.();
  }
}

function positionTrayWindow(win: BrowserWindow): void {
  if (!tray) return;
  const trayBounds = tray.getBounds();
  const anchor = {
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  };
  const workArea = screen.getDisplayNearestPoint(anchor).workArea;
  const bounds = win.getBounds();
  const width = bounds.width || TRAY_WINDOW_WIDTH;
  const height = bounds.height || TRAY_WINDOW_HEIGHT;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  let y = process.platform === "darwin" ? trayBounds.y + trayBounds.height + 4 : trayBounds.y - height - 4;
  x = Math.min(Math.max(x, workArea.x + 4), workArea.x + workArea.width - width - 4);
  y = Math.min(Math.max(y, workArea.y + 4), workArea.y + workArea.height - height - 4);
  win.setBounds({ x, y, width, height });
}

function showTrayWindow(): BrowserWindow {
  if (!trayWindow || trayWindow.isDestroyed()) trayWindow = createTrayWindow();
  positionTrayWindow(trayWindow);
  trayWindow.show();
  trayWindow.focus();
  return trayWindow;
}

function toggleTrayWindow(): void {
  if (!trayWindow || trayWindow.isDestroyed()) {
    trayWindow = createTrayWindow();
    trayWindow.once("ready-to-show", () => positionTrayWindow(trayWindow!));
  }
  if (trayWindow.isVisible()) {
    trayWindow.hide();
    return;
  }
  showTrayWindow();
}

function createTray(): void {
  if (tray) return;
  const iconPath = resolveAsset("trayTemplate.png");
  if (!iconPath) {
    console.warn("[main] tray icon not found (assets/trayTemplate.png)");
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.warn("[main] tray icon is empty:", iconPath);
    return;
  }
  if (process.platform === "darwin") image.setTemplateImage(true);
  try {
    tray = new Tray(image);
  } catch (error) {
    console.error("[main] failed to create tray", error);
    return;
  }
  tray.setToolTip("CC 用量");
  tray.on("click", () => toggleTrayWindow());
}

function trayTitleText(state: AppState): string {
  const percentage = state.quota.status.fiveHour?.percentage;
  if (typeof percentage === "number" && Number.isFinite(percentage)) {
    return "5h " + Math.round(percentage) + "%";
  }
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.getTime();
  let cost = 0;
  for (const entry of state.snapshot.entries) {
    if (entry.timestamp < since) continue;
    cost += entry.cost.input + entry.cost.output + entry.cost.cacheRead + entry.cost.cacheWrite + entry.cost.webSearch;
  }
  return Format.usd(cost);
}

function updateTrayTitle(state: AppState): void {
  if (!tray) return;
  const title = trayTitleText(state);
  if (process.platform === "darwin") {
    tray.setTitle(title);
  }
  tray.setToolTip("CC 用量 · " + title);
}

function publishState(state: AppState): void {
  broadcastState(state);
  updateTrayTitle(state);
  if (trayWindow && !trayWindow.isDestroyed() && trayWindow.isVisible()) fitTrayWindow(trayWindow);
}

function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about", label: "关于 CCUsage" },
        { type: "separator" },
        { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => showSettingsWindow() },
        { type: "separator" },
        { role: "hide", label: "隐藏 CCUsage" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出 CCUsage" },
      ],
    });
  }
  template.push({
    label: "文件",
    submenu: [
      { label: "打开主窗口", accelerator: "CmdOrCtrl+0", click: () => showMainWindow() },
      ...(process.platform === "darwin"
        ? []
        : [{ label: "设置…", accelerator: "CmdOrCtrl+,", click: () => showSettingsWindow() } as MenuItemConstructorOptions]),
      { type: "separator" },
      process.platform === "darwin"
        ? { role: "close", label: "关闭窗口" }
        : { label: "退出", accelerator: "Ctrl+Q", click: () => app.quit() },
    ],
  });
  template.push({
    label: "编辑",
    submenu: [
      { role: "undo", label: "撤销" },
      { role: "redo", label: "重做" },
      { type: "separator" },
      { role: "cut", label: "剪切" },
      { role: "copy", label: "复制" },
      { role: "paste", label: "粘贴" },
      { role: "selectAll", label: "全选" },
    ],
  });
  template.push({
    label: "视图",
    submenu: [
      { role: "reload", label: "重新载入" },
      { role: "toggleDevTools", label: "开发者工具" },
      { type: "separator" },
      { role: "resetZoom", label: "实际大小" },
      { role: "zoomIn", label: "放大" },
      { role: "zoomOut", label: "缩小" },
    ],
  });
  template.push({
    label: "窗口",
    submenu: [
      { role: "minimize", label: "最小化" },
      { role: "zoom", label: "缩放" },
      ...(process.platform === "darwin"
        ? [{ type: "separator" as const }, { role: "front" as const, label: "前置全部窗口" }]
        : []),
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// MARK: - IPC wiring

async function chooseDirectory(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "选择会话记录目录",
    properties: ["openDirectory", "showHiddenFiles", "createDirectory"],
  };
  const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

function makeIpcHandlers(appController: AppController): IpcHandlers {
  return {
    getState: () => appController.getState(),
    refresh: () => appController.refresh(),
    getSettings: () => appController.getSettings(),
    updateSettings: (patch) => appController.updateSettings(patch),
    getModState: () => appController.getModState(),
    installMod: () => appController.installMod(),
    uninstallMod: () => appController.uninstallMod(),
    getBridgeStatus: () => appController.getBridgeStatus(),
    bridgeRefresh: () => appController.bridgeRefresh(),
    getSyncState: () => appController.getSyncState(),
    syncConfigure: (patch) => appController.configureServer(patch),
    syncLogin: (username, password) => appController.login(username, password),
    syncRegister: (username, password) => appController.register(username, password),
    syncLogout: () => appController.logout(),
    syncNow: () => appController.syncNow(),
    openMainWindow: () => showMainWindow(),
    openSettings: () => showSettingsWindow(),
    quit: () => app.quit(),
    chooseDirectory: () => chooseDirectory(),
    getPaths: () => appController.getPathsInfo(),
    defaultProjectsPath: () => appController.defaultProjectsPath(),
  };
}

// MARK: - Screenshot mode (scripts/screenshot.ts)

async function waitForWindowLoad(win: BrowserWindow, timeoutMilliseconds = 10_000): Promise<void> {
  if (!win.webContents.isLoading()) return;
  await new Promise<void>((resolveLoad) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolveLoad();
    };
    win.webContents.once("did-finish-load", done);
    const timer = setTimeout(done, timeoutMilliseconds);
    timer.unref?.();
  });
}

async function captureWindow(win: BrowserWindow | null, path: string): Promise<void> {
  if (!win || win.isDestroyed()) {
    console.warn("[screenshot] no window for", path);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  await delay(200);
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  writeFileSync(path, png);
  console.log("[screenshot] wrote", path, "(" + png.length + " bytes)");
}

async function runScreenshotMode(appController: AppController): Promise<void> {
  const directory = process.env.CCUSAGE_SCREENSHOT_DIR;
  if (!directory) return;
  const targetDirectory = resolve(directory);
  const parsedWait = Number.parseInt(process.env.CCUSAGE_SCREENSHOT_WAIT_MS ?? "", 10);
  const mainWait = Number.isFinite(parsedWait) && parsedWait > 0 ? parsedWait : 2_500;
  try {
    mkdirSync(targetDirectory, { recursive: true });
    await appController.waitForFirstScan(25_000);
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
    await waitForWindowLoad(mainWindow);
    await delay(mainWait);
    await captureWindow(mainWindow, join(targetDirectory, "main.png"));

    const settings = createSettingsWindow("server");
    await waitForWindowLoad(settings);
    settings.show();
    await delay(1_500);
    await captureWindow(settings, join(targetDirectory, "settings.png"));

    const trayPopover = showTrayWindow();
    await waitForWindowLoad(trayPopover);
    trayPopover.show();
    await delay(1_000);
    await captureWindow(trayPopover, join(targetDirectory, "tray.png"));

    // Device detail page (per-day usage + peer session titles), when the harness names a device.
    const screenshotDevice = process.env.CCUSAGE_SCREENSHOT_DEVICE;
    if (screenshotDevice && screenshotDevice.length > 0) {
      const deviceWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 960,
        minHeight: 640,
        title: "CC 用量 · 设备",
        show: false,
        backgroundColor: windowBackground(),
        webPreferences: windowPreferences(),
      });
      loadWindow(deviceWindow, INDEX_HTML, { view: "device", device: screenshotDevice });
      await waitForWindowLoad(deviceWindow);
      deviceWindow.show();
      await delay(1_500);
      await captureWindow(deviceWindow, join(targetDirectory, "device.png"));
    }
  } catch (error) {
    console.error("[screenshot] failed:", error);
  } finally {
    await delay(300);
    isQuitting = true;
    app.quit();
  }
}

// MARK: - Bootstrap

const APP_VERSION = readAppVersion();

async function bootstrap(): Promise<void> {
  app.setName(APP_NAME);
  if (process.platform === "win32") app.setAppUserModelId("com.ccusage.app");
  app.setAboutPanelOptions({ applicationName: "CCUsage", applicationVersion: APP_VERSION, copyright: "CCUsage 2.0" });

  await app.whenReady();
  nativeTheme.themeSource = "system";

  const appController = new AppController();
  controller = appController;

  mainWindow = createMainWindow();
  createTray();
  buildAppMenu();
  appController.publish = publishState;
  registerIpc(makeIpcHandlers(appController));

  if (process.platform === "darwin" && app.dock) {
    const iconPath = resolveAsset("icon.png");
    if (iconPath) {
      try {
        app.dock.setIcon(iconPath);
      } catch {
        // dock icon is cosmetic
      }
    }
  }

  app.on("activate", () => showMainWindow());
  app.on("window-all-closed", () => {
    // Menu-bar/tray app: keep running without windows (quit from the menu or the tray).
  });

  await appController.start();
  publishState(appController.getState());

  if (process.env.CCUSAGE_SCREENSHOT_DIR) {
    await runScreenshotMode(appController);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.on("before-quit", () => {
    isQuitting = true;
  });
  app.on("will-quit", () => {
    if (!controller) return;
    void controller.shutdown();
    if (process.platform !== "darwin") {
      // Ensure the Unix socket / bridge.json disappear even if shutdown's close callback is delayed.
      try {
        controller.bridge.cleanupOnExit();
      } catch {
        // ignore
      }
    }
  });
  app.on("quit", () => {
    tray?.destroy();
    tray = null;
  });

  process.on("exit", () => {
    try {
      controller?.bridge.cleanupOnExit();
    } catch {
      // ignore
    }
  });

  void bootstrap().catch((error: unknown) => {
    console.error("[main] fatal startup error", error);
    app.exit(1);
  });
}