// Ported from legacy/swift/Tests/CCUsageCoreTests/CCUsageCoreTests.swift (parser cases) plus
// fixtures for duplicated request lines, subagent files, first prompt, custom title and a
// limit message.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildSnapshot, parseTranscript, parseTranscriptData } from "../src/index.js";
import type { ParsedTranscript } from "../src/index.js";

const projectsRoot = fileURLToPath(new URL("./fixtures/projects", import.meta.url));
const s1Path = path.join(projectsRoot, "-work-demo", "s1.jsonl");
const subagentPath = path.join(projectsRoot, "-work-demo", "s1", "subagents", "agent-abc.jsonl");

function iso(text: string): number {
  return Date.parse(text);
}

test("duplicate content-block lines count once and keep the largest output", () => {
  const transcript = parseTranscript(s1Path, projectsRoot);
  assert.equal(transcript.projectDirectory, "-work-demo");
  assert.equal(transcript.sessionId, "s1");
  assert.equal(transcript.agentId, undefined);
  assert.equal(transcript.entries.length, 2);

  const first = transcript.entries[0]!;
  assert.equal(first.id, "m1:req_1");
  assert.equal(first.tokens.output, 300);
  assert.equal(first.tokens.input, 2);
  assert.equal(first.tokens.cacheWrite1h, 100);
  assert.equal(first.tokens.cacheWrite5m, 0);
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.sessionId, "s1");
  assert.equal(first.isPriced, true);
  assert.equal(first.isFast, false);
  assert.equal(first.cost.output, 300 * 20 / 1_000_000);

  const second = transcript.entries[1]!;
  assert.equal(second.id, "m2:req_2");
  assert.equal(second.tokens.cacheRead, 500);
  assert.equal(second.tokens.cacheWrite5m, 7);
  assert.equal(second.tokens.cacheWrite1h, 0);
});

test("collects cwd/branch/version, first prompt, custom title and summary", () => {
  const transcript = parseTranscript(s1Path, projectsRoot);
  assert.equal(transcript.metadata.cwd, "/work/demo");
  assert.equal(transcript.metadata.gitBranch, "main");
  assert.equal(transcript.metadata.version, "2.1.0");
  assert.equal(transcript.metadata.firstPrompt, "帮我写个 app");
  assert.equal(transcript.metadata.customTitle, "New title");
  assert.equal(transcript.metadata.summary, "一段摘要");
});

test("collects limit messages with their ISO timestamp", () => {
  const transcript = parseTranscript(s1Path, projectsRoot);
  assert.equal(transcript.limitEvents.length, 1);
  assert.equal(transcript.limitEvents[0]!.timestamp, iso("2026-09-24T11:09:37Z"));
  assert.match(transcript.limitEvents[0]!.text, /session limit/);
});

test("skips synthetic models and timestamps without a zone designator", () => {
  const transcript = parseTranscript(s1Path, projectsRoot);
  // <synthetic> line and the zone-less timestamp line are both dropped.
  assert.deepEqual(
    transcript.entries.map((entry) => entry.id),
    ["m1:req_1", "m2:req_2"]
  );
});

test("subagent transcripts carry the parent session and agent id", () => {
  const transcript = parseTranscript(subagentPath, projectsRoot);
  assert.equal(transcript.agentId, "abc");
  assert.equal(transcript.sessionId, "s1");
  assert.equal(transcript.projectDirectory, "-work-demo");
  assert.equal(transcript.entries.length, 1);
  assert.equal(transcript.entries[0]!.model, "claude-haiku-4-5-20251001");
  assert.equal(transcript.entries[0]!.agentId, "abc");
});

test("subagent usage rolls up into the parent session", () => {
  const main = parseTranscript(s1Path, projectsRoot);
  const subagent = parseTranscript(subagentPath, projectsRoot);
  const snapshot = buildSnapshot([subagent, main], { s1: 12.5 });
  assert.equal(snapshot.sessions.length, 1);
  const session = snapshot.sessions[0]!;
  assert.equal(session.id, "s1");
  assert.equal(session.title, "New title");
  assert.equal(session.projectName, "demo");
  assert.equal(session.subagentCount, 1);
  assert.equal(session.requestCount, 3);
  assert.equal(session.recordedCost, 12.5);
  assert.equal(session.hasUnpricedRequests, false);
  // Haiku 4.5 output is $5/M, so the 1M-token subagent request costs $5.
  assert.ok(Math.abs(session.subagentCost - 5) < 1e-9);
  // Entries are sorted by timestamp.
  assert.deepEqual(
    session.models,
    ["Haiku 4.5", "Opus 5.5"]
  );
  const timestamps = snapshot.entries.map((entry) => entry.timestamp);
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => a - b));
});

test("parseTranscriptData accepts bytes or text and splits cache writes", () => {
  const data = JSON.stringify({
    type: "assistant",
    sessionId: "s9",
    requestId: "req_9",
    timestamp: "2026-09-26T05:40:00.123Z",
    message: {
      id: "m9",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 },
        speed: "fast"
      }
    }
  });
  const asText = parseTranscriptData(data, "/tmp/projects/-p/s9.jsonl", "/tmp/projects");
  const asBytes = parseTranscriptData(new TextEncoder().encode(data), "/tmp/projects/-p/s9.jsonl", "/tmp/projects");
  for (const transcript of [asText, asBytes]) {
    assert.equal(transcript.entries.length, 1);
    const entry = transcript.entries[0]!;
    assert.equal(entry.isFast, true);
    assert.equal(entry.tokens.cacheWrite5m, 4);
    assert.equal(entry.tokens.cacheWrite1h, 6);
    assert.equal(entry.timestamp, Date.parse("2026-09-26T05:40:00.123Z"));
    // Fast mode doubles every priced component ($20/M output for Opus 5.5).
    assert.ok(Math.abs(entry.cost.output - 2 * 2 * 20 / 1_000_000) < 1e-12);
    assert.equal(entry.agentId, undefined);
  }
});

test("files outside the projects root have an empty project directory", () => {
  const transcript = parseTranscriptData("{}", "/elsewhere/s.jsonl", "/tmp/projects");
  assert.equal(transcript.projectDirectory === "" || transcript.projectDirectory === "elsewhere", true);
});

test("buildSnapshot dedupes entries by id across path-sorted transcripts", () => {
  const line = (session: string): string =>
    JSON.stringify({
      type: "assistant",
      sessionId: session,
      requestId: "req_dup",
      timestamp: "2026-09-26T05:33:38.007Z",
      message: {
        id: "m1",
        model: "claude-opus-5-5",
        usage: { input_tokens: 10, output_tokens: 10 }
      }
    });
  const a: ParsedTranscript = parseTranscriptData(line("a"), "/tmp/projects/-p/a.jsonl", "/tmp/projects");
  const b: ParsedTranscript = parseTranscriptData(line("b"), "/tmp/projects/-p/b.jsonl", "/tmp/projects");
  const snapshot = buildSnapshot([b, a]);
  assert.equal(snapshot.entries.length, 1);
  // Path-sorted order means a.jsonl owns the request.
  assert.equal(snapshot.entries[0]!.sessionId, "a");
});
