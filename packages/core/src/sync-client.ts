// Sync client used by the Electron main process (CONTRACTS §"sync client").
//
// Plain fetch calls against the self-hosted Express server; bearer token auth, JSON bodies,
// and non-2xx responses mapped to Error(message) using the server's { error } payload.

import type {
  AccountInfo,
  DeviceInfo,
  LoginResponse,
  QuotaSnapshot,
  SyncIngestRequest,
  SyncIngestResponse,
  SyncPullResponse,
  WindowMode
} from "./types.js";

export interface SyncClientOptions {
  /** Server base URL, e.g. "http://127.0.0.1:8787" or with a path prefix. */
  url: string;
  token?: string;
}

export interface SyncStateResponse {
  account: AccountInfo;
  devices: DeviceInfo[];
  quota: QuotaSnapshot;
}

export class SyncClient {
  private baseUrl: string;
  private token: string | undefined;

  constructor(options: SyncClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.token = options.token;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  /** Creates the account, then logs in to obtain a token + device registration. */
  async signup(username: string, password: string, device: DeviceInfo): Promise<LoginResponse> {
    const created = await this.request<Partial<LoginResponse>>("POST", "/api/v1/accounts", {
      username,
      password
    }, false);
    // The contract's POST /accounts returns { account }; logging in afterwards yields the
    // token and registers the device. Servers that answer with a full LoginResponse skip it.
    if (created.token !== undefined && created.account !== undefined && created.deviceId !== undefined) {
      this.token = created.token;
      return { token: created.token, account: created.account, deviceId: created.deviceId };
    }
    return this.login(username, password, device);
  }

  async login(username: string, password: string, device: DeviceInfo): Promise<LoginResponse> {
    const response = await this.request<LoginResponse>("POST", "/api/v1/login", {
      username,
      password,
      device
    }, false);
    this.token = response.token;
    return response;
  }

  /** Revokes this device's token on the server (extra helper; not in CONTRACTS §6). */
  async logout(deviceId: string): Promise<void> {
    await this.request<void>("POST", "/api/v1/logout", { deviceId });
    this.token = undefined;
  }

  async ingest(request: SyncIngestRequest): Promise<SyncIngestResponse> {
    return this.request<SyncIngestResponse>("POST", "/api/v1/ingest", request);
  }

  async pull(since?: number, mode?: WindowMode): Promise<SyncPullResponse> {
    const query = new URLSearchParams();
    if (since !== undefined) query.set("since", String(since));
    if (mode !== undefined) query.set("mode", mode);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<SyncPullResponse>("GET", `/api/v1/sync${suffix}`);
  }

  async state(): Promise<SyncStateResponse> {
    return this.request<SyncStateResponse>("GET", "/api/v1/state");
  }

  /** Health probe; returns false instead of throwing (used by the polling logic). */
  async health(): Promise<boolean> {
    try {
      await this.request<{ ok: boolean }>("GET", "/api/v1/health", undefined, false);
      return true;
    } catch {
      return false;
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    authenticated = true
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authenticated) {
      if (this.token === undefined) throw new Error("未登录：缺少访问令牌");
      headers["authorization"] = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`无法连接服务器：${message}`);
    }

    const text = await response.text();
    if (!response.ok) {
      let message: string | undefined;
      if (text.length > 0) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const errorField = (parsed as Record<string, unknown>)["error"];
            if (typeof errorField === "string") message = errorField;
          }
        } catch {
          // Not JSON; fall back to the raw body below.
        }
      }
      throw new Error(message ?? `服务器返回 ${response.status} ${response.statusText}`.trim());
    }

    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("服务器返回了无效的 JSON");
    }
  }
}
