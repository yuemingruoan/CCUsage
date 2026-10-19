// window.ccusage — preload bridge implemented by app-shell (docs/CONTRACTS.md §Electron IPC).
// Every method resolves JSON-safe values; failures reject Error(msg).
import type {
  AppSettings,
  AppState,
  BridgeStatus,
  ModState,
  ServerConfig,
  SyncState,
} from "@ccusage/core/pure";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface ModActionResult {
  state: ModState;
  error?: string;
}

export interface CcusageApi {
  getState(): Promise<AppState>;
  onState(cb: (state: AppState) => void): () => void;
  /** Transcript rescan. */
  refresh(): Promise<void>;
  /** Bump bridge refreshId so the Claude Code mod reports at once. */
  bridgeRefresh(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  getModState(): Promise<ModState>;
  installMod(): Promise<ModActionResult>;
  uninstallMod(): Promise<ModActionResult>;
  getBridgeStatus(): Promise<BridgeStatus>;
  sync: {
    status(): Promise<SyncState>;
    configure(patch: Partial<ServerConfig>): Promise<AppSettings>;
    login(username: string, password: string): Promise<ActionResult>;
    register(username: string, password: string): Promise<ActionResult>;
    logout(): Promise<void>;
    now(): Promise<ActionResult>;
  };
  openMainWindow(): Promise<void>;
  openSettings(): Promise<void>;
  quit(): Promise<void>;

  /**
   * Optional extensions beyond CONTRACTS §4, implemented by app-shell's preload.
   * Feature-detected by the renderer; absent is handled gracefully.
   */
  chooseDirectory?(): Promise<string | null>;
  defaultProjectsPath?(): Promise<string>;
  getPaths?(): Promise<CcusagePaths>;
  platform?: string;
}

export interface CcusagePaths {
  appConfigDir: string;
  rateLimitsLog: string;
  planHistoryLog: string;
  configFile: string;
  projectsPath: string;
  modDirectory: string;
}

declare global {
  interface Window {
    ccusage: CcusageApi;
  }
}

export {};
