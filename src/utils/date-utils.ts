import { DateTime } from "luxon";
import type { OperatingHours, BlackoutWindow, WorkSegment } from "../reflow/types.js";


const MAX_LOOKAHEAD_DAYS = 366;
const MAX_ITERATIONS = 100_000;
const EPSILON_MIN = 1e-6;

export function parseUTC(iso: string): DateTime {
  return DateTime.fromISO(iso, { zone: "utc" });
}

export function toISO(dt: DateTime): string {
  return dt.toUTC().toISO({ suppressMilliseconds: true }) ?? "";
}

export function minutesBetween(a: DateTime, b: DateTime): number {
  return b.diff(a, "minutes").minutes;
}

function min(a: DateTime, b: DateTime): DateTime {
  return a <= b ? a : b;
}


export function intervalsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  const as = parseUTC(aStart);
  const ae = parseUTC(aEnd);
  const bs = parseUTC(bStart);
  const be = parseUTC(bEnd);
  return as < be && bs < ae;
}

export function overlapMinutes(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): number {
  const start = DateTime.max(parseUTC(aStart), parseUTC(bStart));
  const end = DateTime.min(parseUTC(aEnd), parseUTC(bEnd));
  const m = minutesBetween(start, end);
  return m > 0 ? m : 0;
}

function specDayOfWeek(dt: DateTime): number {
  return dt.weekday % 7;
}

function windowBounds(dt: DateTime, oh: OperatingHours): { start: DateTime; end: DateTime } {
  const day = dt.startOf("day");
  return {
    start: day.plus({ hours: oh.startHour }),
    end: day.plus({ hours: oh.endHour }),
  };
}

function windowsForDay(dt: DateTime, hours: OperatingHours[]): Array<{ start: DateTime; end: DateTime }> {
  const dow = specDayOfWeek(dt);
  return hours
    .filter((oh) => oh.dayOfWeek === dow && oh.endHour > oh.startHour)
    .map((oh) => windowBounds(dt, oh))
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

export function isWithinOperatingHours(dt: DateTime, hours: OperatingHours[]): boolean {
  return windowsForDay(dt, hours).some((w) => dt >= w.start && dt < w.end);
}

function currentWindowEnd(dt: DateTime, hours: OperatingHours[]): DateTime {
  const w = windowsForDay(dt, hours).find((w) => dt >= w.start && dt < w.end);
  if (!w) throw new Error(`No operating window contains ${toISO(dt)}`);
  return w.end;
}

function nextOperatingOpen(dt: DateTime, hours: OperatingHours[]): DateTime | null {
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset++) {
    const day = dt.plus({ days: offset });
    for (const w of windowsForDay(day, hours)) {
      if (w.end <= dt) continue;
      return w.start > dt ? w.start : dt;
    }
  }
  return null;
}

function isOperatingEnd(end: DateTime, hours: OperatingHours[]): boolean {
  return windowsForDay(end, hours).some((w) => w.start < end && end <= w.end);
}

function previousOperatingClose(t: DateTime, hours: OperatingHours[]): DateTime | null {
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset++) {
    const closed = windowsForDay(t.minus({ days: offset }), hours).filter((w) => w.end <= t);
    if (closed.length > 0) return closed[closed.length - 1]!.end; // sorted by start
  }
  return null;
}

function nextOperatingOpenAt(t: DateTime, hours: OperatingHours[]): DateTime | null {
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset++) {
    for (const w of windowsForDay(t.plus({ days: offset }), hours)) {
      if (w.start >= t) return w.start;
    }
  }
  return null;
}

export function pushEndPastClosures(endISO: string, hours: OperatingHours[]): string {
  if (hours.length === 0) return endISO;
  let end = parseUTC(endISO);
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (isOperatingEnd(end, hours)) break;
    const closeStart = previousOperatingClose(end, hours);
    const reopen = nextOperatingOpenAt(end, hours);
    if (!closeStart || !reopen) break;
    const spill = minutesBetween(closeStart, end);
    end = reopen.plus({ minutes: spill });
  }
  return toISO(end);
}

function blackoutContaining(dt: DateTime, blackouts: BlackoutWindow[]): BlackoutWindow | undefined {
  return blackouts.find((b) => dt >= parseUTC(b.startDate) && dt < parseUTC(b.endDate));
}

export function isInBlackout(dt: DateTime, blackouts: BlackoutWindow[]): boolean {
  return blackoutContaining(dt, blackouts) !== undefined;
}

function nextBlackoutStartAfter(dt: DateTime, blackouts: BlackoutWindow[]): DateTime | null {
  let best: DateTime | null = null;
  for (const b of blackouts) {
    const s = parseUTC(b.startDate);
    if (s > dt && (best === null || s < best)) best = s;
  }
  return best;
}


export function pushEndPastBlackouts(
  startISO: string,
  endISO: string,
  blackouts: BlackoutWindow[],
): string {
  if (blackouts.length === 0) return endISO;
  const start = parseUTC(startISO);
  const baseMinutes = minutesBetween(start, parseUTC(endISO));
  let end = parseUTC(endISO);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const endISONow = toISO(end);
    let blocked = 0;
    for (const b of blackouts) {
      blocked += overlapMinutes(startISO, endISONow, b.startDate, b.endDate);
    }
    const newEnd = start.plus({ minutes: baseMinutes + blocked });
    if (newEnd.toMillis() === end.toMillis()) break;
    end = newEnd;
  }
  return toISO(end);
}

function tryNextWorkingInstant(
  dt: DateTime,
  hours: OperatingHours[],
  blackouts: BlackoutWindow[],
): DateTime | null {
  let cur = dt;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const bo = blackoutContaining(cur, blackouts);
    if (bo) {
      cur = parseUTC(bo.endDate);
      continue;
    }
    if (!isWithinOperatingHours(cur, hours)) {
      const open = nextOperatingOpen(cur, hours);
      if (open === null) return null;
      cur = open;
      continue;
    }
    return cur;
  }
  return null;
}

export function computeWorkSegments(
  startDate: string,
  durationMinutes: number,
  hours: OperatingHours[],
  blackouts: BlackoutWindow[] = [],
): { segments: WorkSegment[]; end: string } {
  const begin = tryNextWorkingInstant(parseUTC(startDate), hours, blackouts);
  if (begin === null) {
    throw new Error(
      `No operating window available within ${MAX_LOOKAHEAD_DAYS} days from ${startDate}`,
    );
  }

  if (durationMinutes <= EPSILON_MIN) {
    return { segments: [], end: toISO(begin) };
  }

  const segments: WorkSegment[] = [];
  let cur = begin;
  let remaining = durationMinutes;
  let guard = 0;

  while (remaining > EPSILON_MIN) {
    if (++guard > MAX_ITERATIONS) {
      throw new Error(`Scheduling did not converge for start ${startDate}`);
    }

    cur = tryNextWorkingInstant(cur, hours, blackouts)!; 
    let blockEnd = currentWindowEnd(cur, hours);
    const nextBo = nextBlackoutStartAfter(cur, blackouts);
    if (nextBo && nextBo < blockEnd) blockEnd = nextBo;

    const available = minutesBetween(cur, blockEnd);
    const take = Math.min(available, remaining);
    const segEnd = cur.plus({ minutes: take });

    segments.push({ start: toISO(cur), end: toISO(segEnd), minutes: take });
    remaining -= take;
    cur = segEnd;
  }

  return { segments, end: segments[segments.length - 1]!.end };
}

export function calculateEndDateWithOperatingHours(
  startDate: string,
  durationMinutes: number,
  hours: OperatingHours[],
  blackouts: BlackoutWindow[] = [],
): string {
  return computeWorkSegments(startDate, durationMinutes, hours, blackouts).end;
}

export function operatingMinutesBetween(
  start: string,
  end: string,
  hours: OperatingHours[],
  blackouts: BlackoutWindow[] = [],
): number {
  const limit = parseUTC(end);
  let cur = parseUTC(start);
  let total = 0;
  let guard = 0;

  while (cur < limit) {
    if (++guard > MAX_ITERATIONS) break;
    const next = tryNextWorkingInstant(cur, hours, blackouts);
    if (next === null || next >= limit) break;
    cur = next;

    let blockEnd = currentWindowEnd(cur, hours);
    const nextBo = nextBlackoutStartAfter(cur, blackouts);
    if (nextBo && nextBo < blockEnd) blockEnd = nextBo;
    blockEnd = min(blockEnd, limit);

    total += minutesBetween(cur, blockEnd);
    cur = blockEnd;
  }

  return total;
}
