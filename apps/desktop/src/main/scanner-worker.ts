// Dedicated worker thread for transcript scanning.
//
// UsageScanner.scan() is the expensive part of the app (~seconds for large ~/.claude trees), so the
// main process runs it here to keep IPC and the UI responsive. The worker keeps its own scanner
// instance, so the per-file (path,size,mtime) cache survives between incremental scans.
import { parentPort } from "node:worker_threads";
import { UsageScanner } from "@ccusage/core";

interface ScanRequest {
  type: "scan";
  id: number;
  projectsRoot: string;
  configFile?: string;
}

const port = parentPort;
if (!port) {
  throw new Error("scanner-worker must run inside a worker thread");
}

const scanner = new UsageScanner();

port.on("message", (message: ScanRequest) => {
  if (!message || message.type !== "scan") return;
  void (async () => {
    try {
      const snapshot = await scanner.scan(message.projectsRoot, message.configFile);
      port.postMessage({ type: "result", id: message.id, snapshot });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      port.postMessage({ type: "error", id: message.id, message: text });
    }
  })();
});

port.postMessage({ type: "ready" });
