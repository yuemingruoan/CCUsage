// Local HTTP bridge for the Claude Code mod (CONTRACTS.md §5).
//
// The app hosts a tiny HTTP server — over a Unix socket at <appConfigDir>/bridge.sock on
// macOS/Linux, over a loopback TCP port on Windows (and as a fallback when the socket path is too
// long for sun_path) — and writes bridge.json so the mod knows where to report. Every accepted
// POST /report updates the latest reading, appends a line to the legacy rate-limits.jsonl log
// (the Swift app's format, which the quota code reads) and notifies the app.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { BridgeConfig, BridgeReading, BridgeReportResponse, BridgeStatus } from "@ccusage/core";
import { bridgeConfigPath, bridgeSocketPath } from "./settings.js";

const MAX_BODY_BYTES = 1_048_576;
/** Sunny unix sockets are limited to ~104 bytes on macOS / 108 on Linux. */
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface BridgeServerOptions {
  appVersion: string;
  getRateLimitsLogPath: () => string;
  getDeviceId: () => string;
  getDeviceName: () => string;
  /** Mod heartbeat interval; derived from the refresh interval setting. */
  getPollMs: () => number;
  onReport: (reading: BridgeReading) => void;
  /** Called whenever the bridge status changes (refreshId, pollMs, last report, listening). */
  onStatusChange?: () => void;
}

class BridgeHttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Epoch milliseconds -> epoch seconds (the legacy log stores seconds). */
function toEpochSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
}

function normalizeKind(kind: string): string {
  return kind.trim().toLowerCase().replace(/-/g, "_");
}

/** Accepts the BridgeReading shape (plus snake_case), returns a validated reading. */
export function normalizeBridgeReading(input: unknown, now = Date.now()): BridgeReading | null {
  if (!isObject(input)) return null;
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : typeof input.session_id === "string" ? input.session_id : undefined;
  if (!sessionId) return null;
  const rawLimits = Array.isArray(input.rateLimits) ? input.rateLimits : Array.isArray(input.rate_limits) ? input.rate_limits : [];
  const rateLimits: BridgeReading["rateLimits"] = [];
  for (const rawLimit of rawLimits) {
    if (!isObject(rawLimit)) continue;
    const kind = typeof rawLimit.kind === "string" ? rawLimit.kind : typeof rawLimit.type === "string" ? rawLimit.type : undefined;
    const percentUsed = toFiniteNumber(rawLimit.percentUsed ?? rawLimit.percent_used ?? rawLimit.usedPercentage);
    if (!kind || percentUsed === undefined) continue;
    const resetsAt = toFiniteNumber(rawLimit.resetsAt ?? rawLimit.resets_at);
    const limit: BridgeReading["rateLimits"][number] = { kind, percentUsed };
    if (resetsAt !== undefined) limit.resetsAt = resetsAt;
    rateLimits.push(limit);
  }
  const reading: BridgeReading = {
    sessionId,
    at: toFiniteNumber(input.at) ?? now,
    rateLimits,
  };
  if (typeof input.entrypoint === "string") reading.entrypoint = input.entrypoint;
  if (typeof input.changed === "boolean") reading.changed = input.changed;
  const rawCost = isObject(input.cost) ? input.cost : undefined;
  const usd = rawCost ? toFiniteNumber(rawCost.usd) : undefined;
  if (usd !== undefined) reading.cost = { usd };
  return reading;
}

export class BridgeServer extends EventEmitter {
  private readonly options: BridgeServerOptions;
  private server: HttpServer | undefined;
  private socketPath = "";
  private url: string | undefined;
  private readonly token = randomBytes(16).toString("hex");
  private pollMs: number;
  private refreshId = 0;
  private pendingRefresh = false;
  private listening = false;
  private lastReportAt: number | undefined;
  private lastSessionId: string | undefined;
  private lastReading: BridgeReading | undefined;
  private readonly sessions = new Map<string, number>();
  private closePromise: Promise<void> | undefined;

  constructor(options: BridgeServerOptions) {
    super();
    this.options = options;
    this.pollMs = Math.max(1_000, Math.round(options.getPollMs()));
  }

  get currentToken(): string {
    return this.token;
  }

  get latestReading(): BridgeReading | undefined {
    return this.lastReading;
  }

  get isListening(): boolean {
    return this.listening;
  }

  status(): BridgeStatus {
    const sessions = [...this.sessions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sessionId]) => sessionId)
      .slice(0, 8);
    const status: BridgeStatus = {
      listening: this.listening,
      socketPath: this.socketPath,
      pollMs: this.pollMs,
      refreshId: this.refreshId,
      sessions,
    };
    if (this.lastReportAt !== undefined) status.lastReportAt = this.lastReportAt;
    if (this.lastSessionId !== undefined) status.lastSessionId = this.lastSessionId;
    return status;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const socketPath = bridgeSocketPath();
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown) => {
          server.off("error", onError);
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        server.once("error", onError);
        const useTcp = process.platform === "win32" || Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES;
        if (useTcp) {
          server.listen(0, "127.0.0.1", () => {
            server.off("error", onError);
            const address = server.address();
            if (address && typeof address === "object") {
              this.url = "http://127.0.0.1:" + address.port;
              this.socketPath = "";
              resolve();
            } else {
              reject(new Error("bridge: failed to allocate a loopback port"));
            }
          });
        } else {
          mkdirSync(dirname(socketPath), { recursive: true });
          try {
            rmSync(socketPath, { force: true });
          } catch {
            // stale socket already gone
          }
          this.socketPath = socketPath;
          server.listen(socketPath, () => {
            server.off("error", onError);
            resolve();
          });
        }
      });
    } catch (error) {
      this.server = undefined;
      try {
        server.close();
      } catch {
        // ignore
      }
      throw error;
    }
    this.listening = true;
    this.writeConfig();
    this.emit("status");
    this.options.onStatusChange?.();
  }

  /** Synchronous best-effort cleanup used from process exit handlers (socket + bridge.json). */
  cleanupOnExit(): void {
    if (process.platform !== "win32" && this.socketPath) {
      try {
        rmSync(this.socketPath, { force: true });
      } catch {
        // ignore
      }
    }
    try {
      rmSync(bridgeConfigPath(), { force: true });
    } catch {
      // ignore
    }
  }

  /** Bumps refreshId so the mod reports again on its next tick; the next report replies reportNow:true. */
  refresh(): BridgeStatus {
    this.refreshId += 1;
    this.pendingRefresh = true;
    if (this.listening) this.writeConfig();
    this.emit("status");
    this.options.onStatusChange?.();
    return this.status();
  }

  updatePollMs(pollMs: number): void {
    const next = Math.max(1_000, Math.round(pollMs));
    if (next === this.pollMs) return;
    this.pollMs = next;
    if (this.listening) this.writeConfig();
    this.emit("status");
    this.options.onStatusChange?.();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.listening = false;
      const server = this.server;
      this.server = undefined;
      if (server) {
        try {
          server.closeAllConnections?.();
        } catch {
          // older Node: connections close on their own
        }
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          server.close(done);
          // Never hang app shutdown on a keep-alive mod connection.
          const timer = setTimeout(done, 300);
          timer.unref?.();
        });
      }
      if (process.platform !== "win32" && this.socketPath) {
        try {
          rmSync(this.socketPath, { force: true });
        } catch {
          // ignore
        }
      }
      try {
        rmSync(bridgeConfigPath(), { force: true });
      } catch {
        // ignore
      }
      this.emit("status");
      this.options.onStatusChange?.();
    })();
    return this.closePromise;
  }

  private writeConfig(): void {
    const config: BridgeConfig & { url?: string } = {
      version: 1,
      socketPath: this.socketPath,
      token: this.token,
      pollMs: this.pollMs,
      refreshId: this.refreshId,
      appVersion: this.options.appVersion,
    };
    if (this.url) config.url = this.url;
    const path = bridgeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    const temp = path + ".tmp-" + process.pid;
    writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", "utf8");
    renameSync(temp, path);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    try {
      if (request.method === "GET" && pathname === "/status") {
        this.respond(response, 200, this.status());
        return;
      }
      if (request.method === "POST" && pathname === "/report") {
        await this.handleReport(request, response);
        return;
      }
      this.respond(response, 404, { ok: false, error: "not found" });
    } catch (error) {
      const statusCode = error instanceof BridgeHttpError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : String(error);
      this.respond(response, statusCode, { ok: false, error: message });
    }
  }

  private async handleReport(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const providedToken = request.headers["x-ccusage-token"];
    const token = Array.isArray(providedToken) ? providedToken[0] : providedToken;
    if (token !== this.token) {
      throw new BridgeHttpError(401, "unauthorized");
    }
    let body: string;
    try {
      body = await this.readBody(request);
    } catch (error) {
      if (error instanceof BridgeHttpError) throw error;
      throw new BridgeHttpError(400, "failed to read request body");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      throw new BridgeHttpError(400, "invalid JSON");
    }
    const reading = normalizeBridgeReading(parsed);
    if (!reading) throw new BridgeHttpError(400, "invalid reading");

    this.lastReading = reading;
    this.lastReportAt = Date.now();
    this.lastSessionId = reading.sessionId;
    this.sessions.set(reading.sessionId, this.lastReportAt);
    this.pruneSessions();
    try {
      this.appendLegacyLine(reading);
    } catch (error) {
      console.error("[bridge] failed to append rate-limits log", error);
    }

    const reportNow = this.pendingRefresh;
    this.pendingRefresh = false;
    const reply: BridgeReportResponse = {
      ok: true,
      pollMs: this.pollMs,
      reportNow,
      refreshId: this.refreshId,
    };
    this.respond(response, 200, reply);
    this.emit("status");
    try {
      this.options.onReport(reading);
    } catch (error) {
      console.error("[bridge] report handler failed", error);
    }
    this.options.onStatusChange?.();
  }

  private appendLegacyLine(reading: BridgeReading): void {
    const record: Record<string, unknown> = {
      ts: toEpochSeconds(reading.at) ?? Math.floor(Date.now() / 1000),
      session_id: reading.sessionId,
    };
    const deviceId = this.options.getDeviceId();
    if (deviceId) record.device_id = deviceId;
    const deviceName = this.options.getDeviceName();
    if (deviceName) record.device_name = deviceName;
    if (reading.entrypoint) record.entrypoint = reading.entrypoint;
    if (reading.cost) record.cost = reading.cost;
    for (const limit of reading.rateLimits) {
      const kind = normalizeKind(limit.kind);
      if (kind !== "five_hour" && kind !== "seven_day") continue;
      record[kind] = { used_percentage: limit.percentUsed, resets_at: toEpochSeconds(limit.resetsAt) };
    }
    if (!("five_hour" in record) && !("seven_day" in record)) return;
    const path = this.options.getRateLimitsLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  }

  private pruneSessions(): void {
    const cutoff = Date.now() - SESSION_RETENTION_MS;
    for (const [sessionId, seenAt] of this.sessions) {
      if (seenAt < cutoff) this.sessions.delete(sessionId);
    }
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new BridgeHttpError(413, "payload too large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", (error) => reject(error));
    });
  }

  private respond(response: ServerResponse, statusCode: number, body: unknown): void {
    if (response.headersSent || response.writableEnded) return;
    try {
      response.statusCode = statusCode;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(body));
    } catch (error) {
      console.error("[bridge] failed to write response", error);
    }
  }
}
