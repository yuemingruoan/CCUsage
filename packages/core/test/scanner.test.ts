// Port of the ingestion-cache behaviour of legacy/swift/Sources/CCUsageCore/UsageScanner.swift.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageScanner, recordedCosts } from "../src/index.js";

const fixtures = fileURLToPath(new URL("./fixtures/projects", import.meta.url));

function tempProjects(t: test.TestContext): { root: string; projects: string; configFile: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ccusage-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, "projects");
  cpSync(fixtures, projects, { recursive: true });
  const configFile = path.join(root, ".claude.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      projects: {
        "/work/demo": { lastSessionId: "s1", lastCost: 12.5 },
        "/work/zero": { lastSessionId: "s3", lastCost: 0 },
        "/work/other": { lastSessionId: "s2" }
      }
    })
  );
  return { root, projects, configFile };
}

test("first scan parses everything, later scans reuse the cache", async (t) => {
  const { projects, configFile } = tempProjects(t);
  const scanner = new UsageScanner();

  const first = await scanner.scan(projects, configFile);
  assert.equal(first.fileCount, 3);
  assert.equal(first.sessions.length, 2);
  assert.deepEqual(
    first.sessions.map((session) => session.id).sort(),
    ["s1", "s2"]
  );
  assert.equal(first.sessions.find((session) => session.id === "s1")?.recordedCost, 12.5);
  assert.deepEqual(scanner.lastScanStats.parsedFiles, 3);
  assert.deepEqual(scanner.lastScanStats.cachedFiles, 0);

  const second = await scanner.scan(projects, configFile);
  assert.equal(second.fileCount, 3);
  assert.equal(scanner.lastScanStats.parsedFiles, 0);
  assert.equal(scanner.lastScanStats.cachedFiles, 3);

  // Only the touched file is reparsed.
  appendFileSync(
    path.join(projects, "-work-demo", "s1.jsonl"),
    JSON.stringify({
      type: "assistant",
      sessionId: "s1",
      requestId: "req_new",
      timestamp: "2026-09-26T06:00:00Z",
      message: {
        id: "m-new",
        model: "claude-haiku-4-5",
        usage: { input_tokens: 1, output_tokens: 100 }
      }
    }) + "\n"
  );
  const third = await scanner.scan(projects, configFile);
  assert.equal(third.fileCount, 3);
  assert.equal(scanner.lastScanStats.parsedFiles, 1);
  assert.equal(scanner.lastScanStats.cachedFiles, 2);
  const s1 = third.sessions.find((session) => session.id === "s1");
  assert.equal(s1?.requestCount, 4);

  scanner.clearCache();
  await scanner.scan(projects, configFile);
  assert.equal(scanner.lastScanStats.parsedFiles, 3);
});

test("scan without a config file has no recorded costs", async (t) => {
  const { projects } = tempProjects(t);
  const scanner = new UsageScanner();
  const snapshot = await scanner.scan(projects);
  assert.equal(snapshot.sessions.find((session) => session.id === "s1")?.recordedCost, undefined);
});

test("recordedCosts reads lastSessionId/lastCost and ignores zero or broken files", (t) => {
  const { root, configFile } = tempProjects(t);
  assert.deepEqual(recordedCosts(configFile), { s1: 12.5 });
  assert.deepEqual(recordedCosts(path.join(root, "missing.json")), {});
  const broken = path.join(root, "broken.json");
  writeFileSync(broken, "{nope");
  assert.deepEqual(recordedCosts(broken), {});
});

test("default directories honour CLAUDE_CONFIG_DIR", (t) => {
  const previous = process.env["CLAUDE_CONFIG_DIR"];
  t.after(() => {
    if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = previous;
  });
  delete process.env["CLAUDE_CONFIG_DIR"];
  assert.equal(UsageScanner.defaultClaudeDirectory(), path.join(homedir(), ".claude"));
  assert.equal(UsageScanner.defaultProjectsDirectory(), path.join(homedir(), ".claude", "projects"));

  process.env["CLAUDE_CONFIG_DIR"] = "~/cc-custom";
  assert.equal(UsageScanner.defaultClaudeDirectory(), path.join(homedir(), "cc-custom"));
  process.env["CLAUDE_CONFIG_DIR"] = "/tmp/cc-custom";
  assert.equal(UsageScanner.defaultProjectsDirectory(), "/tmp/cc-custom/projects");
});

test("a missing projects root rejects like the Swift fileReadNoSuchFile error", async () => {
  const scanner = new UsageScanner();
  await assert.rejects(() => scanner.scan("/definitely/not/a/real/projects/root"));
});

test("changing the projects root clears the incremental cache", async (t) => {
  const { root, projects } = tempProjects(t);
  const secondRoot = path.join(root, "projects2");
  cpSync(projects, secondRoot, { recursive: true });
  const scanner = new UsageScanner();
  await scanner.scan(projects);
  assert.equal(scanner.lastScanStats.parsedFiles, 3);
  await scanner.scan(secondRoot);
  assert.equal(scanner.lastScanStats.parsedFiles, 3);
});
