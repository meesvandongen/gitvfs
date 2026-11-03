// Calendar arithmetic shared by the scheduling fields (date ranges, opening hours, recurrence).
//
// Scheduling values are wall-clock ("floating") times: `2026-11-20T19:30` means half past seven at
// the venue, whatever time zone the editor or the server is in. All arithmetic therefore works on
// calendar fields, through day numbers (days since 1970-01-01) and UTC `Date`s, which have no
// daylight saving time. Only `wallClockAt` and `wallClockToDate` meet real instants, and they take
// the time zone explicitly.

const MINUTES_PER_DAY = 24 * 60
const MS_PER_DAY = 86_400_000

/** A parsed `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm[:ss]`: the day number and, for date-times, the time. */
export interface WallClock {
  day: number
  /** Minutes since midnight; absent for a plain date. */
  minutes?: number
  /** Seconds within the minute, kept so `…T10:00:30` round-trips. */
  seconds?: number
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

/** Day number of a calendar date; months are 1-based. Out-of-range days and months roll over. */
export function dayFromCivil(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY)
}

/** Calendar date of a day number. */
export function civilFromDay(day: number): { year: number; month: number; day: number } {
  const date = new Date(day * MS_PER_DAY)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/** ISO weekday index: 0 is Monday, 6 is Sunday. */
export function weekdayOf(day: number): number {
  // 1970-01-01 was a Thursday (index 3).
  return (((day + 3) % 7) + 7) % 7
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Day number of a real `YYYY-MM-DD` date, or `undefined` (`2026-02-30` is not a date). */
export function parseIsoDate(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined
  return dayFromCivil(year, month, day)
}

export function formatIsoDate(day: number): string {
  const civil = civilFromDay(day)
  return `${pad(civil.year, 4)}-${pad(civil.month)}-${pad(civil.day)}`
}

/** Minutes since midnight of `HH:mm`, `00:00` to `24:00`; `undefined` when invalid. */
export function parseTime(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{2}):(\d{2})$/.exec(text)
  if (!match) return undefined
  const [hours, minutes] = [Number(match[1]), Number(match[2])]
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes > 0)) return undefined
  return hours * 60 + minutes
}

export function formatTime(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/** Parse a local `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm[:ss]` (no offset); `undefined` when invalid. */
export function parseWallClock(text: unknown): WallClock | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (!match) return undefined
  const day = parseIsoDate(match[1])
  if (day === undefined) return undefined
  if (match[2] === undefined) return { day }
  const minutes = parseTime(match[2])
  const seconds = match[3] === undefined ? undefined : Number(match[3])
  if (minutes === undefined || minutes >= MINUTES_PER_DAY || (seconds !== undefined && seconds > 59)) return undefined
  return seconds === undefined ? { day, minutes } : { day, minutes, seconds }
}

export function formatWallClock(value: WallClock): string {
  const date = formatIsoDate(value.day)
  if (value.minutes === undefined) return date
  return `${date}T${formatTime(value.minutes)}${value.seconds === undefined ? '' : `:${pad(value.seconds)}`}`
}

/** A sortable number for comparing wall-clock values; a plain date sorts at its midnight. */
export function wallClockOrdinal(value: WallClock): number {
  return (value.day * MINUTES_PER_DAY + (value.minutes ?? 0)) * 60 + (value.seconds ?? 0)
}

/** A UTC `Date` carrying the wall-clock fields, for `Intl.DateTimeFormat` with `timeZone: 'UTC'`. */
export function wallClockAsUtcDate(value: WallClock): Date {
  return new Date(wallClockOrdinal(value) * 1000)
}

const partFormatters = new Map<string, Intl.DateTimeFormat>()

function zonedParts(date: Date, timeZone: string) {
  let format = partFormatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partFormatters.set(timeZone, format)
  }
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(date)) if (part.type !== 'literal') parts[part.type] = Number(part.value)
  return parts
}

/**
 * The wall-clock date and time of an instant: in `timeZone` (an IANA name such as
 * `Europe/Amsterdam`), or in the runtime's own zone when omitted.
 */
export function wallClockAt(date: Date, timeZone?: string): { date: string; time: string; weekday: number; minutes: number } {
  let year: number, month: number, dayOfMonth: number, minutes: number
  if (timeZone) {
    const parts = zonedParts(date, timeZone)
    ;[year, month, dayOfMonth, minutes] = [parts.year, parts.month, parts.day, parts.hour * 60 + parts.minute]
  } else {
    ;[year, month, dayOfMonth, minutes] = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours() * 60 + date.getMinutes()]
  }
  const day = dayFromCivil(year, month, dayOfMonth)
  return { date: formatIsoDate(day), time: formatTime(minutes), weekday: weekdayOf(day), minutes }
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = zonedParts(new Date(instant), timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - Math.floor(instant / 1000) * 1000
}

/**
 * The instant a wall-clock value (`2026-11-20` or `2026-11-20T19:30`) happens in `timeZone`. Times
 * skipped when clocks go forward move forward by the gap (02:30 becomes 03:30); times repeated when
 * clocks go back resolve to the first of the two, as in `Temporal`'s `compatible` mode.
 */
export function wallClockToDate(value: string, timeZone: string): Date {
  const clock = parseWallClock(value)
  if (!clock) throw new RangeError(`Not a local date or date-time: ${value}`)
  const local = wallClockOrdinal(clock) * 1000
  const before = local - zoneOffset(local - MS_PER_DAY, timeZone)
  const after = local - zoneOffset(local + MS_PER_DAY, timeZone)
  const fits = (instant: number) => instant + zoneOffset(instant, timeZone) === local
  const candidates = [before, after].filter(fits).sort((a, b) => a - b)
  // No candidate: the time falls in a gap. Reading it with the offset from before the gap moves it
  // forward by the length of the gap.
  return new Date(candidates[0] ?? before)
}
