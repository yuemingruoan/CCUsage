#!/usr/bin/env node
// Seeds fixtures + a local sync server, launches the Electron app in screenshot mode,
// and leaves screenshots/main.png, settings.png, tray.png behind.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { seedDemoDir } from "./demo-fixtures.ts";
import { createServer } from "../services/server/src/app.ts";
import { SyncClient } from "@ccusage/core";
import type { AppSettings } from "@ccusage/core";
import { DEMO_ACCOUNT, demoObservations, makeEntries, seedAccount, serverDbPath } from "./seed-server-lib.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const demoDir = join(root, "demo-data");
const shotsDir = join(root, "screenshots");
mkdirSync(shotsDir, { recursive: true });

seedDemoDir(demoDir);
const now = Date.now();
const dbPath = serverDbPath(demoDir);
const { app, close } = createServer({ dbPath });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", () => resolve()));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 8787;
const url = "http://127.0.0.1:" + port;
console.log("sync server on", url);

const laptop = { id: "demo-device-laptop", name: "Demo MacBook", platform: "macOS", appVersion: "2.0.0" };
const studio = { id: "demo-device-studio", name: "Demo Studio", platform: "macOS", appVersion: "2.0.0" };
const clientA = new SyncClient({ url });
const clientB = new SyncClient({ url });
const a = await seedAccount(clientA, laptop, makeEntries(laptop.id, now - 3 * 3_600_000, 160, 11), demoObservations(now, laptop.id, 0), 0);
await seedAccount(clientB, studio, makeEntries(studio.id, now - 2 * 3_600_000, 90, 22), demoObservations(now, studio.id, 60_000), 0);

const settings: AppSettings = {
  projectsPath: join(demoDir, "projects"),
  refreshIntervalSeconds: 60,
  windowMode: "firstRequest",
  theme: "system",
  server: { enabled: true, url, username: DEMO_ACCOUNT.username, token: a.login.token, deviceId: laptop.id, deviceName: laptop.name },
};
writeFileSync(join(demoDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");

const electron = process.env.ELECTRON_BIN || join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const main = join(root, "apps/desktop/dist/main.cjs");
if (!existsSync(main)) {
  console.error("missing", main, "- run npm run build:desktop first");
  close(); server.close();
  process.exit(1);
}
console.log("launching electron for screenshots...");
const child = spawn(electron, [main, "--no-sandbox"], {
  cwd: root,
  env: (() => { const env: NodeJS.ProcessEnv = { ...process.env, CCUSAGE_DEMO_DIR: demoDir, CCUSAGE_SCREENSHOT_DIR: shotsDir, CCUSAGE_SCREENSHOT_WAIT_MS: "3000" }; delete env.ELECTRON_RUN_AS_NODE; return env; })(),
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", chunk => { logs += String(chunk); });
child.stderr.on("data", chunk => { logs += String(chunk); });
const code = await new Promise<number>(resolve => {
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(124); }, 120_000);
  child.once("exit", c => { clearTimeout(timer); resolve(c ?? 0); });
});
console.log("electron exited", code);
const wanted = ["main.png", "settings.png", "tray.png"];
let ok = true;
for (const name of wanted) {
  const file = join(shotsDir, name);
  if (existsSync(file) && statSync(file).size > 5_000) {
    console.log("ok", file, statSync(file).size, "bytes");
  } else {
    ok = false;
    console.error("MISSING/empty", file);
  }
}
if (!ok) console.error("electron log tail:\n" + logs.split("\n").slice(-40).join("\n"));
close();
server.close();
process.exit(ok ? 0 : 1);