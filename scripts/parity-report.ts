#!/usr/bin/env node
// Compares the TypeScript scanner against the Swift app's reference report.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const coreDist = join(root, "packages/core/dist/index.js");
if (!existsSync(coreDist)) {
  console.log("building core first...");
  const built = spawnSync("npm", ["run", "build:core"], { cwd: root, stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const { UsageScanner, costTotal } = await import(coreDist);
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const projects = join(claudeDir, "projects");
const configFile = join(homedir(), ".claude.json");

const started = Date.now();
const snapshot = await new UsageScanner().scan(projects, configFile);
const elapsed = (Date.now() - started) / 1000;
const total = snapshot.entries.reduce((sum, e) => sum + costTotal(e.cost), 0);
console.log(snapshot.fileCount + " files, " + snapshot.entries.length + " requests, " + snapshot.sessions.length + " sessions, scanned in " + elapsed.toFixed(3) + " seconds");
console.log("total $" + total.toFixed(2));

const refPath = join(root, "legacy/reference-report.txt");
if (existsSync(refPath)) {
  const first = readFileSync(refPath, "utf8").split("\n")[0];
  console.log("reference: " + first);
  const m = first.match(/(\d+) files, (\d+) requests, (\d+) sessions/);
  if (m) {
    const ok = Number(m[1]) === snapshot.fileCount && Number(m[2]) === snapshot.entries.length && Number(m[3]) === snapshot.sessions.length;
    const strict = process.argv.includes("--strict");
    console.log(ok ? "PARITY OK" : "PARITY MISMATCH (reference is a historical snapshot; pass --strict to fail on mismatch)");
    if (!ok && strict) process.exit(2);
  }
}