// Internal date helpers shared by aggregation (time buckets) and quota (limit-message
// reset times). All timestamps are epoch milliseconds; all functions are pure.
//
// This mirrors the parts of Foundation's Calendar/TimeZone that the Swift code relied on
// (Calendar.current, calendar.dateInterval(of:), calendar.nextDate(after:matching:)).
// The optional IANA `timeZone` argument corresponds to overriding Calendar.timeZone; when
// omitted the host's local time zone is used, exactly like Calendar.current.

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const validZoneCache = new Map<string, boolean>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when the string is an IANA time zone identifier the runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === "") return false;
  const cached = validZoneCache.get(timeZone);
  if (cached !== undefined) return cached;
  let valid = true;
  try {
    formatterFor(timeZone).format(0);
  } catch {
    valid = false;
    formatterCache.delete(timeZone);
  }
  validZoneCache.set(timeZone, valid);
  return valid;
}

/** Calendar components of `ms` in the given zone (host local zone when omitted). */
export function zonedParts(ms: number, timeZone?: string): ZonedParts {
  if (!timeZone) {
    const date = new Date(ms);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds()
    };
  }
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values["year"] ?? 1970,
    month: values["month"] ?? 1,
    day: values["day"] ?? 1,
    // Some ICU versions still emit hour 24 for midnight despite hourCycle h23.
    hour: (values["hour"] ?? 0) % 24,
    minute: values["minute"] ?? 0,
    second: values["second"] ?? 0
  };
}

/** Offset (local - UTC) of the given zone at `ms`, in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - ms;
}

/**
 * Epoch milliseconds of the given wall-clock time in `timeZone` (host local when omitted).
 * Ambiguous / non-existent wall-clock times are resolved the way a JS Date constructor would:
 * the result may round to an adjacent real instant across a DST edge.
 */
export function zonedEpoch(parts: ZonedParts, timeZone?: string): number {
  const { year, month, day, hour, minute, second } = parts;
  if (!timeZone) {
    return new Date(year, month - 1, day, hour, minute, second).getTime();
  }
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = zoneOffsetMs(utcGuess, timeZone);
  let result = utcGuess - offset;
  const offset2 = zoneOffsetMs(result, timeZone);
  if (offset2 !== offset) result = utcGuess - offset2;
  return result;
}

/** Epoch ms of local midnight of the day containing `ms`. */
export function startOfDay(ms: number, timeZone?: string): number {
  const parts = zonedParts(ms, timeZone);
  return zonedEpoch({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Adds whole civil days (calendar days), keeping the wall-clock time of day. */
export function addDays(ms: number, days: number, timeZone?: string): number {
  const parts = zonedParts(ms, timeZone);
  const civil = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86400000);
  return zonedEpoch(
    {
      year: civil.getUTCFullYear(),
      month: civil.getUTCMonth() + 1,
      day: civil.getUTCDate(),
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second
    },
    timeZone
  );
}

/** ISO weekday of a civil date: 1 = Monday ... 7 = Sunday (like JS getUTCDay re-based). */
export function isoWeekday(year: number, month: number, day: number): number {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return weekday === 0 ? 7 : weekday;
}

/** Earliest epoch ms strictly after `afterMs` matching the given wall-clock constraints. */
export function nextDateMatching(
  afterMs: number,
  /** `weekday` uses Foundation numbering: 1 = Sunday ... 7 = Saturday. */
  match: { hour: number; minute: number; second?: number; weekday?: number; month?: number; day?: number },
  timeZone?: string
): number | undefined {
  const start = zonedParts(afterMs, timeZone);
  // Search forward civil-day by civil-day; 10 years is enough for any month/day pattern
  // (Feb 29 occurs at least every 4 years) and costs ~3700 cheap comparisons in the worst case.
  for (let delta = 0; delta <= 3660; delta += 1) {
    const civil = new Date(Date.UTC(start.year, start.month - 1, start.day) + delta * 86400000);
    const year = civil.getUTCFullYear();
    const month = civil.getUTCMonth() + 1;
    const day = civil.getUTCDate();
    if (match.month !== undefined && month !== match.month) continue;
    if (match.day !== undefined && day !== match.day) continue;
    // Foundation weekday numbers: 1 = Sunday ... 7 = Saturday.
    if (match.weekday !== undefined && new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1 !== match.weekday) continue;
    const candidate = zonedEpoch(
      { year, month, day, hour: match.hour, minute: match.minute, second: match.second ?? 0 },
      timeZone
    );
    if (candidate > afterMs) return candidate;
  }
  return undefined;
}

/** True when both instants fall on the same local calendar day. */
export function isSameLocalDay(a: number, b: number, timeZone?: string): boolean {
  const pa = zonedParts(a, timeZone);
  const pb = zonedParts(b, timeZone);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/** Expands a leading "~" like Foundation's NSString.expandingTildeInPath (home dir only). */
export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return home + path.slice(1);
  return path;
}
