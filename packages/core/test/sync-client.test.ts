// SyncClient contract tests against a tiny node:http server on port 0 (no external deps).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SyncClient } from "../src/index.js";
import type { DeviceInfo, SyncIngestRequest } from "../src/index.js";

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | undefined;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

async function startServer(): Promise<{ url: string; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = [];
  const server = http.createServer(async (request, response) => {
    const url = request.url ?? "/";
    const body = await readBody(request);
    captured.push({ method: request.method ?? "", url, headers: request.headers, body });
    const route = url.split("?")[0] ?? "";

    if (route === "/api/v1/health") return json(response, 200, { ok: true });
    if (route === "/api/v1/accounts") {
      const username = body?.["username"];
      if (username === "taken") return json(response, 409, { error: "账号已存在" });
      if (username === "direct") {
        return json(response, 201, { token: "tok-direct", account: { id: "acc-1", username }, deviceId: "dev-1" });
      }
      return json(response, 201, { account: { id: "acc-1", username } });
    }
    if (route === "/api/v1/login") {
      if (body?.["password"] === "bad") return json(response, 401, { error: "用户名或密码错误" });
      return json(response, 200, {
        token: "tok-1",
        account: { id: "acc-1", username: body?.["username"] },
        deviceId: "dev-1"
      });
    }
    const authorized = request.headers["authorization"] === "Bearer tok-1" || request.headers["authorization"] === "Bearer tok-direct";
    if (route.startsWith("/api/v1/") && route !== "/api/v1/health" && !authorized) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (route === "/api/v1/ingest") {
      const ingest = body as unknown as SyncIngestRequest;
      return json(response, 200, {
        serverTime: 1,
        accepted: ingest.entries.length,
        deduped: 0,
        cursor: 7
      });
    }
    if (route === "/api/v1/sync") {
      return json(response, 200, {
        serverTime: 1,
        cursor: 3,
        entries: [],
        observations: [],
        devices: [],
        quota: { windows: {}, status: {}, statusLineObservationCount: 0, limitMessageCount: 0 }
      });
    }
    if (route === "/api/v1/state") {
      return json(response, 200, {
        account: { id: "acc-1", username: "alice" },
        devices: [],
        quota: { windows: {}, status: {}, statusLineObservationCount: 0, limitMessageCount: 0 }
      });
    }
    if (route === "/api/v1/logout") {
      response.writeHead(204);
      return response.end();
    }
    return json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const device: DeviceInfo = {
  id: "dev-1",
  name: "Mac",
  platform: "darwin",
  appVersion: "2.0.0",
  lastSeenAt: 1
};

test("login stores the token and authenticates ingest/pull/state", async (t) => {
  const server = await startServer();
  t.after(server.close);
  const client = new SyncClient({ url: server.url });

  const login = await client.login("alice", "pw", device);
  assert.equal(login.token, "tok-1");
  assert.equal(login.account.username, "alice");
  assert.equal(login.deviceId, "dev-1");
  assert.equal(client.getToken(), "tok-1");

  const ingest = await client.ingest({ device, entries: [], observations: [] });
  assert.equal(ingest.cursor, 7);
  assert.equal(ingest.accepted, 0);
  assert.equal(server.captured.find((call) => call.url === "/api/v1/ingest")?.headers["authorization"], "Bearer tok-1");

  const state = await client.state();
  assert.equal(state.account.username, "alice");
  assert.deepEqual(state.devices, []);

  await client.logout("dev-1");
  assert.equal(client.getToken(), undefined);
});

test("signup creates the account then logs in for a token", async (t) => {
  const server = await startServer();
  t.after(server.close);
  const client = new SyncClient({ url: server.url });
  const login = await client.signup("bob", "pw", device);
  assert.equal(login.token, "tok-1");
  assert.equal(login.account.username, "bob");
  assert.deepEqual(
    server.captured.map((call) => call.url),
    ["/api/v1/accounts", "/api/v1/login"]
  );
  assert.equal(server.captured[0]!.body?.["username"], "bob");
  assert.equal((server.captured[1]!.body?.["device"] as DeviceInfo).name, "Mac");
});

test("signup accepts servers that return a full LoginResponse", async (t) => {
  const server = await startServer();
  t.after(server.close);
  const client = new SyncClient({ url: server.url });
  const login = await client.signup("direct", "pw", device);
  assert.equal(login.token, "tok-direct");
  assert.equal(login.deviceId, "dev-1");
  assert.deepEqual(
    server.captured.map((call) => call.url),
    ["/api/v1/accounts"]
  );
});

test("pull passes since and mode as query parameters", async (t) => {
  const server = await startServer();
  t.after(server.close);
  const client = new SyncClient({ url: server.url, token: "tok-1" });
  await client.pull(12, "firstRequest");
  await client.pull();
  assert.equal(server.captured[0]!.url, "/api/v1/sync?since=12&mode=firstRequest");
  assert.equal(server.captured[1]!.url, "/api/v1/sync");
});

test("JSON errors become Error(message); missing auth throws before the request", async (t) => {
  const server = await startServer();
  t.after(server.close);
  const client = new SyncClient({ url: server.url });

  await assert.rejects(() => client.login("alice", "bad", device), /用户名或密码错误/);
  await assert.rejects(() => client.signup("taken", "pw", device), /账号已存在/);
  await assert.rejects(() => client.ingest({ device, entries: [], observations: [] }), /缺少访问令牌/);
  assert.equal(server.captured.length, 2); // neither unauthenticated request reached the ingest route

  const authed = new SyncClient({ url: server.url, token: "wrong" });
  await assert.rejects(() => authed.state(), /unauthorized/);
});

test("health probes without a token and tolerates failures", async (t) => {
  const server = await startServer();
  t.after(server.close);
  const client = new SyncClient({ url: server.url });
  assert.equal(await client.health(), true);
  const offline = new SyncClient({ url: "http://127.0.0.1:9" });
  assert.equal(await offline.health(), false);
});
