// Synthetic Claude Code fixtures for demos, screenshots and tests.
// Everything is deterministic for a given "now" so the UI dates stay stable.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Pricing, costTotal } from "@ccusage/core";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const pad2 = (n: number) => String(n).padStart(2, "0");

export interface FixtureSession {
  sessionId: string;
  project: string;      // encoded project directory name
  cwd: string;
  title: string;
  firstPrompt: string;
  startMs: number;
  turns: number;
  model: string;
  branch?: string;
  subagent?: boolean;
  entrypoint?: "cli" | "claude-desktop" | "sdk-cli";
}

interface UsageShape {
  input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number;
}

function usageFor(model: string, index: number, rnd: () => number): UsageShape {
  const big = model.includes("opus") ? 1.6 : model.includes("sonnet") ? 1 : 0.5;
  const cacheRead = Math.floor((80_000 + rnd() * 160_000) * big);
  // Demo local sessions mimic the real subscription path: 1h prompt cache only.
  const cacheWrite = Math.floor((2_000 + rnd() * 9_000) * big);
  const write1h = cacheWrite;
  return {
    input: 4 + Math.floor(rnd() * 20),
    output: 300 + Math.floor(rnd() * 1_400),
    cacheRead,
    cacheWrite5m: 0,
    cacheWrite1h: write1h,
  };
}

export function sessionLines(session: FixtureSession): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  const step = Math.max(45_000, Math.floor(20 * 60_000 / Math.max(session.turns, 1)));
  const base = {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: session.branch ?? "main",
    version: "2.1.299",
    entrypoint: session.entrypoint ?? "cli",
    userType: "external",
  };
  lines.push({ ...base, type: "custom-title", customTitle: session.title });
  lines.push({
    ...base, type: "user", uuid: session.sessionId + "-u0", timestamp: iso(session.startMs),
    message: { role: "user", content: [{ type: "text", text: session.firstPrompt }] },
  });
  const rnd = mulberry32(session.sessionId.split("").reduce((a, c) => a + c.charCodeAt(0), 7));
  for (let i = 0; i < session.turns; i++) {
    const ts = session.startMs + i * step;
    const usage = usageFor(session.model, i, rnd);
    const tag = session.sessionId.replace(/-/g, "").slice(-10);
    const messageId = "msg_" + tag + "_" + i;
    const requestId = "req_" + tag + "_" + i;
    const assistant = {
      ...base, type: "assistant", uuid: session.sessionId + "-a" + i, parentUuid: session.sessionId + "-u" + i,
      timestamp: iso(ts + 20_000), requestId, isSidechain: false,
      message: {
        id: messageId, role: "assistant", model: session.model,
        usage: {
          input_tokens: usage.input, output_tokens: usage.output,
          cache_creation_input_tokens: usage.cacheWrite5m + usage.cacheWrite1h,
          cache_creation: { ephemeral_5m_input_tokens: usage.cacheWrite5m, ephemeral_1h_input_tokens: usage.cacheWrite1h },
          cache_read_input_tokens: usage.cacheRead,
          server_tool_use: { web_search_requests: i % 17 === 0 ? 1 : 0 },
          service_tier: "standard",
        },
        content: [{ type: "text", text: "ok (" + i + ")" }],
      },
    };
    // Claude Code writes one line per content block; the duplicate must dedupe away.
    lines.push(structuredClone(assistant));
    lines.push(assistant);
    if (i % 5 === 0) {
      lines.push({
        ...base, type: "user", uuid: session.sessionId + "-u" + (i + 1), timestamp: iso(ts + 40_000),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "done" }] },
      });
    }
  }
  return lines;
}

export function subagentLines(session: FixtureSession): Array<Record<string, unknown>> {
  // Distinct API requests: generate them under their own id space, then re-attribute to the parent.
  const own = sessionLines({ ...session, sessionId: session.sessionId + "-subagent", turns: Math.max(2, Math.floor(session.turns / 6)), entrypoint: session.entrypoint });
  return own.map(line => {
    const copy: Record<string, unknown> = { ...line, sessionId: session.sessionId };
    if (copy["type"] === "custom-title") {
      delete copy["customTitle"];
      copy["type"] = "agent-name";
      copy["agentName"] = "demo subagent";
    }
    return copy;
  });
}

export function planInfo(now: number) {
  return {
    oauthAccount: {
      organizationRateLimitTier: "default_claude_max_20x",
      organizationType: "claude_max",
      profileFetchedAt: now - 3 * 86_400_000,
    },
  };
}

/**
 * Build 5h / 7d readings from the fixture's own spend so the estimated limit is
 * self-consistent: used% is pinned (42 / 78) and the implied 100% is spend / used%,
 * which is exactly what the app derives. Demo amounts are synthetic, not plan limits.
 */
export function demoRateLimitLines(now: number, spent5h: number, spent7d: number): string[] {
  const lines: string[] = [];
  const fhReset = now + 2 * 3_600_000;
  const sdReset = now + 3 * 86_400_000;
  const pct5 = 42;
  const pct7 = 78;
  const fhObservedAt = now - 2 * 60_000;
  const sdObservedAt = now - 60_000;
  const implied5 = Math.max(spent5h, 1) / (pct5 / 100);
  if (spent5h > 0) {
    lines.push(JSON.stringify({ ts: Math.floor(fhObservedAt / 1000), session_id: "demo-session-a", five_hour: { used_percentage: pct5, resets_at: Math.floor(fhReset / 1000) }, seven_day: null }));
  }
  if (spent7d > 0) {
    lines.push(JSON.stringify({ ts: Math.floor(sdObservedAt / 1000), session_id: "demo-session-a", five_hour: null, seven_day: { used_percentage: pct7, resets_at: Math.floor(sdReset / 1000) } }));
    lines.push(JSON.stringify({ ts: Math.floor((sdObservedAt + 1) / 1000), session_id: "demo-session-a", five_hour: { used_percentage: pct5, resets_at: Math.floor(fhReset / 1000) }, seven_day: { used_percentage: pct7, resets_at: Math.floor(sdReset / 1000) } }));
  }
  void implied5;
  return lines;
}

export interface DemoData {
  projectsDir: string;
  sessions: Array<{ sessionId: string; title: string; costHint: number }>;
}

export function seedDemoDir(dir: string, now = Date.now()): DemoData {
  const costOfLines = (lines: Array<Record<string, unknown>>): Array<{ at: number; cost: number }> =>
    lines.flatMap(line => {
      if (line["type"] !== "assistant") return [];
      const message = line["message"] as { model?: string; usage?: Record<string, any> } | undefined;
      const usage = message?.usage;
      if (!message?.model || !usage) return [];
      const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const totalWrite = usage.cache_creation_input_tokens ?? 0;
      const tokens = {
        input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite5m: Math.max(totalWrite - write1h, usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
        cacheWrite1h: write1h, webSearches: usage.server_tool_use?.web_search_requests ?? 0,
      };
      const cost = Pricing.cost(tokens, message.model, false);
      if (!cost) return [];
      const at = Date.parse(String(line["timestamp"] ?? ""));
      return [{ at, cost: costTotal(cost) }];
    });
  rmSync(dir, { recursive: true, force: true });
  const projectsDir = join(dir, "projects");
  mkdirSync(projectsDir, { recursive: true });
  const planDir = join(dir, "CCUsage");
  mkdirSync(planDir, { recursive: true });

  const H = 3_600_000;
  const D = 86_400_000;
  const today0 = new Date(now);
  today0.setHours(0, 0, 0, 0);
  const t0 = today0.getTime();

  const sessions: FixtureSession[] = [
    { sessionId: "a1b2c3d4-0000-4000-8000-000000000001", project: "-Users-demo-Code-alpha", cwd: "/Users/demo/Code/alpha", title: "重构渲染管线", firstPrompt: "帮我看看这个渲染管线为什么掉帧", startMs: now - 5 * H, turns: 46, model: "claude-opus-5-5", entrypoint: "claude-desktop" },
    { sessionId: "a1b2c3d4-0000-4000-8000-000000000002", project: "-Users-demo-Code-alpha", cwd: "/Users/demo/Code/alpha", title: "补齐单元测试", firstPrompt: "给 core 模块补一组测试", startMs: now - 2 * D, turns: 24, model: "claude-sonnet-5-5" },
    { sessionId: "a1b2c3d4-0000-4000-8000-000000000003", project: "-Users-demo-Code-alpha", cwd: "/Users/demo/Code/alpha", title: "整理发布说明", firstPrompt: "写一版 release notes", startMs: now - 4 * D, turns: 12, model: "claude-haiku-5-5" },
    { sessionId: "a1b2c3d4-0000-4000-8000-000000000004", project: "-Users-demo-Code-beta", cwd: "/Users/demo/Code/beta", title: "排查 CI 卡住", firstPrompt: "CI 又卡在 build 阶段了，帮我看看", startMs: now - 8 * H, turns: 33, model: "claude-opus-5-5", entrypoint: "claude-desktop" },
    { sessionId: "a1b2c3d4-0000-4000-8000-000000000005", project: "-Users-demo-Code-beta", cwd: "/Users/demo/Code/beta", title: "接口对齐", firstPrompt: "和后端对一下接口字段", startMs: now - 1 * D, turns: 15, model: "claude-sonnet-5-5" },
    { sessionId: "a1b2c3d4-0000-4000-8000-000000000006", project: "-Users-demo-Notes", cwd: "/Users/demo/Notes", title: "整理周报", firstPrompt: "把这周的改动整理成周报", startMs: t0 + 9 * H, turns: 8, model: "claude-haiku-5-5", branch: "main", subagent: true },
  ];

  const spend: Array<{ at: number; cost: number }> = [];
  for (const session of sessions) {
    const dirName = join(projectsDir, session.project);
    mkdirSync(dirName, { recursive: true });
    const lines = sessionLines(session);
    writeFileSync(join(dirName, session.sessionId + ".jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    spend.push(...costOfLines(lines));
    if (session.subagent) {
      const subDir = join(dirName, session.sessionId, "subagents");
      mkdirSync(subDir, { recursive: true });
      const sub = subagentLines(session);
      writeFileSync(join(subDir, "agent-demo01.jsonl"), sub.map(l => JSON.stringify(l)).join("\n") + "\n");
      spend.push(...costOfLines(sub));
    }
  }
  const fhStart = now + 2 * 3_600_000 - 5 * 3_600_000;
  const sdStart = now + 3 * 86_400_000 - 7 * 86_400_000;
  const spent5h = spend.filter(item => item.at >= fhStart).reduce((sum, item) => sum + item.cost, 0);
  const spent7d = spend.filter(item => item.at >= sdStart).reduce((sum, item) => sum + item.cost, 0);

  // A limit message in one transcript, so the quota view shows a confirmed 100% point.
  const limitFile = join(projectsDir, sessions[1]!.project, sessions[1]!.sessionId + ".jsonl");
  const limitLine = JSON.stringify({
    type: "assistant", sessionId: sessions[1]!.sessionId, timestamp: iso(now - 2 * D + 4 * H),
    error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit · resets 10:10pm (Asia/Singapore)" }] },
  });
  writeFileSync(limitFile, limitLine + "\n", { flag: "a" });

  writeFileSync(join(dir, ".claude.json"), JSON.stringify({
    ...planInfo(now),
    projects: {
      [sessions[0]!.cwd]: { lastSessionId: sessions[0]!.sessionId, lastCost: 18.42 },
      [sessions[3]!.cwd]: { lastSessionId: sessions[3]!.sessionId, lastCost: 9.17 },
    },
  }, null, 2) + "\n");

  writeFileSync(join(planDir, "rate-limits.jsonl"), demoRateLimitLines(now, spent5h, spent7d).join("\n") + "\n");
  writeFileSync(join(planDir, "plan-history.jsonl"), JSON.stringify({
    tier: "default_claude_max_20x", organizationType: "claude_max", fetchedAt: iso(now - 3 * D),
  }) + "\n");

  const costHints = [42.1, 18.6, 3.2, 27.8, 9.4, 1.9];
  return {
    projectsDir,
    sessions: sessions.map((s, i) => ({ sessionId: s.sessionId, title: s.title, costHint: costHints[i] ?? 1 })),
  };
}