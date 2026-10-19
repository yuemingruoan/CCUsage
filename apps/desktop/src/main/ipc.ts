// Main-process IPC handlers (CONTRACTS.md §4) and AppState broadcasting.
import { BrowserWindow, ipcMain } from "electron";
import type { AppSettings, AppState, BridgeStatus, ModState, ServerConfig, SyncState } from "@ccusage/core";
import { IPC } from "@ccusage/core";

/**
 * Channels beyond the ones listed in CONTRACTS §4. The renderer feature-detects these
 * (settings folder picker, rate-limits log path display); they are additive, not contract changes.
 */
export const EXTRA_IPC = {
  syncRegister: "sync:register",
  syncStatus: "sync:status",
  chooseDirectory: "dialog:chooseDirectory",
  getPaths: "app:paths",
  defaultProjectsPath: "app:defaultProjectsPath",
} as const;

export interface AppPathsInfo {
  appConfigDir: string;
  rateLimitsLog: string;
  planHistoryLog: string;
  configFile: string;
  projectsPath: string;
  modDirectory: string;
}

export interface ModOperationResult {
  state: ModState;
  error?: string;
}

export interface IpcHandlers {
  getState(): AppState;
  refresh(): Promise<void>;
  getSettings(): AppSettings;
  updateSettings(patch: unknown): AppSettings;
  getModState(): ModState;
  installMod(): Promise<ModOperationResult>;
  uninstallMod(): Promise<ModOperationResult>;
  getBridgeStatus(): BridgeStatus;
  bridgeRefresh(): void;
  getSyncState(): SyncState;
  syncConfigure(patch: Partial<ServerConfig>): AppSettings;
  syncLogin(username: string, password: string): Promise<{ ok: boolean; error?: string }>;
  syncRegister(username: string, password: string): Promise<{ ok: boolean; error?: string }>;
  syncLogout(): Promise<void>;
  syncNow(): Promise<{ ok: boolean; error?: string }>;
  openMainWindow(): void;
  openSettings(): void;
  quit(): void;
  chooseDirectory(): Promise<string | null>;
  getPaths(): AppPathsInfo;
  /** Default ~/.claude/projects (or <demo>/projects) for the settings "默认" button. */
  defaultProjectsPath(): string;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asServerPatch(value: unknown): Partial<ServerConfig> {
  if (typeof value !== "object" || value === null) return {};
  return value as Partial<ServerConfig>;
}

export function registerIpc(handlers: IpcHandlers): void {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => handler(...args));
  };

  // App state
  handle(IPC.stateGet, () => handlers.getState());
  handle(IPC.refresh, () => handlers.refresh());
  handle(IPC.quit, () => handlers.quit());
  handle(IPC.openMainWindow, () => handlers.openMainWindow());
  handle(IPC.openSettings, () => handlers.openSettings());

  // Settings
  handle(IPC.settingsGet, () => handlers.getSettings());
  handle(IPC.settingsUpdate, (patch) => handlers.updateSettings(patch));

  // Mod installer
  handle(IPC.modStateGet, () => handlers.getModState());
  handle(IPC.modInstall, () => handlers.installMod());
  handle(IPC.modUninstall, () => handlers.uninstallMod());

  // Mod bridge
  handle(IPC.bridgeStatus, () => handlers.getBridgeStatus());
  handle(IPC.bridgeRefresh, () => handlers.bridgeRefresh());

  // Sync
  handle(IPC.syncNow, () => handlers.syncNow());
  handle(IPC.syncLogin, (username, password) => handlers.syncLogin(asString(username), asString(password)));
  handle(IPC.syncLogout, () => handlers.syncLogout());
  handle(IPC.syncConfigure, (patch) => handlers.syncConfigure(asServerPatch(patch)));
  handle(EXTRA_IPC.syncRegister, (username, password) => handlers.syncRegister(asString(username), asString(password)));
  handle(IPC.serverAccounts, () => []);
  handle(IPC.demoSeed, () => ({ ok: true }));

  // Extra channels used by the renderer when available (feature-detected).
  handle(EXTRA_IPC.syncStatus, () => handlers.getSyncState());
  handle(EXTRA_IPC.chooseDirectory, () => handlers.chooseDirectory());
  handle(EXTRA_IPC.getPaths, () => handlers.getPaths());
  handle(EXTRA_IPC.defaultProjectsPath, () => handlers.defaultProjectsPath());
}

/** Push an AppState to every open renderer (main, settings, tray popover). */
export function broadcastState(state: AppState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(IPC.stateUpdated, state);
    } catch (error) {
      console.error("[ipc] failed to push state", error);
    }
  }
}

export function unregisterIpc(): void {
  for (const channel of Object.values(IPC)) {
    if (channel === IPC.stateUpdated) continue;
    ipcMain.removeHandler(channel);
  }
  ipcMain.removeHandler(EXTRA_IPC.syncRegister);
  ipcMain.removeHandler(EXTRA_IPC.syncStatus);
  ipcMain.removeHandler(EXTRA_IPC.chooseDirectory);
  ipcMain.removeHandler(EXTRA_IPC.getPaths);
  ipcMain.removeHandler(EXTRA_IPC.defaultProjectsPath);
}
