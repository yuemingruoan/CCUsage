// Preload: exposes window.ccusage (CONTRACTS.md §4) to the renderer with context isolation.
import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, AppState, BridgeStatus, ModState, ServerConfig, SyncState } from "@ccusage/core";

/** Paths surfaced for the settings UI (read-only display). */
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

const CHANNELS = {
  stateGet: "app:state:get",
  stateUpdated: "app:state:updated",
  refresh: "app:refresh",
  openMainWindow: "app:window:main",
  openSettings: "app:window:settings",
  quit: "app:quit",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  modStateGet: "mod:state",
  modInstall: "mod:install",
  modUninstall: "mod:uninstall",
  bridgeStatus: "bridge:status",
  bridgeRefresh: "bridge:refresh",
  syncNow: "sync:now",
  syncLogin: "sync:login",
  syncRegister: "sync:register",
  syncStatus: "sync:status",
  syncLogout: "sync:logout",
  syncConfigure: "sync:configure",
  chooseDirectory: "dialog:chooseDirectory",
  getPaths: "app:paths",
  defaultProjectsPath: "app:defaultProjectsPath",
} as const;

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api = {
  getState: (): Promise<AppState> => invoke<AppState>(CHANNELS.stateGet),
  onState: (callback: (state: AppState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState): void => callback(state);
    ipcRenderer.on(CHANNELS.stateUpdated, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.stateUpdated, listener);
    };
  },
  refresh: (): Promise<void> => invoke<void>(CHANNELS.refresh),
  bridgeRefresh: (): Promise<void> => invoke<void>(CHANNELS.bridgeRefresh),
  getSettings: (): Promise<AppSettings> => invoke<AppSettings>(CHANNELS.settingsGet),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => invoke<AppSettings>(CHANNELS.settingsUpdate, patch),
  getModState: (): Promise<ModState> => invoke<ModState>(CHANNELS.modStateGet),
  installMod: (): Promise<ModOperationResult> => invoke<ModOperationResult>(CHANNELS.modInstall),
  uninstallMod: (): Promise<ModOperationResult> => invoke<ModOperationResult>(CHANNELS.modUninstall),
  getBridgeStatus: (): Promise<BridgeStatus> => invoke<BridgeStatus>(CHANNELS.bridgeStatus),
  sync: {
    status: (): Promise<SyncState> => invoke<SyncState>(CHANNELS.syncStatus),
    configure: (patch: Partial<ServerConfig>): Promise<AppSettings> => invoke<AppSettings>(CHANNELS.syncConfigure, patch),
    login: (username: string, password: string): Promise<{ ok: boolean; error?: string }> =>
      invoke<{ ok: boolean; error?: string }>(CHANNELS.syncLogin, username, password),
    register: (username: string, password: string): Promise<{ ok: boolean; error?: string }> =>
      invoke<{ ok: boolean; error?: string }>(CHANNELS.syncRegister, username, password),
    logout: (): Promise<void> => invoke<void>(CHANNELS.syncLogout),
    now: (): Promise<{ ok: boolean; error?: string }> => invoke<{ ok: boolean; error?: string }>(CHANNELS.syncNow),
  },
  /** Folder picker for the settings 通用 tab (optional; renderer feature-detects). */
  chooseDirectory: (): Promise<string | null> => invoke<string | null>(CHANNELS.chooseDirectory),
  /** Read-only path info for the settings UI (optional; renderer feature-detects). */
  getPaths: (): Promise<AppPathsInfo> => invoke<AppPathsInfo>(CHANNELS.getPaths),
  /** Default projects directory for the settings "默认" button (optional; renderer feature-detects). */
  defaultProjectsPath: (): Promise<string> => invoke<string>(CHANNELS.defaultProjectsPath),
  openMainWindow: (): Promise<void> => invoke<void>(CHANNELS.openMainWindow),
  openSettings: (): Promise<void> => invoke<void>(CHANNELS.openSettings),
  quit: (): Promise<void> => invoke<void>(CHANNELS.quit),
  platform: process.platform,
};

export type CcusageApi = typeof api;

contextBridge.exposeInMainWorld("ccusage", api);

declare global {
  interface Window {
    ccusage: CcusageApi;
  }
}
