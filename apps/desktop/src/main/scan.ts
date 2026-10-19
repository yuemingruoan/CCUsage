// Periodic transcript scanning (UsageStore.refresh in the Swift app).
//
// The initial scan runs immediately; afterwards the service rescans every
// settings.refreshIntervalSeconds. Scanning happens in a worker thread (dist/scanner-worker.cjs)
// so a large ~/.claude tree never blocks the Electron main process; if the worker cannot be
// started the service transparently falls back to scanning in-process.
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ScanStats, UsageSnapshot } from "@ccusage/core";
import { UsageScanner } from "@ccusage/core";

export interface ScanPaths {
  projectsRoot: string;
  configFile: string;
}

export interface ScanResult {
  snapshot: UsageSnapshot;
  stats: ScanStats;
}

interface PendingWorkerScan {
  resolve: (snapshot: UsageSnapshot) => void;
  reject: (error: Error) => void;
}

const MIN_INTERVAL_SECONDS = 5;
const WORKER_FILE = "scanner-worker.cjs";

export class ScanService extends EventEmitter {
  private worker: Worker | undefined;
  private workerBroken = false;
  private readonly pendingWorkerScans = new Map<number, PendingWorkerScan>();
  private nextWorkerScanId = 1;
  private fallbackScanner: UsageScanner | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private currentScan: Promise<ScanResult> | undefined;
  private lastScanResult: ScanResult | undefined;

  constructor(
    private readonly getPaths: () => ScanPaths,
    private readonly getIntervalSeconds: () => number,
  ) {
    super();
  }

  /** Snapshot from the most recent completed scan. */
  get latest(): ScanResult | undefined {
    return this.lastScanResult;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.terminateWorker(new Error("scan service stopped"));
  }

  /** Force an immediate rescan (IPC "app:refresh" / tray refresh) and return after it emitted. */
  async refresh(): Promise<ScanResult | undefined> {
    this.clearTimer();
    try {
      return await this.runScan();
    } catch (error) {
      console.error("[scan] refresh failed", error);
      return this.lastScanResult;
    } finally {
      this.scheduleNext();
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private scheduleNext(): void {
    const seconds = this.getIntervalSeconds();
    this.schedule(Math.max(MIN_INTERVAL_SECONDS, seconds) * 1000);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.runScan();
    } catch (error) {
      console.error("[scan] periodic scan failed", error);
      this.emit("scanError", error);
    } finally {
      this.scheduleNext();
    }
  }

  private runScan(): Promise<ScanResult> {
    if (this.currentScan) return this.currentScan;
    const scan = this.doScan().finally(() => {
      if (this.currentScan === scan) this.currentScan = undefined;
    });
    this.currentScan = scan;
    return scan;
  }

  private async doScan(): Promise<ScanResult> {
    const paths = this.getPaths();
    const startedAt = Date.now();
    let snapshot: UsageSnapshot | undefined;
    const worker = this.ensureWorker();
    if (worker) {
      try {
        snapshot = await this.scanInWorker(worker, paths);
      } catch (error) {
        console.error("[scan] worker scan failed, falling back to main thread", error);
        this.workerBroken = true;
        this.terminateWorker(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!snapshot) snapshot = await this.scanInProcess(paths);
    const stats: ScanStats = {
      fileCount: snapshot.fileCount,
      scanDurationMs: Date.now() - startedAt,
      scannedAt: Date.now(),
    };
    this.lastScanResult = { snapshot, stats };
    const result = this.lastScanResult;
    this.emit("snapshot", result);
    return result;
  }

  private scanInProcess(paths: ScanPaths): Promise<UsageSnapshot> {
    this.fallbackScanner ??= new UsageScanner();
    return this.fallbackScanner.scan(paths.projectsRoot, paths.configFile);
  }

  private ensureWorker(): Worker | undefined {
    if (this.workerBroken) return undefined;
    if (this.worker) return this.worker;
    const workerPath = join(__dirname, WORKER_FILE);
    if (!existsSync(workerPath)) {
      console.warn("[scan] worker bundle missing, scanning in the main process:", workerPath);
      this.workerBroken = true;
      return undefined;
    }
    try {
      const worker = new Worker(workerPath);
      worker.unref();
      worker.on("message", (message: unknown) => this.handleWorkerMessage(message));
      worker.on("error", (error) => {
        console.error("[scan] worker error", error);
        this.workerBroken = true;
        this.terminateWorker(error instanceof Error ? error : new Error(String(error)));
      });
      worker.on("exit", (code) => {
        if (this.worker === worker) this.worker = undefined;
        if (!this.stopped && code !== 0) {
          this.workerBroken = true;
          this.rejectPendingWorkerScans(new Error("scanner worker exited with code " + code));
        }
      });
      this.worker = worker;
      return worker;
    } catch (error) {
      console.error("[scan] failed to start worker", error);
      this.workerBroken = true;
      return undefined;
    }
  }

  private scanInWorker(worker: Worker, paths: ScanPaths): Promise<UsageSnapshot> {
    return new Promise<UsageSnapshot>((resolve, reject) => {
      const id = this.nextWorkerScanId++;
      this.pendingWorkerScans.set(id, { resolve, reject });
      worker.postMessage({ type: "scan", id, projectsRoot: paths.projectsRoot, configFile: paths.configFile });
    });
  }

  private handleWorkerMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const record = message as { type?: unknown; id?: unknown; snapshot?: unknown; message?: unknown };
    if (typeof record.id !== "number") return;
    const pending = this.pendingWorkerScans.get(record.id);
    if (!pending) return;
    this.pendingWorkerScans.delete(record.id);
    if (record.type === "result" && record.snapshot) {
      pending.resolve(record.snapshot as UsageSnapshot);
    } else {
      pending.reject(new Error(typeof record.message === "string" ? record.message : "scanner worker failed"));
    }
  }

  private terminateWorker(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    this.rejectPendingWorkerScans(error);
    if (worker) {
      worker.removeAllListeners();
      worker.on("error", () => undefined);
      void worker.terminate().catch(() => undefined);
    }
  }

  private rejectPendingWorkerScans(error: Error): void {
    for (const pending of this.pendingWorkerScans.values()) pending.reject(error);
    this.pendingWorkerScans.clear();
  }
}
