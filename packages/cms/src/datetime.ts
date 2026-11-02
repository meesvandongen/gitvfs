import { z } from 'zod'
import { fieldWithOptions, type FieldOptions } from './field-options.js'

// Date and time fields store ISO 8601 strings, not Date objects. The `yaml` package (YAML 1.2 core
// schema) and JSON both read them back as the same strings, so a value survives frontmatter, YAML
// and JSON unchanged, offset included. A Date would be rewritten as UTC on every save.

/**
 * How a date and time field stores its moment:
 * - `'local'` (default): with the editor's UTC offset at that date, `2026-11-20T19:30:00+01:00`.
 * - `'UTC'`: in UTC, `2026-11-20T18:30:00Z`.
 * - an IANA time zone such as `'Europe/Amsterdam'`: entered as clock time there, whatever the
 *   editor's own zone, and stored with that zone's offset at that date.
 * - `'floating'`: clock time without a zone, `2026-11-20T19:30:00`, such as "doors open at 19:30"
 *   wherever the venue is.
 */
export type DateTimeZone = 'local' | 'floating' | 'UTC' | (string & {})

export interface DateTimeOptions {
  /** Time zone handling. Default: `'local'`. */
  timeZone?: DateTimeZone
  /** Picker granularity in seconds, as on `<input>`. Default: 60. Values always include seconds. */
  step?: number
}

export interface TimeOptions {
  /** Picker granularity in seconds. Below a minute (or not a whole number of minutes), values get seconds: `19:30:15`. Default: 60. */
  step?: number
  /** Earliest allowed time, such as `'09:00'`. */
  min?: string
  /** Latest allowed time, such as `'17:30'`. */
  max?: string
}

/** Where date and time fields keep their options in AutoForm's `customData`. */
export interface DateTimeCustomData {
  datetime?: DateTimeOptions
  time?: TimeOptions
}

/** The parts of an ISO 8601 date and time. `offset` is in minutes east of UTC; absent for clock times. */
export interface DateTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  offset?: number
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/

const pad = (value: number, length = 2) => String(Math.abs(value)).padStart(length, '0')

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/**
 * Read `2026-11-20T19:30:00+01:00`, `…Z`, or a clock time without offset (seconds and fractions
 * optional). Returns `undefined` for anything else, including impossible dates.
 */
export function parseDateTime(value: string): DateTimeParts | undefined {
  const match = DATE_TIME.exec(value)
  if (!match) return undefined
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number)
  const second = match[6] === undefined ? 0 : Number(match[6])
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return undefined
  const parts: DateTimeParts = { year, month, day, hour, minute, second }
  const zone = match[7]
  if (zone === 'Z') parts.offset = 0
  else if (zone) {
    const [hours, minutes] = zone.slice(1).split(':').map(Number)
    if (hours > 23 || minutes > 59) return undefined
    parts.offset = (zone[0] === '-' ? -1 : 1) * (hours * 60 + minutes)
  }
  return parts
}

/** Whether `value` is a date and time in the format `timeZone` stores: with an offset, or without for `'floating'`. */
export function isDateTime(value: unknown, timeZone: DateTimeZone = 'local'): value is string {
  const parts = typeof value === 'string' ? parseDateTime(value) : undefined
  return parts !== undefined && (timeZone === 'floating') === (parts.offset === undefined)
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** Offset of `timeZone` from UTC at `instant` (milliseconds), in minutes east of UTC. `'floating'` uses the local zone. */
export function timeZoneOffset(timeZone: DateTimeZone, instant: number): number {
  if (timeZone === 'UTC') return 0
  if (timeZone === 'local' || timeZone === 'floating') return -new Date(instant).getTimezoneOffset()
  const parts = Object.fromEntries(
    zoneFormatter(timeZone).formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]),
  )
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000)
}

function wallClock(instant: number, timeZone: DateTimeZone): DateTimeParts {
  const shifted = new Date(instant + timeZoneOffset(timeZone, instant) * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}

/** `+01:00`, `-05:30`. */
export function formatOffset(minutes: number): string {
  return `${minutes < 0 ? '-' : '+'}${pad(Math.trunc(minutes / 60))}:${pad(minutes % 60)}`
}

function formatParts(parts: DateTimeParts, seconds = true): string {
  const date = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`
  return `${date}T${pad(parts.hour)}:${pad(parts.minute)}${seconds ? `:${pad(parts.second)}` : ''}`
}

/** Format a moment as `timeZone` stores it, such as `2026-11-20T19:30:00+01:00`. */
export function formatDateTime(instant: Date | number, timeZone: DateTimeZone = 'local'): string {
  const time = Math.floor(Number(instant) / 1000) * 1000
  const wall = formatParts(wallClock(time, timeZone))
  if (timeZone === 'floating') return wall
  if (timeZone === 'UTC') return `${wall}Z`
  return `${wall}${formatOffset(timeZoneOffset(timeZone, time))}`
}

/**
 * The value for `<input type="datetime-local">`: the stored moment as clock time in `timeZone`.
 * Values without an offset (and date-only values) are shown as written.
 */
export function toWallClock(value: unknown, timeZone: DateTimeZone = 'local', seconds = false): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : formatParts(wallClock(value.getTime(), timeZone), seconds)
  if (typeof value !== 'string') return ''
  const dateOnly = DATE_ONLY.exec(value)
  if (dateOnly) return `${value}T00:00${seconds ? ':00' : ''}`
  const parts = parseDateTime(value)
  if (!parts) return ''
  if (parts.offset === undefined || timeZone === 'floating') return formatParts(parts, seconds)
  const instant = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - parts.offset * 60_000
  return formatParts(wallClock(instant, timeZone), seconds)
}

/** Store clock time from `<input type="datetime-local">` (`2026-11-20T19:30`) as `timeZone` does. */
export function fromWallClock(wall: string, timeZone: DateTimeZone = 'local'): string | undefined {
  const parts = parseDateTime(wall)
  if (!parts || parts.offset !== undefined) return undefined
  if (timeZone === 'floating') return formatParts(parts)
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  // The offset depends on the moment it is looked up for; a second lookup settles it around DST changes.
  let offset = timeZoneOffset(timeZone, utc)
  offset = timeZoneOffset(timeZone, utc - offset * 60_000)
  return formatDateTime(utc - offset * 60_000, timeZone)
}

/** Whether `value` is a time of day: `19:30` or `19:30:15`. */
export function isTime(value: unknown): value is string {
  return typeof value === 'string' && TIME.test(value)
}

/** Normalize a time (`19:30`, `19:30:00`) to `HH:MM`, or `HH:MM:SS` with `seconds`. */
export function formatTime(value: string, seconds = false): string | undefined {
  const match = TIME.exec(value)
  if (!match) return undefined
  return `${match[1]}:${match[2]}${seconds ? `:${match[3] ?? '00'}` : ''}`
}

/** Whether a time `step` (in seconds) needs seconds in the value. */
export function stepHasSeconds(step: number | undefined): boolean {
  return step !== undefined && step % 60 !== 0
}

const EXAMPLES: Record<string, string> = {
  floating: '2026-11-20T19:30:00',
  UTC: '2026-11-20T18:30:00Z',
}

/**
 * A date and time, stored as an ISO 8601 string: `2026-11-20T19:30:00+01:00` by default. See
 * `DateTimeZone` for the `timeZone` option.
 *
 * ```ts
 * starts: datetime({ label: 'Starts', timeZone: 'Europe/Amsterdam' })
 * ```
 */
export function datetime(config: FieldOptions<DateTimeOptions> = {}) {
  const timeZone = config.timeZone ?? 'local'
  // Fail at definition time on a misspelled zone, instead of in the editor.
  if (!['local', 'floating', 'UTC'].includes(timeZone)) zoneFormatter(timeZone)
  const example = EXAMPLES[timeZone] ?? '2026-11-20T19:30:00+01:00'
  return z
    .string()
    .refine((value) => isDateTime(value, timeZone), `Use a date and time like ${example}`)
    .check(fieldWithOptions(config, ['timeZone', 'step'], 'datetime'))
}

/**
 * A time of day, stored as `HH:MM` (`19:30`), or `HH:MM:SS` when `step` is below a minute.
 *
 * ```ts
 * doors: time({ label: 'Doors open', step: 900, min: '12:00' })
 * ```
 */
export function time(config: FieldOptions<TimeOptions> = {}) {
  let schema = z.string().regex(TIME, 'Use a time like 19:30')
  // Zero-padded times sort as text.
  if (config.min !== undefined) schema = schema.refine((value) => value >= config.min!, `Use ${config.min} or later`)
  if (config.max !== undefined) schema = schema.refine((value) => value <= config.max!, `Use ${config.max} or earlier`)
  return schema.check(fieldWithOptions(config, ['step', 'min', 'max'], 'time'))
}
