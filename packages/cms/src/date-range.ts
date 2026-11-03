import { z } from 'zod'
import type { CmsFieldConfig } from './fields.js'
import { splitFieldConfig } from './field-options.js'
import { formatWallClock, parseWallClock, wallClockAsUtcDate, wallClockOrdinal, type WallClock } from './calendar.js'

// A date range stores `{ start, end }` as ISO 8601 text: `2026-11-20`, or with `time: true` a local
// date-time such as `2026-11-20T19:30`. Local means "at the venue": no offset is stored, so the
// value reads the same in every time zone and in a diff. Both ends are inclusive.

/** `{ start, end }`, as `YYYY-MM-DD` or, for date-time ranges, `YYYY-MM-DDTHH:mm`. */
export interface DateRange {
  start: string
  end: string
}

export interface DateRangeOptions {
  /** Store date-times (`2026-11-20T19:30`) instead of dates. Default: false. */
  time?: boolean
  /**
   * How the length is counted, for `minLength`, `maxLength` and the summary: `days` counts both
   * ends (20–22 Nov is 3 days), `nights` counts the nights in between (2 nights). Default: `days`.
   */
  unit?: 'days' | 'nights'
  /** Shortest allowed range, in `unit`. */
  minLength?: number
  /** Longest allowed range, in `unit`. */
  maxLength?: number
  /** Locale of the summary under the inputs, such as `en-GB`. Default: the browser's. */
  locale?: string
}

export type DateRangeFieldConfig = Omit<CmsFieldConfig, 'fieldType' | 'customData'> & DateRangeOptions

/** Where a date range field keeps its options in AutoForm's `customData`. */
export interface DateRangeCustomData {
  dateRange: DateRangeOptions
}

const OPTION_KEYS = ['time', 'unit', 'minLength', 'maxLength', 'locale'] as const

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Length of a range in `unit`: calendar days counting both ends, or nights in between. */
export function rangeLength(range: DateRange, unit: 'days' | 'nights' = 'days'): number | undefined {
  const start = parseWallClock(range.start)
  const end = parseWallClock(range.end)
  if (!start || !end) return undefined
  const nights = end.day - start.day
  return unit === 'nights' ? nights : nights + 1
}

/**
 * A date range field: `{ start, end }`, with `end` on or after `start`.
 *
 * ```ts
 * stay: dateRange({ label: 'Stay', unit: 'nights', minLength: 2 })
 * session: dateRange({ label: 'Session', time: true }).optional()
 * ```
 */
export function dateRange(config: DateRangeFieldConfig = {}) {
  const { check, options } = splitFieldConfig<DateRangeOptions>(config, OPTION_KEYS, 'daterange', 'dateRange')
  const unit = options.unit ?? 'days'
  const value = z.string().refine(
    (text) => {
      const clock = parseWallClock(text)
      return clock !== undefined && (clock.minutes !== undefined) === Boolean(options.time)
    },
    options.time ? 'Use a date and time like 2026-11-20T19:30' : 'Use a date like 2026-11-20',
  )
  return z
    .object({ start: value, end: value })
    .superRefine((range, context) => {
      const start = parseWallClock(range.start)
      const end = parseWallClock(range.end)
      if (!start || !end) return
      if (wallClockOrdinal(end) < wallClockOrdinal(start)) {
        context.addIssue({ code: 'custom', path: ['end'], message: 'The end is before the start' })
        return
      }
      const length = rangeLength(range, unit)!
      if (options.minLength !== undefined && length < options.minLength) {
        context.addIssue({ code: 'custom', path: ['end'], message: `Choose at least ${plural(options.minLength, unit.slice(0, -1))}` })
      }
      if (options.maxLength !== undefined && length > options.maxLength) {
        context.addIssue({ code: 'custom', path: ['end'], message: `Choose at most ${plural(options.maxLength, unit.slice(0, -1))}` })
      }
    })
    .check(check)
}

/**
 * The range in words, with shared parts said once: `20–22 Nov 2026`, `30 Nov – 2 Dec 2026`,
 * `20 Nov 2026, 19:30–22:00`. Uses `Intl.DateTimeFormat#formatRange` in `locale`.
 */
export function formatDateRange(range: DateRange, locale?: string): string {
  const start = parseWallClock(range.start)
  const end = parseWallClock(range.end)
  if (!start || !end) return ''
  const withTime = start.minutes !== undefined
  const format = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  })
  const [from, to] = [wallClockAsUtcDate(start), wallClockAsUtcDate(end)]
  if (wallClockOrdinal(end) <= wallClockOrdinal(start)) return format.format(from)
  return format.formatRange(from, to)
}

/** The length in words: `3 days`, `2 nights`, or for date-times `2 h 30 min` / `3 days`. */
export function describeRangeLength(range: DateRange, unit: 'days' | 'nights' = 'days'): string {
  const start = parseWallClock(range.start)
  const end = parseWallClock(range.end)
  if (!start || !end || wallClockOrdinal(end) < wallClockOrdinal(start)) return ''
  if (start.minutes !== undefined && end.day === start.day) return formatDuration(end, start)
  if (start.minutes !== undefined && unit === 'days') {
    // A date-time range over several days: count started days, like a multi-day festival.
    return plural(end.day - start.day + 1, 'day')
  }
  return plural(rangeLength(range, unit)!, unit.slice(0, -1))
}

function formatDuration(end: WallClock, start: WallClock): string {
  const minutes = Math.round((wallClockOrdinal(end) - wallClockOrdinal(start)) / 60)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/**
 * Move the start of a range and keep its length, as calendar apps do: moving a 3-day stay by a week
 * moves its end too. A range without a valid end only gets the new start.
 */
export function moveRangeStart(range: Partial<DateRange>, start: string): Partial<DateRange> {
  const before = parseWallClock(range.start)
  const after = parseWallClock(start)
  const end = parseWallClock(range.end)
  if (!before || !after || !end || wallClockOrdinal(end) < wallClockOrdinal(before)) return { ...range, start }
  const seconds = wallClockOrdinal(end) + wallClockOrdinal(after) - wallClockOrdinal(before)
  const day = Math.floor(seconds / 86_400)
  const moved: WallClock =
    end.minutes === undefined ? { day } : { day, minutes: Math.floor((seconds % 86_400) / 60), seconds: end.seconds === undefined ? undefined : seconds % 60 }
  return { start, end: formatWallClock(moved) }
}

/** Whether `value` is a `{ start, end }` with readable dates (not necessarily in order). */
export function isDateRange(value: unknown): value is DateRange {
  return (
    typeof value === 'object' &&
    value !== null &&
    parseWallClock((value as DateRange).start) !== undefined &&
    parseWallClock((value as DateRange).end) !== undefined
  )
}
