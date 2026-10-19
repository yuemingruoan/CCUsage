#!/usr/bin/env node
// Starts a local sync server seeded with two demo devices (keeps running).
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedDemoDir } from "./demo-fixtures.ts";
import { createServer } from "../services/server/src/app.ts";
import { SyncClient } from "@ccusage/core";
import { DEMO_ACCOUNT, demoObservations, makeEntries, seedAccount, serverDbPath } from "./seed-server-lib.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const demoDir = process.env.CCUSAGE_DEMO_DIR ? join(process.cwd(), process.env.CCUSAGE_DEMO_DIR) : join(root, "demo-data");
seedDemoDir(demoDir);
const now = Date.now();
const { app, close } = createServer({ dbPath: serverDbPath(demoDir) });
const port = Number(process.env.PORT ?? 8787);
const server = app.listen(port, "127.0.0.1", () => console.log("sync server on http://127.0.0.1:" + port));
const url = "http://127.0.0.1:" + port;

const laptop = { id: "demo-device-laptop", name: "Demo MacBook", platform: "macOS", appVersion: "2.0.0" };
const studio = { id: "demo-device-studio", name: "Demo Studio", platform: "macOS", appVersion: "2.0.0" };
const clientA = new SyncClient({ url });
const clientB = new SyncClient({ url });
const a = await seedAccount(clientA, laptop, makeEntries(laptop.id, now - 3 * 3_600_000, 160, 11), demoObservations(now, laptop.id, 0), 0);
const b = await seedAccount(clientB, studio, makeEntries(studio.id, now - 2 * 3_600_000, 90, 22), demoObservations(now, studio.id, 60_000), 0);
console.log("seeded devices:", a.login.deviceId, b.login.deviceId, "| account:", DEMO_ACCOUNT.username, DEMO_ACCOUNT.password);
const settingsPath = join(demoDir, "settings.json");
writeFileSync(settingsPath, JSON.stringify({
  projectsPath: join(demoDir, "projects"),
  refreshIntervalSeconds: 60,
  windowMode: "firstRequest",
  theme: "system",
  server: { enabled: true, url, username: DEMO_ACCOUNT.username, token: a.login.token, deviceId: laptop.id, deviceName: laptop.name },
}, null, 2) + "\n");
console.log("wrote", settingsPath);
console.log("server running; Ctrl-C to stop");
process.on("SIGINT", () => { close(); server.close(); process.exit(0); });