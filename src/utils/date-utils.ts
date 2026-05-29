import { DateTime } from "luxon";

/** Returns the current timestamp as an ISO 8601 string. */
export function nowISO(): string {
  return DateTime.now().toISO() ?? "";
}

/** Parses an ISO 8601 string into a Luxon DateTime. */
export function parseISO(iso: string): DateTime {
  return DateTime.fromISO(iso);
}

/** Formats a DateTime using a Luxon format token string. */
export function format(dt: DateTime, fmt: string): string {
  return dt.toFormat(fmt);
}
