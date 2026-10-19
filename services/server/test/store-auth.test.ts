// Unit tests for the SQLite store and the auth primitives (no HTTP, no @ccusage/core runtime).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { UsageEntry } from "@ccusage/core";
import { SyncStore } from "../src/store.ts";
import { generateToken, hashPassword, hashToken, parseBearerToken, verifyPassword } from "../src/auth.ts";

const TOKENS = { input: 10, output: 20, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearches: 0 };
const COST = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, webSearch: 0 };

function entry(id: string, overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id,
    sessionId: "session-1",
    timestamp: Date.now() - 60_000,
    model: "claude-sonnet-4-5",
    tokens: TOKENS,
    isFast: false,
    cost: COST,
    isPriced: true,
    ...overrides,
  };
}

function withStore(fn: (store: SyncStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ccusage-store-test-"));
  const store = new SyncStore(join(dir, "test.sqlite"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedAccount(store: SyncStore): { accountId: string; deviceId: string; token: string } {
  const account = store.createAccount({
    id: randomUUID(),
    username: "user-" + randomUUID(),
    passwordHash: "hash",
    salt: "salt",
    createdAt: Date.now(),
  });
  assert.ok(account);
  const deviceId = randomUUID();
  store.upsertDevice(account.id, { id: deviceId, name: "Test Mac", platform: "darwin", appVersion: "2.0.0", lastSeenAt: Date.now() });
  const token = generateToken();
  store.createToken(hashToken(token), account.id, deviceId, Date.now());
  return { accountId: account.id, deviceId, token };
}

describe("auth primitives", () => {
  test("scrypt hash round-trips and rejects wrong password", () => {
    const { passwordHash, salt } = hashPassword("correct horse battery staple");
    assert.equal(verifyPassword("correct horse battery staple", passwordHash, salt), true);
    assert.equal(verifyPassword("Correct horse battery staple", passwordHash, salt), false);
    assert.equal(verifyPassword("", passwordHash, salt), false);
  });

  test("same password + different salt gives a different hash", () => {
    const first = hashPassword("same-password");
    const second = hashPassword("same-password");
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.passwordHash, second.passwordHash);
  });

  test("tokens are random, hex, and stored as sha256", () => {
    const token = generateToken();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(generateToken(), token);
    assert.match(hashToken(token), /^[0-9a-f]{64}$/);
    assert.notEqual(hashToken(token), token);
  });

  test("bearer header parsing", () => {
    assert.equal(parseBearerToken("Bearer abc123"), "abc123");
    assert.equal(parseBearerToken("bearer abc-123_4"), "abc-123_4");
    assert.equal(parseBearerToken("Basic abc123"), undefined);
    assert.equal(parseBearerToken(undefined), undefined);
    assert.equal(parseBearerToken("Bearer "), undefined);
  });
});

describe("store: accounts, devices, tokens", () => {
  test("usernames are unique", () => {
    withStore((store) => {
      const record = { id: randomUUID(), username: "alice", passwordHash: "h", salt: "s", createdAt: 1 };
      assert.ok(store.createAccount(record));
      assert.equal(store.createAccount({ ...record, id: randomUUID() }), undefined);
      assert.equal(store.accountByUsername("alice")?.username, "alice");
      assert.equal(store.accountByUsername("bob"), undefined);
    });
  });

  test("token lookup returns the account/device and revocation removes it", () => {
    withStore((store) => {
      const { accountId, deviceId, token } = seedAccount(store);
      const tokenHash = hashToken(token);
      assert.equal(store.findAuth(tokenHash)?.accountId, accountId);
      assert.equal(store.findAuth(tokenHash)?.deviceId, deviceId);
      assert.equal(store.findAuth(hashToken("nope")), undefined);
      assert.equal(store.revokeToken(tokenHash), true);
      assert.equal(store.findAuth(tokenHash), undefined);
      assert.equal(store.revokeToken(tokenHash), false);
    });
  });

  test("login upserts devices and last_seen_at only moves forward", () => {
    withStore((store) => {
      const { accountId, deviceId } = seedAccount(store);
      const later = Date.now() + 10_000;
      store.upsertDevice(accountId, { id: deviceId, name: "Renamed Mac", platform: "darwin", appVersion: "2.1.0", lastSeenAt: later });
      const devices = store.devices(accountId);
      assert.equal(devices.length, 1);
      assert.equal(devices[0]?.name, "Renamed Mac");
      assert.equal(devices[0]?.appVersion, "2.1.0");
      store.touchDevice(accountId, deviceId, later - 60_000);
      assert.equal(store.devices(accountId)[0]?.lastSeenAt, later);
    });
  });

  test("deleting a device removes it and revokes its tokens but keeps history", () => {
    withStore((store) => {
      const { accountId, deviceId, token } = seedAccount(store);
      store.insertEntries(accountId, deviceId, [entry("e1")]);
      store.deleteDevice(accountId, deviceId);
      assert.equal(store.devices(accountId).length, 0);
      assert.equal(store.findAuth(hashToken(token)), undefined);
      assert.equal(store.entryCount(accountId), 1);
      const other = seedAccount(store);
      assert.equal(store.deleteDevice(other.accountId, "not-my-device"), false);
    });
  });

  test("device ids cannot be claimed by another account", () => {
    withStore((store) => {
      const first = seedAccount(store);
      const second = seedAccount(store);
      assert.equal(store.canUseDeviceId(first.accountId, first.deviceId), true);
      assert.equal(store.canUseDeviceId(second.accountId, first.deviceId), false);
    });
  });
});

describe("store: entries", () => {
  test("entries dedupe by id per account and survive a second device reporting them", () => {
    withStore((store) => {
      const { accountId, deviceId } = seedAccount(store);
      const first = store.insertEntries(accountId, deviceId, [entry("shared"), entry("own")]);
      assert.deepEqual(first, { accepted: 2, deduped: 0 });
      const second = store.insertEntries(accountId, deviceId, [entry("shared"), entry("new")]);
      assert.deepEqual(second, { accepted: 1, deduped: 1 });
      assert.equal(store.entryCount(accountId), 3);
    });
  });

  test("the same entry id in two accounts is stored twice", () => {
    withStore((store) => {
      const first = seedAccount(store);
      const second = seedAccount(store);
      store.insertEntries(first.accountId, first.deviceId, [entry("same-id")]);
      store.insertEntries(second.accountId, second.deviceId, [entry("same-id")]);
      assert.equal(store.entryCount(first.accountId), 1);
      assert.equal(store.entryCount(second.accountId), 1);
    });
  });

  test("entries round-trip and are ordered by timestamp", () => {
    withStore((store) => {
      const { accountId, deviceId } = seedAccount(store);
      const now = Date.now();
      const older = entry("older", { timestamp: now - 120_000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, webSearch: 0 }, agentId: "agent-1", isFast: true });
      const newer = entry("newer", { timestamp: now - 60_000 });
      store.insertEntries(accountId, deviceId, [newer, older]);
      const loaded = store.entriesForQuota(accountId, now - 300_000);
      assert.deepEqual(loaded.map((item) => item.id), ["older", "newer"]);
      assert.equal(loaded[0]?.agentId, "agent-1");
      assert.equal(loaded[0]?.isFast, true);
      assert.deepEqual(loaded[1]?.tokens, TOKENS);
      assert.deepEqual(loaded[1]?.cost, COST);
      assert.equal(loaded[1]?.deviceId, deviceId);
    });
  });

  test("remoteEntries excludes the requesting device and honors the cursor", () => {
    withStore((store) => {
      const { accountId, deviceId } = seedAccount(store);
      const otherDevice = randomUUID();
      store.upsertDevice(accountId, { id: otherDevice, name: "Other", platform: "linux", appVersion: "2.0.0", lastSeenAt: Date.now() });
      store.insertEntries(accountId, deviceId, [entry("mine")]);
      store.insertEntries(accountId, otherDevice, [entry("theirs-1"), entry("theirs-2")]);
      const remote = store.remoteEntries(accountId, deviceId, 0);
      assert.deepEqual(remote.map((item) => item.entry.id), ["theirs-1", "theirs-2"]);
      assert.equal(remote[0]?.entry.deviceId, otherDevice);
      const cursor = remote[remote.length - 1]!.seq;
      assert.deepEqual(store.remoteEntries(accountId, deviceId, cursor), []);
      store.insertEntries(accountId, otherDevice, [entry("theirs-3")]);
      assert.deepEqual(store.remoteEntries(accountId, deviceId, cursor).map((item) => item.entry.id), ["theirs-3"]);
    });
  });

  test("totals sum cost for today and the rolling week", () => {
    withStore((store) => {
      const { accountId, deviceId } = seedAccount(store);
      const now = Date.now();
      store.insertEntries(accountId, deviceId, [
        entry("today", { timestamp: now - 60_000 }),
        entry("this-week", { timestamp: now - 3 * 86_400_000 }),
        entry("too-old", { timestamp: now - 30 * 86_400_000 }),
      ]);
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const totals = store.totals(accountId, midnight.getTime(), now - 7 * 86_400_000);
      assert.equal(totals.weekCost, 6);
      assert.ok(totals.todayRequests >= 1 && totals.todayRequests <= 2);
      assert.equal(totals.todayCost, totals.todayRequests * 3);
    });
  });
});

describe("store: observations and plan", () => {
  test("observations dedupe on the contract key", () => {
    withStore((store) => {
      const { accountId, deviceId } = seedAccount(store);
      const now = Date.now();
      const observation = { kind: "fiveHour" as const, observedAt: now, resetsAt: now + 4 * 3_600_000, usedPercentage: 12, source: "statusLine" as const, sessionId: "s1" };
      assert.deepEqual(store.insertObservations(accountId, deviceId, [observation]), { accepted: 1, deduped: 0 });
      assert.deepEqual(store.insertObservations(accountId, deviceId, [observation]), { accepted: 0, deduped: 1 });
      assert.equal(store.observationCount(accountId), 1);
      const loaded = store.observationsForQuota(accountId, 0, 100);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.kind, "fiveHour");
      assert.equal(loaded[0]?.usedPercentage, 12);
      assert.equal(loaded[0]?.deviceId, deviceId);
    });
  });

  test("observation pruning drops old readings", () => {
    withStore((store) => {
      const { accountId, deviceId } = seedAccount(store);
      const now = Date.now();
      store.insertObservations(accountId, deviceId, [
        { kind: "fiveHour", observedAt: now - 40 * 86_400_000, resetsAt: now, usedPercentage: 1, source: "statusLine" },
        { kind: "fiveHour", observedAt: now, resetsAt: now + 4 * 3_600_000, usedPercentage: 2, source: "statusLine" },
      ]);
      assert.equal(store.pruneObservations(accountId, now - 30 * 86_400_000), 1);
      assert.equal(store.observationCount(accountId), 1);
    });
  });

  test("plan history records tier changes only", () => {
    withStore((store) => {
      const { accountId } = seedAccount(store);
      store.recordPlan(accountId, { tier: "default_claude_max_5x", organizationType: "claude_max", fetchedAt: 1000 });
      store.recordPlan(accountId, { tier: "default_claude_max_5x", organizationType: "claude_max", fetchedAt: 2000 });
      store.recordPlan(accountId, { tier: "default_claude_max_20x", organizationType: "claude_max", fetchedAt: 3000 });
      assert.equal(store.plan(accountId)?.tier, "default_claude_max_20x");
      assert.deepEqual(store.planHistory(accountId).map((item) => item.tier), ["default_claude_max_5x", "default_claude_max_20x"]);
    });
  });

  test("databases are independent and re-opening a file keeps data", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-store-reopen-"));
    const dbPath = join(dir, "reopen.sqlite");
    try {
      const first = new SyncStore(dbPath);
      const account = first.createAccount({ id: randomUUID(), username: "persisted", passwordHash: "h", salt: "s", createdAt: 1 });
      assert.ok(account);
      first.close();
      const second = new SyncStore(dbPath);
      assert.equal(second.accountByUsername("persisted")?.id, account.id);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
