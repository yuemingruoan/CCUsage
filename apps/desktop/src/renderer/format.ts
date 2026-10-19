// Display formatting. Thin adapters over @ccusage/core Format (ported from Formatting.swift)
// plus a few renderer-only helpers. All timestamps are epoch milliseconds.
import { Format } from "@ccusage/core/pure";
import type { AuthMode, QuotaKind, TimeGranularity, WindowMode } from "@ccusage/core/pure";

// MARK: - Labels copied from the Swift views

export const QUOTA_KIND_LABELS: Record<QuotaKind, string> = {
  fiveHour: "5 小时",
  sevenDay: "每周",
};

export const WINDOW_MODE_LABELS: Record<WindowMode, string> = {
  firstRequest: "首条请求开启窗口",
  fixedRolling: "固定周期滚动",
};

export const GRANULARITY_LABELS: Record<TimeGranularity, string> = {
  fiveMinutes: "5 分钟",
  fifteenMinutes: "15 分钟",
  hour: "小时",
  day: "天",
  week: "周",
};

export const GRANULARITY_ORDER: readonly TimeGranularity[] = [
  "fiveMinutes",
  "fifteenMinutes",
  "hour",
  "day",
  "week",
];

export const MAIN_SERIES = "主会话";
export const SUBAGENT_SERIES = "子代理";

// MARK: - Core Format adapters

export function usd(value: number): string {
  return Format.usd(value);
}

export function formatTokens(value: number): string {
  return Format.tokens(value);
}

/** Duration in milliseconds. */
export function duration(ms: number): string {
  return Format.duration(ms);
}

export function dateTime(ms: number): string {
  return Format.dateTime(ms);
}

export function bucketLabel(start: number, granularity: TimeGranularity): string {
  return Format.bucketLabel(start, granularity);
}

export function bucketRange(start: number, granularity: TimeGranularity): string {
  return Format.bucketRange(start, granularity);
}

export function windowStartLabel(start: number, kind: QuotaKind): string {
  return Format.windowStart(start, kind);
}

export function windowEndLabel(end: number, start: number, kind: QuotaKind): string {
  return Format.windowEnd(end, start, kind);
}

export const AUTH_LABELS: Record<AuthMode, string> = {
  subscription: "订阅",
  thirdParty: "第三方模型",
  mixed: "混合",
  unknown: "未知",
};

export const AUTH_HINTS: Record<AuthMode, string> = {
  subscription: "使用 Claude 模型，计入 5h / 7d 订阅额度（直连、中转或共享登录都一样）",
  thirdParty: "非 Claude 模型（deepseek/kimi/glm/grok/gpt 等），不消耗 Claude 订阅额度",
  mixed: "同一会话混用了 Claude 模型与第三方模型",
  unknown: "没有可用的模型信息",
};

// MARK: - Renderer-only helpers

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** HH:mm */
export function timeShort(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** HH:mm:ss */
export function timeHMS(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** MM/DD HH:mm */
export function dateTimeShort(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** MM/DD HH:mm – MM/DD HH:mm (or a single timestamp when both are close). */
export function dateRange(start: number, end: number): string {
  return dateTimeShort(start) + " – " + dateTimeShort(end);
}

/** YYYY/MM/DD */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Port of QuotaCard.resetText: today's 5-hour reset shows only the time. */
export function resetText(ms: number, kind: QuotaKind): string {
  if (kind === "fiveHour" && isSameDay(ms, Date.now())) return timeShort(ms);
  return dateTime(ms);
}

/** Port of Swift .relative(presentation: .named), Chinese. */
export function relativeTime(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < 0) return timeShort(ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return dayLabel(ms).slice(5); // MM/DD
}

/** "16.1 秒" / "850 毫秒" — port of the sidebar scan duration text. */
export function scanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 秒";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

/** "$" + up to 3 decimals, port of Swift PricingTable.price. */
export function price(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return "$" + String(rounded);
}

/** PlanInfo.displayName: default_claude_max_20x -> "Max 20x". */
export function planDisplayName(tier: string): string {
  const parts = tier.replace(/^default_/, "").split("_");
  if (parts[0] !== "claude") return tier;
  return parts
    .slice(1)
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(" ");
}

/** Shell-quote one path component for the "复制 resume 命令" button. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}