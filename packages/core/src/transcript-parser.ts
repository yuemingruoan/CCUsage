// Port of legacy/swift/Sources/CCUsageCore/TranscriptParser.swift.
//
// Reads one Claude Code transcript (`~/.claude/projects/<project>/<session>.jsonl` or
// `<session>/subagents/agent-<id>.jsonl`) and extracts per-request usage plus the session
// metadata Claude Code records in "user", "custom-title", "agent-name" and "summary" lines.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  LimitEvent,
  ParsedTranscript,
  SessionMetadata,
  TokenCounts,
  UsageEntry
} from "./types.js";
import { Pricing } from "./pricing.js";

/** Absolute path components; used to mirror Swift URL.pathComponents arithmetic. */
function pathComponents(filePath: string): string[] {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return normalized.split("/").filter((component) => component.length > 0);
}

/**
 * Parses a transcript file. Synchronous like the Swift original; async scanners should
 * read the bytes themselves and call {@link parseTranscriptData}.
 */
export function parseTranscript(filePath: string, projectsRoot: string): ParsedTranscript {
  const data = readFileSync(filePath);
  return parseTranscriptData(data, filePath, projectsRoot);
}

/** Parses transcript bytes (UTF-8) or already-decoded text. */
export function parseTranscriptData(
  data: string | Uint8Array,
  filePath: string,
  projectsRoot: string
): ParsedTranscript {
  const fileComponents = pathComponents(filePath);
  const rootComponents = pathComponents(projectsRoot);
  const projectDirectory =
    fileComponents.length > rootComponents.length ? fileComponents[rootComponents.length] ?? "" : "";

  const fileStem = path.parse(filePath).name;
  const isSubagent = fileComponents[fileComponents.length - 2] === "subagents";
  const fallbackSessionId = isSubagent
    ? fileComponents[fileComponents.length - 3] ?? fileStem
    : fileStem;
  const agentId = isSubagent ? removePrefix(fileStem, "agent-") : undefined;

  const state = new ParseState(agentId, !isSubagent);
  const text = typeof data === "string" ? data : new TextDecoder("utf-8").decode(data);
  // Swift walks raw bytes and feeds every non-empty newline-terminated chunk; identical here.
  for (const line of text.split("\n")) {
    if (line.length > 0) state.consume(line);
  }

  return {
    path: filePath,
    projectDirectory,
    sessionId: state.sessionId ?? fallbackSessionId,
    ...(agentId !== undefined ? { agentId } : {}),
    entries: state.entryOrder
      .map((key) => state.entries.get(key))
      .filter((entry): entry is UsageEntry => entry !== undefined),
    metadata: state.metadata,
    limitEvents: state.limitEvents
  };
}

function removePrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

// MARK: - Line handling

class ParseState {
  private readonly agentId: string | undefined;
  private wantsFirstPrompt: boolean;
  private userLinesInspected = 0;
  sessionId: string | undefined;
  metadata: SessionMetadata = {};
  entries = new Map<string, UsageEntry>();
  entryOrder: string[] = [];
  limitEvents: LimitEvent[] = [];

  constructor(agentId: string | undefined, wantsFirstPrompt: boolean) {
    this.agentId = agentId;
    this.wantsFirstPrompt = wantsFirstPrompt;
  }

  consume(line: string): void {
    if (line.includes(Needle.assistant)) {
      if (line.includes(Needle.rateLimitError)) {
        const record = decode(line);
        if (record !== undefined && record["type"] === "assistant") this.handleLimit(record);
      } else {
        const record = decode(line);
        if (record !== undefined && record["type"] === "assistant") this.handleAssistant(record);
      }
    } else if (
      line.includes(Needle.customTitle) ||
      line.includes(Needle.agentName) ||
      line.includes(Needle.summary)
    ) {
      const record = decode(line);
      if (record !== undefined) this.handleMeta(record);
    } else if (this.wantsFirstPrompt && line.includes(Needle.user)) {
      this.userLinesInspected += 1;
      if (this.userLinesInspected > 50) this.wantsFirstPrompt = false;
      const record = decode(line);
      if (record !== undefined && record["type"] === "user") this.handleUser(record);
    }
  }

  private noteCommonFields(record: Record<string, unknown>): void {
    const sessionId = asString(record["sessionId"]);
    const cwd = asString(record["cwd"]);
    const gitBranch = asString(record["gitBranch"]);
    const version = asString(record["version"]);
    if (this.sessionId === undefined) this.sessionId = sessionId;
    if (this.metadata.cwd === undefined) this.metadata.cwd = cwd;
    if (gitBranch !== undefined && gitBranch.length > 0) this.metadata.gitBranch = gitBranch;
    if (version !== undefined) this.metadata.version = version;
  }

  private handleAssistant(record: Record<string, unknown>): void {
    this.noteCommonFields(record);
    const message = asRecord(record["message"]);
    const usage = message === undefined ? undefined : asRecord(message["usage"]);
    const model = message === undefined ? undefined : asString(message["model"]);
    const timestamp = parseTimestamp(asString(record["timestamp"]));
    if (usage === undefined || model === undefined || model === "<synthetic>" || timestamp === undefined) {
      return;
    }

    // Cache writes: total creation tokens minus the 1-hour count is the 5-minute count,
    // but never below the explicitly reported 5-minute count (matches Swift).
    const cacheCreation = asRecord(usage["cache_creation"]);
    const totalWrite = asInt(usage["cache_creation_input_tokens"]) ?? 0;
    const write1h = cacheCreation === undefined ? 0 : asInt(cacheCreation["ephemeral_1h_input_tokens"]) ?? 0;
    const reported5m = cacheCreation === undefined ? 0 : asInt(cacheCreation["ephemeral_5m_input_tokens"]) ?? 0;
    const write5m = Math.max(totalWrite - write1h, reported5m);
    const serverToolUse = asRecord(usage["server_tool_use"]);
    const webSearches = serverToolUse === undefined ? 0 : asInt(serverToolUse["web_search_requests"]) ?? 0;

    const tokens: TokenCounts = {
      input: asInt(usage["input_tokens"]) ?? 0,
      output: asInt(usage["output_tokens"]) ?? 0,
      cacheRead: asInt(usage["cache_read_input_tokens"]) ?? 0,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
      webSearches
    };
    if (tokensTotal(tokens) <= 0 && tokens.webSearches <= 0) return;

    const messageId = message === undefined ? undefined : asString(message["id"]);
    const requestId = asString(record["requestId"]);
    const key = `${messageId ?? asString(record["uuid"]) ?? randomUUID()}:${requestId ?? ""}`;
    // Claude Code writes one line per content block with the same message id; later lines
    // carry the final (largest) output count.
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.tokens.output > tokens.output) return;
    if (existing === undefined) this.entryOrder.push(key);

    const cost = Pricing.cost(tokens, model, usage["speed"] === "fast");
    this.entries.set(key, {
      id: key,
      sessionId: asString(record["sessionId"]) ?? this.sessionId ?? "",
      timestamp,
      model,
      tokens,
      isFast: usage["speed"] === "fast",
      ...(this.agentId !== undefined ? { agentId: this.agentId } : {}),
      cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 },
      isPriced: cost !== undefined
    });
  }

  private handleLimit(record: Record<string, unknown>): void {
    const timestamp = parseTimestamp(asString(record["timestamp"]));
    if (timestamp === undefined) return;
    const message = asRecord(record["message"]);
    const content = message === undefined ? undefined : message["content"];
    if (!Array.isArray(content)) return;
    let text: string | undefined;
    for (const block of content) {
      const blockRecord = asRecord(block);
      if (blockRecord === undefined) continue;
      if (blockRecord["type"] === "text" && typeof blockRecord["text"] === "string") {
        text = blockRecord["text"];
        break;
      }
    }
    if (text === undefined) return;
    this.limitEvents.push({ timestamp, text });
  }

  private handleMeta(record: Record<string, unknown>): void {
    switch (record["type"]) {
      case "custom-title": {
        const title = nonEmpty(asString(record["customTitle"]));
        if (title !== undefined) this.metadata.customTitle = title;
        break;
      }
      case "agent-name": {
        const name = nonEmpty(asString(record["agentName"]));
        if (name !== undefined) this.metadata.agentName = name;
        break;
      }
      case "summary": {
        const summary = nonEmpty(asString(record["summary"]));
        if (summary !== undefined) this.metadata.summary = summary;
        break;
      }
      default:
        break;
    }
  }

  private handleUser(record: Record<string, unknown>): void {
    this.noteCommonFields(record);
    if (record["isMeta"] === true) return;
    const message = asRecord(record["message"]);
    const content = message === undefined ? undefined : message["content"];
    const text = firstText(content);
    if (text === undefined) return;
    const trimmed = text.trim();
    // Skip slash-command wrappers, caveats and injected reminders.
    if (trimmed.length === 0 || trimmed.startsWith("<") || trimmed.startsWith("Caveat:")) return;
    // Swift takes prefix(200) then replaces newlines with spaces.
    this.metadata.firstPrompt = Array.from(trimmed)
      .slice(0, 200)
      .join("")
      .replace(/\n/g, " ");
    this.wantsFirstPrompt = false;
  }
}

function tokensTotal(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
}

const Needle = {
  assistant: '"type":"assistant"',
  rateLimitError: '"error":"rate_limit"',
  user: '"type":"user"',
  customTitle: '"type":"custom-title"',
  agentName: '"type":"agent-name"',
  summary: '"type":"summary"'
} as const;

// MARK: - Record decoding helpers

function decode(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function firstText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const record = asRecord(block);
    if (record !== undefined && record["type"] === "text" && typeof record["text"] === "string") {
      return record["text"];
    }
  }
  return undefined;
}

/**
 * ISO-8601 timestamps as written by Claude Code (`2026-09-26T05:33:38.007Z`).
 * Swift's ISO8601DateFormatter required a zone designator, so strings without one are
 * rejected here too (JS would otherwise parse them as host-local time).
 */
export function parseTimestamp(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}
