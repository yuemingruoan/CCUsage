// Shared helpers for seeding a local sync server with two demo devices.
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Pricing } from "@ccusage/core";
import type { QuotaObservation, SyncClient, UsageEntry } from "@ccusage/core";

export const DEMO_ACCOUNT = { username: "demo", password: "demo123" };

export function makeEntries(deviceId: string, startMs: number, count: number, seed: number): UsageEntry[] {
  const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
  const entries: UsageEntry[] = [];
  let x = seed >>> 0;
  const rnd = () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
  const span = 3 * 3_600_000;
  for (let i = 0; i < count; i++) {
    const model = models[Math.floor(rnd() * models.length)] as string;
    const big = model.includes("opus") ? 1.6 : model.includes("sonnet") ? 1 : 0.5;
    const tokens = {
      input: 4 + Math.floor(rnd() * 20),
      output: Math.floor((300 + rnd() * 1_500) * big),
      cacheRead: Math.floor((80_000 + rnd() * 150_000) * big),
      cacheWrite5m: Math.floor((500 + rnd() * 2_000) * big),
      cacheWrite1h: Math.floor((1_000 + rnd() * 6_000) * big),
      webSearches: rnd() < 0.05 ? 1 : 0,
    };
    const cost = Pricing.cost(tokens, model, false) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 };
    entries.push({
      id: deviceId + "-req-" + i,
      sessionId: deviceId + "-session",
      timestamp: Math.floor(startMs + (i / Math.max(count, 1)) * span),
      model, tokens, isFast: false, cost, isPriced: true, deviceId,
    });
  }
  return entries;
}

export function demoObservations(now: number, deviceId: string, offsetMs: number): QuotaObservation[] {
  const out: QuotaObservation[] = [];
  const fhReset = now + 2 * 3_600_000;
  const sdReset = now + 3 * 86_400_000;
  const fh = [12, 22, 31, 38, 42];
  fh.forEach((pct, i) => out.push({
    kind: "fiveHour", observedAt: Math.floor(now - (fh.length - i) * 20 * 60_000 + offsetMs),
    resetsAt: Math.floor(fhReset), usedPercentage: pct, source: "statusLine", sessionId: "demo", deviceId,
  }));
  const sd = [68, 72, 75, 78];
  sd.forEach((pct, i) => out.push({
    kind: "sevenDay", observedAt: Math.floor(now - (sd.length - i) * 6 * 3_600_000 + offsetMs),
    resetsAt: Math.floor(sdReset), usedPercentage: pct, source: "statusLine", sessionId: "demo", deviceId,
  }));
  return out;
}

export async function seedAccount(client: SyncClient, device: { id: string; name: string; platform: string; appVersion: string }, entries: UsageEntry[], observations: QuotaObservation[], since: number) {
  // Login first (works on an existing demo DB), fall back to signup on a fresh one.
  const account = await client.login(DEMO_ACCOUNT.username, DEMO_ACCOUNT.password, device).catch(() =>
    client.signup(DEMO_ACCOUNT.username, DEMO_ACCOUNT.password, device),
  );
  client.setToken(account.token);
  const ingest = await client.ingest({ device, entries, observations, cursor: 0 });
  const pull = await client.pull(since);
  return { login: account, ingest, pull };
}

export function serverDbPath(demoDir: string): string {
  mkdirSync(join(demoDir, "server"), { recursive: true });
  return join(demoDir, "server/ccusage.sqlite");
}