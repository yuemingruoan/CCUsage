// Shared helpers for seeding a local sync server with two demo devices.
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Pricing } from "@ccusage/core";
import type { CostBreakdown, QuotaObservation, SyncClient, SyncSessionMeta, TokenCounts, UsageEntry } from "@ccusage/core";

export const DEMO_ACCOUNT = { username: "demo", password: "demo123" };

const SESSION_TITLES = ["GPU 调试", "渲染管线优化", "发布构建"];
const SESSION_PROJECTS = ["demo-alpha", "demo-beta", "demo-gamma"];
const MODEL_CHOICES = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export interface SeededUsage {
  entries: UsageEntry[];
  sessions: SyncSessionMeta[];
}

interface SessionAccumulator {
  requests: number;
  start: number;
  end: number;
  tokens: TokenCounts;
  cost: CostBreakdown;
  models: Set<string>;
}

export function makeEntries(deviceId: string, startMs: number, count: number, seed: number): SeededUsage {
  const entries: UsageEntry[] = [];
  const sessionCount = SESSION_TITLES.length;
  const sessionIds = SESSION_TITLES.map((_, index) => deviceId + "-s" + (index + 1));
  const accumulators: SessionAccumulator[] = SESSION_TITLES.map(() => ({
    requests: 0,
    start: Number.POSITIVE_INFINITY,
    end: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearches: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 },
    models: new Set<string>(),
  }));
  let x = seed >>> 0;
  const rnd = () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
  const span = 3 * 3_600_000;
  for (let i = 0; i < count; i++) {
    const sessionIndex = Math.min(sessionCount - 1, Math.floor((i * sessionCount) / Math.max(count, 1)));
    const model = MODEL_CHOICES[Math.floor(rnd() * MODEL_CHOICES.length)] as string;
    const big = model.includes("opus") ? 1.6 : model.includes("sonnet") ? 1 : 0.5;
    // Demo separation: the laptop uses the subscription path (1h cache), the studio
    // device stands in for an API-key / third-party setup (5m cache only).
    const thirdParty = deviceId.includes("studio");
    const cacheWrite = Math.floor((thirdParty ? 10_000 : 4_000) * big + rnd() * 2_000);
    const tokens: TokenCounts = {
      input: 4 + Math.floor(rnd() * 20),
      output: Math.floor((300 + rnd() * 1_500) * big),
      cacheRead: Math.floor((80_000 + rnd() * 150_000) * big),
      cacheWrite5m: thirdParty ? cacheWrite : 0,
      cacheWrite1h: thirdParty ? 0 : cacheWrite,
      webSearches: rnd() < 0.05 ? 1 : 0,
    };
    const cost = Pricing.cost(tokens, model, false) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 };
    const timestamp = Math.floor(startMs + (i / Math.max(count, 1)) * span);
    const sessionId = sessionIds[sessionIndex] as string;
    entries.push({
      id: deviceId + "-req-" + i,
      sessionId,
      timestamp,
      model,
      tokens,
      isFast: false,
      cost,
      isPriced: true,
      deviceId,
    });
    const accumulator = accumulators[sessionIndex] as SessionAccumulator;
    accumulator.requests += 1;
    accumulator.start = Math.min(accumulator.start, timestamp);
    accumulator.end = Math.max(accumulator.end, timestamp);
    accumulator.tokens.input += tokens.input;
    accumulator.tokens.output += tokens.output;
    accumulator.tokens.cacheRead += tokens.cacheRead;
    accumulator.tokens.cacheWrite5m += tokens.cacheWrite5m;
    accumulator.tokens.cacheWrite1h += tokens.cacheWrite1h;
    accumulator.tokens.webSearches += tokens.webSearches;
    accumulator.cost.input += cost.input;
    accumulator.cost.output += cost.output;
    accumulator.cost.cacheRead += cost.cacheRead;
    accumulator.cost.cacheWrite += cost.cacheWrite;
    accumulator.cost.webSearch += cost.webSearch;
    accumulator.models.add(model);
  }
  const prefix = deviceId.includes("studio") ? "Studio " : "";
  const sessions: SyncSessionMeta[] = SESSION_TITLES.map((title, index) => {
    const accumulator = accumulators[index] as SessionAccumulator;
    return {
      id: sessionIds[index] as string,
      title: prefix + title,
      projectName: SESSION_PROJECTS[index] as string,
      cwd: "/Users/demo/" + SESSION_PROJECTS[index],
      start: accumulator.start,
      end: accumulator.end,
      requests: accumulator.requests,
      tokens: accumulator.tokens,
      cost: accumulator.cost,
      models: [...accumulator.models],
      subagentCount: 0,
      hasUnpricedRequests: false,
      authMode: deviceId.includes("studio") ? "thirdParty" : "subscription",
    };
  });
  return { entries, sessions };
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

export async function seedAccount(
  client: SyncClient,
  device: { id: string; name: string; platform: string; appVersion: string },
  usage: SeededUsage,
  observations: QuotaObservation[],
  since: number,
) {
  // Login first (works on an existing demo DB), fall back to signup on a fresh one.
  const account = await client.login(DEMO_ACCOUNT.username, DEMO_ACCOUNT.password, device).catch(() =>
    client.signup(DEMO_ACCOUNT.username, DEMO_ACCOUNT.password, device),
  );
  client.setToken(account.token);
  const ingest = await client.ingest({
    device,
    entries: usage.entries,
    observations,
    sessions: usage.sessions,
    cursor: 0,
  });
  const pull = await client.pull(since);
  return { login: account, ingest, pull };
}

export function serverDbPath(demoDir: string): string {
  mkdirSync(join(demoDir, "server"), { recursive: true });
  return join(demoDir, "server/ccusage.sqlite");
}
