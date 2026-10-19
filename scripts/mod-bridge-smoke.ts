#!/usr/bin/env node
// End-to-end smoke test for the mod <-> app bridge without Claude Code:
// hosts the same HTTP-over-Unix-socket contract the Electron app implements,
// loads the real mod register.ts with a fake engine interface, drives
// session.start / ticks / session.measure / refreshId bumps, and asserts the
// pushes + JSONL fallback behave as specified.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { register, type BridgeConfig } from "../packages/mod/plugin/hooks/register.ts";

const home = mkdtempSync("/tmp/ccusage-mod-");
const appSupport = join(home, "Library/Application Support/CCUsage");
mkdirSync(appSupport, { recursive: true });
const socketPath = join(appSupport, "bridge.sock");
const bridgePath = join(appSupport, "bridge.json");

let pushes: Array<{ token: string; reading: any }> = [];
let reply: { pollMs: number; reportNow: boolean; refreshId: number } = { pollMs: 60_000, reportNow: false, refreshId: 1 };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += String(c)));
  req.on("end", () => {
    if (req.url === "/report") {
      pushes.push({ token: String(req.headers["x-ccusage-token"] ?? ""), reading: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...reply }));
      return;
    }
    if (req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ listening: true, socketPath }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));

const config: BridgeConfig = { version: 1, socketPath, token: "test-token", pollMs: 60_000, refreshId: 1, appVersion: "2.0.0" };
writeFileSync(bridgePath, JSON.stringify(config));

const jsonl: string[] = [];
const statuses: Array<string | undefined> = [];
let handlers: Record<string, (...args: any[]) => any> = {};
let timerFn: (() => void) | undefined;
let cancelled = false;
let rateLimits = [
  { kind: "five_hour", percentUsed: 4, resetsAt: "2026-10-19T02:40:00.000Z" },
  { kind: "seven_day", percentUsed: 97, resetsAt: "2026-10-20T05:00:00.000Z" },
];

const $ = {
  env: { get: async (name: string) => (name === "HOME" ? home : undefined) },
  fs: { read: async (path: string) => readFileSync(path, "utf8") },
  clock: {
    now: async () => Date.now(),
    every: (_ms: number, fn: () => void) => { timerFn = fn; return { cancel: () => { cancelled = true; } }; },
  },
  session: {
    id: async () => "fake-session",
    usage: async () => ({ rateLimits: rateLimits.map(l => ({ ...l })), cost: { usd: 12.5 }, context: { window: 200_000 } }),
  },
  ui: { status: (text: string | undefined) => { statuses.push(text); } },
  http: {
    fetch: (url: string, init: any) => new Promise<{ ok: boolean; status: number; text: string }>((resolve, reject) => {
      const body = init?.body ?? "";
      const req = httpRequest({ socketPath: init?.socketPath, path: new URL(url).pathname, method: init?.method ?? "GET", headers: init?.headers ?? {} }, (res: any) => {
        let data = "";
        res.on("data", (c: any) => (data += String(c)));
        res.on("end", () => resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, text: data }));
      });
      req.on("error", reject);
      req.end(body);
    }),
  },
  process: { run: async (argv: string[]) => { jsonl.push(argv[argv.length - 1] ?? ""); return { exitCode: 0, stdout: "", stderr: "" }; } },
};

register(((event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; }) as any);
const next = async (e: unknown) => e;
const assert = (cond: unknown, message: string) => { if (!cond) { console.error("FAIL:", message); process.exitCode = 1; throw new Error(message); } };

// 1. session.start reports once and files the status line.
await handlers["session.start"]!($, {}, next);
assert(pushes.length === 1, "session.start pushes a reading");
assert(pushes[0]!.token === "test-token", "token header");
assert(pushes[0]!.reading.sessionId === "fake-session", "session id");
assert(pushes[0]!.reading.rateLimits.length === 2, "both windows");
assert(pushes[0]!.reading.rateLimits[0].resetsAt === Date.parse("2026-10-19T02:40:00.000Z"), "resetsAt in ms");
assert(statuses.at(-1) === "5h 4% ↻10:40 · 7d 97% ↻Tue 13:00 · $12.50", "status text: " + statuses.at(-1));
assert(timerFn !== undefined, "tick timer registered");

// 2. A tick inside pollMs and an unchanged reading pushes nothing.
await timerFn!();
assert(pushes.length === 1, "no push when unchanged within pollMs");

// 3. A changed reading pushes on the next tick.
rateLimits = [
  { kind: "five_hour", percentUsed: 9, resetsAt: "2026-10-19T02:40:00.000Z" },
  { kind: "seven_day", percentUsed: 97, resetsAt: "2026-10-20T05:00:00.000Z" },
];
await timerFn!();
assert(pushes.length === 2, "changed reading pushes");

// 4. refreshId bump (app's refresh button) triggers an immediate push on the next tick.
config.refreshId = 2;
writeFileSync(bridgePath, JSON.stringify(config));
await timerFn!();
assert(pushes.length === 3, "refreshId bump pushes");

// 5. session.measure pushes immediately with its payload.
rateLimits = [
  { kind: "five_hour", percentUsed: 11, resetsAt: "2026-10-19T02:40:00.000Z" },
  { kind: "seven_day", percentUsed: 97, resetsAt: "2026-10-20T05:00:00.000Z" },
];
await handlers["session.measure"]!($, { rateLimits, cost: { usd: 13.4 } }, next);
assert(pushes.length === 4, "measure pushes");
assert(pushes[3]!.reading.rateLimits[0].percentUsed === 11, "measure payload");

// 6. reportNow in the reply: after answering an app refresh, one extra push on the next tick.
reply = { pollMs: 5_000, reportNow: true, refreshId: 3 };
config.refreshId = 3;
writeFileSync(bridgePath, JSON.stringify(config));
const before = pushes.length;
await timerFn!();
assert(pushes.length === before + 1, "refreshId bump pushes once");
await timerFn!();
assert(pushes.length === before + 2, "reportNow causes one extra push");

// 7. Bridge removed -> JSONL fallback via process.run, and timer cancel on session.end.
rmSync(bridgePath);
rateLimits = [
  { kind: "five_hour", percentUsed: 12, resetsAt: "2026-10-19T02:40:00.000Z" },
  { kind: "seven_day", percentUsed: 97, resetsAt: "2026-10-20T05:00:00.000Z" },
];
await handlers["session.start"]!($, {}, next);
await timerFn!();
assert(jsonl.length >= 1, "JSONL fallback written");
const record = JSON.parse(jsonl[jsonl.length - 1] as string);
assert(record.five_hour.used_percentage === 12, "fallback line format: " + jsonl[jsonl.length - 1]);
await handlers["session.end"]!($, {}, next);
assert(cancelled, "timer cancelled on session.end");

server.close();
rmSync(home, { recursive: true, force: true });
if (process.exitCode) {
  console.error("mod bridge smoke FAILED");
} else {
  console.log("mod bridge smoke OK —", pushes.length, "socket pushes,", jsonl.length, "fallback lines");
}