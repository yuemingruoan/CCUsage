import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPassword } from "../src/auth.ts";
import { SyncStore } from "../src/store.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = join(repoRoot, "services/server/src/index.ts");

interface RunResult { code: number | null; stdout: string; stderr: string; }

function runCli(args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      cwd: repoRoot,
      env: { ...process.env, CCUSAGE_DB: undefined as unknown as string },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "ccusage-cli-")), "server.sqlite");
}

test("cli --help prints the commands", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ccusage-server init/);
  assert.match(result.stdout, /--reset/);
  assert.match(result.stdout, /CCUSAGE_DB/);
});

test("cli init creates an account non-interactively", async () => {
  const db = tempDb();
  const result = await runCli(["init", "--db", db, "--username", "ops", "--password", "secret123"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /账号创建成功/);
  assert.match(result.stdout, /用户名: ops/);
  const store = new SyncStore(db);
  try {
    const account = store.accountByUsername("ops");
    assert.ok(account, "account exists");
    assert.equal(verifyPassword("secret123", account.passwordHash, account.salt), true);
    assert.equal(verifyPassword("wrong", account.passwordHash, account.salt), false);
  } finally {
    store.close();
  }
  rmSync(join(db, ".."), { recursive: true, force: true });
});

test("cli init rejects duplicates and --reset changes the password", async () => {
  const db = tempDb();
  const first = await runCli(["init", "--db", db, "--username", "admin", "--password", "oldpass1"]);
  assert.equal(first.code, 0, first.stderr);
  const duplicate = await runCli(["init", "--db", db, "--username", "admin", "--password", "newpass1"]);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /已存在/);
  const reset = await runCli(["init", "--db", db, "--username", "admin", "--password", "newpass1", "--reset"]);
  assert.equal(reset.code, 0, reset.stderr);
  assert.match(reset.stdout, /已重置账号密码/);
  const store = new SyncStore(db);
  try {
    const account = store.accountByUsername("admin");
    assert.ok(account);
    assert.equal(verifyPassword("newpass1", account.passwordHash, account.salt), true);
    assert.equal(verifyPassword("oldpass1", account.passwordHash, account.salt), false);
  } finally {
    store.close();
  }
  rmSync(join(db, ".."), { recursive: true, force: true });
});

test("cli init guides an interactive session on stdin", async () => {
  const db = tempDb();
  const result = await runCli(["init", "--db", db], "demo-user\nsecret123\nsecret123\n");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /账号创建成功/);
  const store = new SyncStore(db);
  try {
    const account = store.accountByUsername("demo-user");
    assert.ok(account);
    assert.equal(verifyPassword("secret123", account.passwordHash, account.salt), true);
  } finally {
    store.close();
  }
  rmSync(join(db, ".."), { recursive: true, force: true });
});

test("cli init rejects passwords shorter than 4 characters", async () => {
  const db = tempDb();
  const result = await runCli(["init", "--db", db, "--username", "short", "--password", "abc"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /至少 4 位/);
  rmSync(join(db, ".."), { recursive: true, force: true });
});

test("cli accounts lists the created usernames", async () => {
  const db = tempDb();
  await runCli(["init", "--db", db, "--username", "ops", "--password", "secret123"]);
  await runCli(["init", "--db", db, "--username", "second", "--password", "secret456"]);
  const result = await runCli(["accounts", "--db", db]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ops/);
  assert.match(result.stdout, /second/);
  rmSync(join(db, ".."), { recursive: true, force: true });
});

test("cli serve starts the HTTP API and shuts down on SIGTERM", async () => {
  const db = tempDb();
  await runCli(["init", "--db", db, "--username", "ops", "--password", "secret123"]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, "serve", "--db", db, "--port", "0"], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("serve did not start: " + stderr)), 20_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", async (chunk: string) => {
      stdout += chunk;
      const match = /actual port: (\d+)/.exec(stdout) ?? /:(\d+)\/api\/v1/.exec(stdout);
      if (match) {
        try {
          const response = await fetch("http://127.0.0.1:" + match[1] + "/health");
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), { ok: true });
          finish();
        } catch (error) {
          finish(error as Error);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("exit", (code) => { if (code !== 0) finish(new Error("server exited " + code + ": " + stderr)); });
  });
  rmSync(join(db, ".."), { recursive: true, force: true });
});