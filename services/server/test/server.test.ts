// Integration tests for the CCUsage sync server: a real HTTP server on port 0
// and a temporary SQLite file per test, exercised through global fetch.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AccountInfo,
  DeviceInfo,
  LoginResponse,
  PlanInfo,
  QuotaObservation,
  QuotaSnapshot,
  SyncIngestResponse,
  SyncPullResponse,
  UsageEntry,
} from "@ccusage/core";
import { SyncClient } from "@ccusage/core";
import { createServer } from "../src/app.ts";

// MARK: - Harness

interface TestServer {
  /** http://127.0.0.1:<port>/api/v1 */
  base: string;
  /** http://127.0.0.1:<port> (the same routes are mounted at the root) */
  root: string;
  dbPath: string;
}

async function startServer(): Promise<{ server: TestServer; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "ccusage-server-test-"));
  const dbPath = join(dir, "test.sqlite");
  const { app, close } = createServer({ dbPath });
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address() as AddressInfo;
  const port = address.port;
  const host: Server = http;
  return {
    server: { base: "http://127.0.0.1:" + port + "/api/v1", root: "http://127.0.0.1:" + port, dbPath },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        host.close((error) => (error ? reject(error) : resolve()));
      });
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withServer(fn: (server: TestServer) => Promise<void>): Promise<void> {
  const context = await startServer();
  try {
    await fn(context.server);
  } finally {
    await context.close();
  }
}

interface ApiResponse {
  status: number;
  body: unknown;
  text: string;
}

async function call(
  server: TestServer,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { token?: string; body?: unknown; rawBody?: string; atRoot?: boolean } = {}
): Promise<ApiResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token !== undefined) headers.authorization = "Bearer " + options.token;
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers["content-type"] = "application/json";
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch((options.atRoot ? server.root : server.base) + path, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}

function errorOf(response: ApiResponse): string {
  assert.equal(typeof response.body, "object", "error response should be a JSON object: " + response.text);
  const error = (response.body as { error?: unknown }).error;
  assert.equal(typeof error, "string", "error response should have { error }: " + response.text);
  return error as string;
}

function makeDevice(name: string, id: string = randomUUID()): DeviceInfo {
  return { id, name, platform: "darwin", appVersion: "2.0.0", lastSeenAt: Date.now() };
}

interface TestAccount {
  username: string;
  password: string;
  token: string;
  account: AccountInfo;
  deviceId: string;
  device: DeviceInfo;
}

async function createAccount(server: TestServer, label: string, deviceName = label + " Mac"): Promise<TestAccount> {
  const username = label + "-" + randomUUID().slice(0, 8);
  const password = "pw-" + randomUUID();
  const signup = await call(server, "POST", "/accounts", { body: { username, password } });
  assert.equal(signup.status, 201, "signup failed: " + signup.text);
  const device = makeDevice(deviceName);
  const login = await call(server, "POST", "/login", { body: { username, password, device } });
  assert.equal(login.status, 200, "login failed: " + login.text);
  const body = login.body as LoginResponse;
  return { username, password, token: body.token, account: body.account, deviceId: body.deviceId, device };
}

function usageEntry(id: string, timestamp: number, costTotal: number): UsageEntry {
  return {
    id,
    sessionId: "session-" + id,
    timestamp,
    model: "claude-sonnet-4-5",
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearches: 0 },
    isFast: false,
    cost: { input: costTotal, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 },
    isPriced: true,
  };
}

function fiveHourObservation(observedAt: number, resetsAt: number, usedPercentage: number): QuotaObservation {
  return { kind: "fiveHour", observedAt, resetsAt, usedPercentage, source: "statusLine", sessionId: "session-obs" };
}

function currentFiveHourWindow(quota: QuotaSnapshot, now: number) {
  const windows = quota.windows.fiveHour ?? [];
  return windows.find((window) => window.start <= now && now < window.end);
}

// MARK: - Tests

describe("GET /health", () => {
  test("answers ok at /api/v1/health and at the root alias", () =>
    withServer(async (server) => {
      const api = await call(server, "GET", "/health");
      assert.equal(api.status, 200);
      assert.deepEqual(api.body, { ok: true });
      const root = await call(server, "GET", "/health", { atRoot: true });
      assert.equal(root.status, 200);
      assert.deepEqual(root.body, { ok: true });
    }));
});

describe("POST /accounts", () => {
  test("creates an account, rejects duplicates with 409 and invalid bodies with 400", () =>
    withServer(async (server) => {
      const username = "alice-" + randomUUID().slice(0, 8);
      const created = await call(server, "POST", "/accounts", { body: { username, password: "secret-password" } });
      assert.equal(created.status, 201);
      const account = (created.body as { account: AccountInfo }).account;
      assert.equal(account.username, username);
      assert.ok(account.id.length > 0);

      const duplicate = await call(server, "POST", "/accounts", { body: { username, password: "another-password" } });
      assert.equal(duplicate.status, 409);
      assert.ok(errorOf(duplicate).length > 0);

      const missingPassword = await call(server, "POST", "/accounts", { body: { username: "nobody" } });
      assert.equal(missingPassword.status, 400);
      errorOf(missingPassword);

      const arrayBody = await call(server, "POST", "/accounts", { body: [username, "secret"] });
      assert.equal(arrayBody.status, 400);
      errorOf(arrayBody);
    }));
});

describe("POST /login", () => {
  test("returns a token + deviceId and rejects bad credentials with 401", () =>
    withServer(async (server) => {
      const username = "bob-" + randomUUID().slice(0, 8);
      const password = "pw-" + randomUUID();
      await call(server, "POST", "/accounts", { body: { username, password } });
      const device = makeDevice("Bob Mac");
      const ok = await call(server, "POST", "/login", { body: { username, password, device } });
      assert.equal(ok.status, 200);
      const login = ok.body as LoginResponse;
      assert.match(login.token, /^[0-9a-f]{64}$/);
      assert.equal(login.deviceId, device.id);
      assert.equal(login.account.username, username);

      const wrongPassword = await call(server, "POST", "/login", { body: { username, password: "wrong", device } });
      assert.equal(wrongPassword.status, 401);
      assert.ok(errorOf(wrongPassword).length > 0);

      const unknownUser = await call(server, "POST", "/login", { body: { username: "ghost", password, device } });
      assert.equal(unknownUser.status, 401);

      const malformed = await call(server, "POST", "/login", { body: { username } });
      assert.equal(malformed.status, 400);

      const badDevice = await call(server, "POST", "/login", { body: { username, password, device: "nope" } });
      assert.equal(badDevice.status, 400);
    }));
});

describe("POST /ingest", () => {
  test("dedupes entry ids across devices and counts distinct entries", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "alice");
      const aliceSecond = await createAccount(server, "alice2");
      // A second device for the same account: login again with a new device id.
      const secondDevice = makeDevice("Alice Laptop");
      const secondLogin = await call(server, "POST", "/login", { body: { username: alice.username, password: alice.password, device: secondDevice } });
      assert.equal(secondLogin.status, 200);
      const second = secondLogin.body as LoginResponse;

      const now = Date.now();
      const shared = usageEntry("shared-entry", now - 5 * 60_000, 3);
      const first = await call(server, "POST", "/ingest", {
        token: alice.token,
        body: { device: alice.device, entries: [shared], observations: [], plan: { tier: "default_claude_max_5x", organizationType: "claude_max", fetchedAt: now } },
      });
      assert.equal(first.status, 200, "ingest failed: " + first.text);
      const firstBody = first.body as SyncIngestResponse;
      assert.equal(firstBody.accepted, 1);
      assert.equal(firstBody.deduped, 0);
      assert.ok(firstBody.cursor > 0);
      assert.ok(Math.abs(firstBody.serverTime - now) < 60_000);

      const conflicting = usageEntry("shared-entry", now - 4 * 60_000, 999);
      const other = usageEntry("distinct-entry", now - 4.5 * 60_000, 5);
      const secondIngest = await call(server, "POST", "/ingest", {
        token: second.token,
        body: { device: secondDevice, entries: [conflicting, other], observations: [] },
      });
      assert.equal(secondIngest.status, 200);
      assert.deepEqual((secondIngest.body as SyncIngestResponse).accepted, 1);
      assert.deepEqual((secondIngest.body as SyncIngestResponse).deduped, 1);

      // Account totals come from both devices, but the shared request is only counted once.
      const state = await call(server, "GET", "/state", { token: alice.token });
      assert.equal(state.status, 200);
      const totals = (state.body as { totals: { weekCost: number; todayRequests: number } }).totals;
      assert.equal(totals.weekCost, 8);
      assert.equal(totals.todayRequests, 2);

      // An unrelated account has no entries at all.
      const stranger = await call(server, "GET", "/state", { token: aliceSecond.token });
      assert.equal((stranger.body as { totals: { weekCost: number } }).totals.weekCost, 0);
    }));

  test("validates entry and observation shapes", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "validator");
      const emptyEntry = await call(server, "POST", "/ingest", { token: alice.token, body: { entries: [{}] } });
      assert.equal(emptyEntry.status, 400);
      assert.match(errorOf(emptyEntry), /entries\[0\]/);

      const notArray = await call(server, "POST", "/ingest", { token: alice.token, body: { entries: "nope" } });
      assert.equal(notArray.status, 400);

      const badObservation = await call(server, "POST", "/ingest", {
        token: alice.token,
        body: { observations: [{ kind: "hourly", observedAt: 1, resetsAt: 2, usedPercentage: 1 }] },
      });
      assert.equal(badObservation.status, 400);

      const badPlan = await call(server, "POST", "/ingest", { token: alice.token, body: { plan: { tier: "" } } });
      assert.equal(badPlan.status, 400);

      const noToken = await call(server, "POST", "/ingest", { body: { entries: [] } });
      assert.equal(noToken.status, 401);
    }));
});

describe("GET /sync", () => {
  test("returns the other device entries with deviceId plus the device list", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "sync-alice");
      const tablet = makeDevice("Alice Tablet");
      const tabletLogin = await call(server, "POST", "/login", { body: { username: alice.username, password: alice.password, device: tablet } });
      assert.equal(tabletLogin.status, 200);
      const tabletToken = (tabletLogin.body as LoginResponse).token;

      const now = Date.now();
      const entry = usageEntry("tablet-entry", now - 3 * 60_000, 2);
      const plan: PlanInfo = { tier: "default_claude_max_20x", organizationType: "claude_max", fetchedAt: now };
      const ingest = await call(server, "POST", "/ingest", { token: tabletToken, body: { device: tablet, entries: [entry], observations: [], plan } });
      assert.equal(ingest.status, 200);

      const firstPull = await call(server, "GET", "/sync?since=0&mode=firstRequest", { token: alice.token });
      assert.equal(firstPull.status, 200);
      const pull = firstPull.body as SyncPullResponse;
      assert.equal(pull.entries.length, 1);
      assert.equal(pull.entries[0]?.id, "tablet-entry");
      assert.equal(pull.entries[0]?.deviceId, tablet.id);
      assert.ok(Math.abs(pull.serverTime - now) < 60_000);
      assert.equal(pull.devices.length, 2);
      const self = pull.devices.find((device) => device.id === alice.deviceId);
      const remote = pull.devices.find((device) => device.id === tablet.id);
      assert.equal(self?.isSelf, true);
      assert.equal(remote?.isSelf, undefined);
      assert.equal(pull.plan?.tier, "default_claude_max_20x");
      assert.ok(pull.quota !== undefined);
      assert.ok(pull.cursor > 0);

      // The cursor is a high-water mark for peer entries.
      const secondPull = await call(server, "GET", "/sync?since=" + pull.cursor, { token: alice.token });
      assert.equal(secondPull.status, 200);
      assert.deepEqual((secondPull.body as SyncPullResponse).entries, []);
      assert.equal((secondPull.body as SyncPullResponse).cursor, pull.cursor);

      // A new peer entry is returned by the next incremental pull.
      const laterEntry = usageEntry("tablet-entry-2", now - 2 * 60_000, 1);
      await call(server, "POST", "/ingest", { token: tabletToken, body: { device: tablet, entries: [laterEntry] } });
      const thirdPull = await call(server, "GET", "/sync?since=" + pull.cursor, { token: alice.token });
      const thirdBody = thirdPull.body as SyncPullResponse;
      assert.deepEqual(thirdBody.entries.map((item) => item.id), ["tablet-entry-2"]);
      assert.ok(thirdBody.cursor > pull.cursor);
    }));

  test("validates since and mode", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "sync-validation");
      assert.equal((await call(server, "GET", "/sync?since=-1", { token: alice.token })).status, 400);
      assert.equal((await call(server, "GET", "/sync?since=abc", { token: alice.token })).status, 400);
      assert.equal((await call(server, "GET", "/sync?mode=bogus", { token: alice.token })).status, 400);
      assert.equal((await call(server, "GET", "/sync", { token: alice.token })).status, 200);
      assert.equal((await call(server, "GET", "/sync?mode=fixedRolling", { token: alice.token })).status, 200);
    }));
});

describe("quota over all devices", () => {
  test("the current five-hour window contains both devices spend", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "quota-a", "Alice Mac");
      const laptopDevice = makeDevice("Alice Laptop");
      const laptopLogin = await call(server, "POST", "/login", { body: { username: alice.username, password: alice.password, device: laptopDevice } });
      const laptopToken = (laptopLogin.body as LoginResponse).token;

      const now = Date.now();
      const observedAt = now - 5 * 60_000;
      const resetsAt = now + 4 * 3_600_000;
      await call(server, "POST", "/ingest", {
        token: alice.token,
        body: { device: alice.device, entries: [usageEntry("cost-a", now - 10 * 60_000, 4)], observations: [fiveHourObservation(observedAt, resetsAt, 20)] },
      });
      await call(server, "POST", "/ingest", {
        token: laptopToken,
        body: { device: laptopDevice, entries: [usageEntry("cost-b", now - 9 * 60_000, 6)], observations: [fiveHourObservation(observedAt + 1000, resetsAt, 25)] },
      });

      // The server quota returned by /sync includes both devices: 4 + 6 USD.
      const sync = await call(server, "GET", "/sync?mode=firstRequest", { token: alice.token });
      assert.equal(sync.status, 200);
      const quota = (sync.body as SyncPullResponse).quota as QuotaSnapshot;
      assert.ok(quota, "expected a quota snapshot in /sync");
      const window = currentFiveHourWindow(quota, now);
      assert.ok(window, "expected a current five-hour window, got " + JSON.stringify(quota.windows.fiveHour));
      assert.ok(window.cost >= 10, "expected window cost >= 10 (both devices), got " + window.cost);
      assert.ok(window.requestCount >= 2);
      assert.ok(quota.status.fiveHour !== undefined);

      // /state exposes the same account-wide quota.
      const state = await call(server, "GET", "/state", { token: laptopToken });
      assert.equal(state.status, 200);
      const stateQuota = (state.body as { quota: QuotaSnapshot }).quota;
      const stateWindow = currentFiveHourWindow(stateQuota, now);
      assert.ok(stateWindow);
      assert.ok(stateWindow.cost >= 10);
    }));
});

describe("auth", () => {
  test("missing or invalid bearer tokens are rejected with 401", () =>
    withServer(async (server) => {
      assert.equal((await call(server, "GET", "/state")).status, 401);
      assert.equal((await call(server, "GET", "/state", { token: "deadbeef" })).status, 401);
      const response = await call(server, "GET", "/state");
      errorOf(response);
    }));

  test("logout revokes the token", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "logout");
      assert.equal((await call(server, "GET", "/state", { token: alice.token })).status, 200);
      const logout = await call(server, "POST", "/logout", { token: alice.token, body: { deviceId: alice.deviceId } });
      assert.equal(logout.status, 204);
      assert.equal(logout.text, "");
      assert.equal((await call(server, "GET", "/state", { token: alice.token })).status, 401);
      assert.equal((await call(server, "GET", "/sync", { token: alice.token })).status, 401);
    }));
});

describe("DELETE /devices/:id", () => {
  test("removes the device, revokes its token and keeps the pull devices list in sync", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "devices");
      const tabletDevice = makeDevice("Alice Tablet");
      const tabletLogin = await call(server, "POST", "/login", { body: { username: alice.username, password: alice.password, device: tabletDevice } });
      const tabletToken = (tabletLogin.body as LoginResponse).token;

      const deleted = await call(server, "DELETE", "/devices/" + tabletDevice.id, { token: alice.token });
      assert.equal(deleted.status, 204);
      assert.equal((await call(server, "GET", "/state", { token: tabletToken })).status, 401);
      const state = await call(server, "GET", "/state", { token: alice.token });
      const devices = (state.body as { devices: DeviceInfo[] }).devices;
      assert.deepEqual(devices.map((device) => device.id), [alice.deviceId]);
      assert.equal(devices[0]?.isSelf, true);
      // Deleting an unknown device is idempotent.
      assert.equal((await call(server, "DELETE", "/devices/unknown", { token: alice.token })).status, 204);
    }));
});

describe("account isolation", () => {
  test("a token only ever sees its own account data", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "isolation-a");
      const bob = await createAccount(server, "isolation-b");
      const now = Date.now();
      await call(server, "POST", "/ingest", { token: alice.token, body: { entries: [usageEntry("alice-entry", now - 60_000, 7)] } });
      const bobPull = await call(server, "GET", "/sync?since=0", { token: bob.token });
      const pull = bobPull.body as SyncPullResponse;
      assert.deepEqual(pull.entries, []);
      assert.deepEqual(pull.devices.map((device) => device.id), [bob.deviceId]);
      assert.equal((await call(server, "DELETE", "/devices/" + alice.deviceId, { token: bob.token })).status, 204);
      // Bob could not delete Alice device: her token still works and she still has the device.
      assert.equal((await call(server, "GET", "/state", { token: alice.token })).status, 200);
      const aliceState = await call(server, "GET", "/state", { token: alice.token });
      assert.equal((aliceState.body as { devices: DeviceInfo[] }).devices.length, 1);
    }));
});

describe("body limits", () => {
  test("rejects oversized JSON bodies with an error payload", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "limits");
      const huge = JSON.stringify({ entries: [], padding: "x".repeat(2_200_000) });
      const response = await call(server, "POST", "/ingest", { token: alice.token, rawBody: huge });
      assert.equal(response.status, 400, "CONTRACTS §6: over-limit bodies are rejected with 400");
      errorOf(response);
    }));

  test("rejects malformed JSON with a 400 and an error payload", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "malformed-json");
      const response = await call(server, "POST", "/ingest", { token: alice.token, rawBody: "{not json" });
      assert.equal(response.status, 400);
      errorOf(response);
    }));
});

describe("core SyncClient interop", () => {
  test("signup/login/ingest/pull/state/logout against the live server", () =>
    withServer(async (server) => {
      const first = new SyncClient({ url: server.root });
      assert.equal(await first.health(), true);

      const username = "e2e-" + randomUUID().slice(0, 8);
      const password = "pw-" + randomUUID();
      const firstDevice = makeDevice("E2E Mac");
      const login = await first.signup(username, password, firstDevice);
      assert.match(login.token, /^[0-9a-f]{64}$/);
      assert.equal(login.account.username, username);
      assert.equal(login.deviceId, firstDevice.id);

      const now = Date.now();
      const observation = fiveHourObservation(now - 2 * 60_000, now + 4 * 3_600_000, 15);
      const ingest = await first.ingest({
        device: firstDevice,
        entries: [usageEntry("e2e-a", now - 5 * 60_000, 3)],
        observations: [observation],
        plan: { tier: "default_claude_max_5x", organizationType: "claude_max", fetchedAt: now },
      });
      assert.equal(ingest.accepted, 1);
      assert.equal(ingest.deduped, 0);
      assert.ok(ingest.cursor > 0);

      // A second client (same account, second device) pushes a peer entry.
      const second = new SyncClient({ url: server.root });
      const secondDevice = makeDevice("E2E Laptop");
      await second.login(username, password, secondDevice);
      await second.ingest({ device: secondDevice, entries: [usageEntry("e2e-b", now - 4 * 60_000, 2)], observations: [] });

      const pull = await first.pull(0, "firstRequest");
      assert.deepEqual(pull.entries.map((entry) => entry.id), ["e2e-b"]);
      assert.equal(pull.entries[0]?.deviceId, secondDevice.id);
      assert.equal(pull.devices.length, 2);
      assert.equal(pull.plan?.tier, "default_claude_max_5x");
      assert.ok(pull.quota !== undefined);

      const state = await first.state();
      assert.equal(state.account.username, username);
      assert.equal(state.devices.length, 2);
      const window = currentFiveHourWindow(state.quota, now);
      assert.ok(window, "expected the server quota to contain a current five-hour window");
      assert.ok(window.cost >= 5, "expected both devices in the window cost, got " + window.cost);

      await first.logout(login.deviceId);
      await assert.rejects(first.state(), /未登录|401|unauthorized/);
    }));
});
describe("GET /sync sessions", () => {
  test("returns peer session metadata with real titles and aggregated totals", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "alice");
      const laptop = makeDevice("Alice Laptop");
      const laptopLogin = await call(server, "POST", "/login", { body: { username: alice.username, password: alice.password, device: laptop } });
      assert.equal(laptopLogin.status, 200);
      const laptopToken = (laptopLogin.body as LoginResponse).token;
      const now = Date.now();
      const entry = (id: string, sessionId: string, timestamp: number, cost: number, priced = true): UsageEntry => ({
        ...usageEntry(id, timestamp, cost),
        sessionId,
        ...(priced ? {} : { model: "deepseek-flash", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 } }),
        isPriced: priced,
      });
      const ingest = await call(server, "POST", "/ingest", {
        token: alice.token,
        body: {
          device: alice.device,
          entries: [
            entry("e1", "s-one", now - 3_000_000, 1.5),
            entry("e2", "s-one", now - 2_900_000, 0.5),
            entry("e3", "s-two", now - 1_400_000, 2),
            entry("e4", "s-three", now - 600_000, 0, false),
          ],
          observations: [],
          sessions: [
            { id: "s-one", title: "渲染管线优化", projectName: "alpha", cwd: "/work/alpha", start: now - 3_600_000, end: now - 2_800_000 },
            { id: "s-two", title: "发布构建", projectName: "beta", start: now - 1_500_000, end: now - 1_300_000 },
            { id: "s-three", title: "第三方模型实验", projectName: "gamma", start: now - 700_000, end: now - 500_000 },
          ],
        },
      });
      assert.equal(ingest.status, 200, ingest.text);

      const pull = await call(server, "GET", "/sync?since=0", { token: laptopToken });
      assert.equal(pull.status, 200, pull.text);
      const body = pull.body as SyncPullResponse;
      assert.equal(body.sessions.length, 3);
      const one = body.sessions.find((session) => session.id === "s-one");
      assert.ok(one, "s-one present");
      assert.equal(one.title, "渲染管线优化");
      assert.equal(one.projectName, "alpha");
      assert.equal(one.deviceId, alice.deviceId);
      assert.equal(one.requests, 2);
      assert.equal(one.tokens?.input, 200);
      assert.equal(one.cost?.input, 2);
      assert.deepEqual(one.models, ["claude-sonnet-4-5"]);
      const three = body.sessions.find((session) => session.id === "s-three");
      assert.ok(three);
      assert.equal(three.hasUnpricedRequests, true);

      // The reporting device never receives its own sessions back as peers.
      const own = await call(server, "GET", "/sync?since=0", { token: alice.token });
      assert.equal(own.status, 200);
      assert.deepEqual((own.body as SyncPullResponse).sessions, []);
    }));

  test("rejects malformed session metadata", () =>
    withServer(async (server) => {
      const alice = await createAccount(server, "alice");
      const response = await call(server, "POST", "/ingest", {
        token: alice.token,
        body: { device: alice.device, entries: [], observations: [], sessions: [{ title: "no id" }] },
      });
      assert.equal(response.status, 400);
      errorOf(response);
    }));
});
