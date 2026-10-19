// Port of legacy/swift/Sources/CCUsage/Formatting.swift (the parts shared with the renderer).
//
// The Swift app formatted with the user's locale; the product copy is Chinese and the
// reference screenshots use the numeric patterns below, so they are fixed here to keep
// the Electron renderer deterministic on every platform.

import type { QuotaKind } from "./types.js";
import type { TimeGranularity } from "./aggregation.js";
import { TimeGranularity as Granularity, granularityLabel } from "./aggregation.js";
import { isSameLocalDay, isoWeekday, zonedParts } from "./time-utils.js";

const pad2 = (value: number): string => (value < 10 ? `0${value}` : String(value));

function localDateTime(ms: number): string {
  const parts = zonedParts(ms);
  return `${pad2(parts.month)}/${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function localDate(ms: number): string {
  const parts = zonedParts(ms);
  return `${parts.year}/${pad2(parts.month)}/${pad2(parts.day)}`;
}

function localTime(ms: number): string {
  const parts = zonedParts(ms);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export const Format = {
  /** USD currency; 3 decimals for non-zero values below $1 (matches Swift Format.usd). */
  usd(value: number): string {
    const digits = value !== 0 && Math.abs(value) < 1 ? 3 : 2;
    const sign = value < 0 ? "-" : "";
    const text = Math.abs(value).toFixed(digits);
    const [whole = "0", fraction] = text.split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return fraction === undefined ? `${sign}$${grouped}` : `${sign}$${grouped}.${fraction}`;
  },

  /** Compact token count: 1234 -> "1.2K", 2_500_000 -> "2.5M". */
  tokens(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(value);
  },

  /**
   * Abbreviated duration with at most two units: "2d 3h", "1h 30m", "1m".
   * Input is epoch-milliseconds (Swift took seconds; the port takes ms everywhere).
   */
  duration(intervalMs: number): string {
    const seconds = Math.max(intervalMs, 60_000) / 1000;
    if (seconds >= 86400) {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return `${minutes}m`;
  },

  /** "MM/DD HH:mm" in the local time zone. */
  dateTime(dateMs: number): string {
    return localDateTime(dateMs);
  },

  /** Axis label for a chart bucket. */
  bucketLabel(startMs: number, granularity: TimeGranularity): string {
    switch (granularity) {
      case "fiveMinutes":
      case "fifteenMinutes":
      case "hour":
        return localDateTime(startMs);
      case "day":
        return localDate(startMs);
      case "week":
        return `${localDate(startMs)} 起一周`;
    }
  },

  /** The period a bucket covers, e.g. "10/12 14:00 – 14:15". */
  bucketRange(startMs: number, granularity: TimeGranularity): string {
    const endMs = Granularity.bucketEnd(granularity, startMs);
    const endText = isSameLocalDay(endMs, startMs) ? localTime(endMs) : localDateTime(endMs);
    return `${localDateTime(startMs)} – ${endText}`;
  },

  /** Window start label; weekly windows also name their weekday (Swift Format.windowStart). */
  windowStart(startMs: number, kind: QuotaKind): string {
    if (kind === "fiveHour") return localDateTime(startMs);
    const parts = zonedParts(startMs);
    const weekday = WEEKDAY_NAMES[isoWeekday(parts.year, parts.month, parts.day) - 1] ?? "";
    return `${pad2(parts.month)}/${pad2(parts.day)} ${weekday} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
  },

  /** Window end label: time only when it falls on the start's local day. */
  windowEnd(endMs: number, startMs: number, kind: QuotaKind): string {
    if (isSameLocalDay(endMs, startMs)) return localTime(endMs);
    return Format.windowStart(endMs, kind);
  },

  /** Human label for a granularity ("5 分钟" ...), used by the chart picker. */
  granularity(granularity: TimeGranularity): string {
    return granularityLabel(granularity);
  }
};

/** Categorical series colors: the light/dark steps from the Swift SeriesPalette (UI-STYLE). */
const PALETTE_STEPS: Array<{ light: string; dark: string }> = [
  { light: "#2A78D6", dark: "#3987E5" }, // blue
  { light: "#EB6834", dark: "#D95926" }, // orange
  { light: "#1BAF7A", dark: "#199E70" }, // aqua
  { light: "#EDA100", dark: "#C98500" }, // yellow
  { light: "#E87BA4", dark: "#D55181" }, // magenta
  { light: "#008300", dark: "#008300" }, // green
  { light: "#4A3AA7", dark: "#9085E9" }, // violet
  { light: "#E34948", dark: "#E66767" } // red
];

export const SeriesPalette = {
  light: PALETTE_STEPS.map((step) => step.light),
  dark: PALETTE_STEPS.map((step) => step.dark),
  maxSeries: PALETTE_STEPS.length,
  otherName: "其他",
  /**
   * Light-mode css color at `index`; returns "" past the palette / for the "其他" series so
   * the caller can fall back to its tertiary label color (Swift returned otherColor there).
   */
  color(index: number): string {
    return PALETTE_STEPS[index]?.light ?? "";
  },
  /** Tier color for a theme-aware caller; "" for the "其他" series. */
  colorFor(index: number, theme: "light" | "dark"): string {
    const step = PALETTE_STEPS[index];
    if (!step) return "";
    return theme === "dark" ? step.dark : step.light;
  }
};

/** Ordered series names used by the 主会话 / 子代理 chart mode. */
export const SeriesName = {
  main: "主会话",
  subagent: "子代理"
} as const;
