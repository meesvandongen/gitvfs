import { z } from 'zod'
import type { CmsFieldConfig } from './fields.js'
import { splitFieldConfig } from './field-options.js'
import { civilFromDay, formatIsoDate, parseIsoDate, parseTime, wallClockAt, weekdayOf } from './calendar.js'

// Opening hours are stored as a week of intervals plus dated exceptions:
//
//   mon: [{ opens: '09:00', closes: '12:30' }, { opens: '13:30', closes: '17:30' }]
//   sun: []                                   # closed
//   fri: [{ opens: '18:00', closes: '02:00' }] # past midnight: closes on Saturday
//   exceptions: [{ date: '2026-12-25', label: 'Christmas', hours: [] }]
//
// The shape follows schema.org's OpeningHoursSpecification and Google Business Profile hours (an
// interval belongs to the day it opens, a closing time at or before the opening time is on the next
// day, 24:00 is the end of the day), but keyed by day so a week reads top to bottom in YAML. The
// OpenStreetMap `opening_hours` syntax is compact but needs a parser to read; `toOsmOpeningHours`
// writes it. Times are local wall-clock times of the place: no time zone is stored.

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

/** The weekday keys in order, Monday first (ISO 8601). */
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}

/**
 * Open from `opens` to `closes`, as `HH:mm`. A `closes` at or before `opens` is on the next day
 * (`18:00`–`02:00`); `00:00`–`00:00` is open around the clock, and `24:00` is the end of the day.
 */
export interface OpeningInterval {
  opens: string
  closes: string
}

/** Different hours on a date, or from `date` through `until`. `hours: []` means closed. */
export interface OpeningHoursException {
  date: string
  until?: string
  label?: string
  hours: OpeningInterval[]
}

/** A week of opening hours. A missing or empty day is closed. */
export type OpeningHours = { [day in Weekday]?: OpeningInterval[] } & { exceptions?: OpeningHoursException[] }

export interface OpeningHoursOptions {
  /** Allow intervals past midnight (`22:00`–`03:00`). Default: true. */
  overnight?: boolean
  /** Show the editor for special dates and holidays. Default: true. */
  exceptions?: boolean
  /** Hours given to a day that is opened in the editor. Default: `09:00`–`17:00`. */
  defaultInterval?: OpeningInterval
}

export type OpeningHoursFieldConfig = Omit<CmsFieldConfig, 'fieldType' | 'customData'> & OpeningHoursOptions

/** Where an opening hours field keeps its options in AutoForm's `customData`. */
export interface OpeningHoursCustomData {
  openingHours: OpeningHoursOptions
}

const OPTION_KEYS = ['overnight', 'exceptions', 'defaultInterval'] as const
const DAY = 24 * 60

/** Start and end of an interval in minutes from the midnight it opens after; the end can pass 1440. */
export function intervalMinutes(interval: OpeningInterval): [number, number] | undefined {
  const opens = parseTime(interval.opens)
  const closes = parseTime(interval.closes)
  if (opens === undefined || closes === undefined || opens === DAY) return undefined
  return [opens, closes <= opens ? closes + DAY : closes]
}

/** Whether an interval closes after midnight (a closing time of exactly midnight does not count). */
export function isOvernight(interval: OpeningInterval): boolean {
  const minutes = intervalMinutes(interval)
  return minutes !== undefined && minutes[1] > DAY
}

const label = (interval: OpeningInterval) => `${interval.opens}–${interval.closes}`

export interface OpeningHoursIssue {
  path: Array<string | number>
  message: string
}

function intervalIssues(
  intervals: readonly OpeningInterval[],
  name: string,
  path: Array<string | number>,
  overnight: boolean,
): OpeningHoursIssue[] {
  const issues: OpeningHoursIssue[] = []
  const valid: Array<{ index: number; start: number; end: number }> = []
  intervals.forEach((interval, index) => {
    const minutes = intervalMinutes(interval)
    if (!minutes) return
    if (!overnight && minutes[1] > DAY) {
      issues.push({ path: [...path, index, 'closes'], message: `${name}: ${label(interval)} closes before it opens` })
      return
    }
    valid.push({ index, start: minutes[0], end: minutes[1] })
  })
  valid.sort((a, b) => a.start - b.start)
  for (let at = 1; at < valid.length; at++) {
    const [previous, current] = [valid[at - 1], valid[at]]
    if (current.start < previous.end) {
      issues.push({
        path: [...path, current.index, 'opens'],
        message: `${name}: ${label(intervals[current.index])} overlaps ${label(intervals[previous.index])}`,
      })
    }
  }
  return issues
}

/**
 * Problems with opening hours, for validation: closing before opening (when `overnight` is off),
 * overlapping intervals (also an overnight interval running into the next day's hours), special
 * dates that end before they start or overlap each other.
 */
export function openingHoursIssues(hours: OpeningHours, options: { overnight?: boolean } = {}): OpeningHoursIssue[] {
  const overnight = options.overnight ?? true
  const issues: OpeningHoursIssue[] = []
  WEEKDAYS.forEach((day, index) => {
    const intervals = hours[day] ?? []
    issues.push(...intervalIssues(intervals, WEEKDAY_NAMES[day], [day], overnight))
    // Hours past midnight must end before the next day opens.
    const next = WEEKDAYS[(index + 1) % 7]
    for (const interval of intervals) {
      const minutes = intervalMinutes(interval)
      if (!overnight || !minutes || minutes[1] <= DAY) continue
      ;(hours[next] ?? []).forEach((later, laterIndex) => {
        const start = intervalMinutes(later)?.[0]
        if (start !== undefined && start < minutes[1] - DAY) {
          issues.push({
            path: [next, laterIndex, 'opens'],
            message: `${WEEKDAY_NAMES[next]}: ${label(later)} starts before ${WEEKDAY_NAMES[day]}'s ${label(interval)} ends`,
          })
        }
      })
    }
  })

  const ranges: Array<{ index: number; from: number; to: number }> = []
  ;(hours.exceptions ?? []).forEach((exception, index) => {
    const from = parseIsoDate(exception.date)
    const to = exception.until === undefined ? from : parseIsoDate(exception.until)
    const name = exception.label || exception.date
    if (from !== undefined && to !== undefined) {
      if (to < from) issues.push({ path: ['exceptions', index, 'until'], message: `${name}: the last day is before the first` })
      else ranges.push({ index, from, to })
    }
    issues.push(...intervalIssues(exception.hours ?? [], name, ['exceptions', index, 'hours'], overnight))
  })
  ranges.sort((a, b) => a.from - b.from)
  for (let at = 1; at < ranges.length; at++) {
    if (ranges[at].from <= ranges[at - 1].to) {
      const [first, second] = [hours.exceptions![ranges[at - 1].index], hours.exceptions![ranges[at].index]]
      issues.push({
        path: ['exceptions', ranges[at].index, 'date'],
        message: `Special dates overlap: ${first.label || first.date} and ${second.label || second.date}`,
      })
    }
  }
  return issues
}

// 24:00 ends a day but cannot start one.
const timeSchema = (latest: number) =>
  z.string().refine((text) => (parseTime(text) ?? Infinity) <= latest, 'Use a 24-hour time like 09:00')
const dateSchema = () => z.string().refine((text) => parseIsoDate(text) !== undefined, 'Use a date like 2026-12-25')

/**
 * Weekly opening hours with optional special dates (holidays, events).
 *
 * ```ts
 * hours: openingHours({ label: 'Opening hours' }).optional()
 * ```
 */
export function openingHours(config: OpeningHoursFieldConfig = {}) {
  const { check, options } = splitFieldConfig<OpeningHoursOptions>(config, OPTION_KEYS, 'openinghours', 'openingHours')
  const interval = z.object({ opens: timeSchema(DAY - 1), closes: timeSchema(DAY) })
  const days = Object.fromEntries(WEEKDAYS.map((day) => [day, z.array(interval).optional()])) as Record<
    Weekday,
    z.ZodOptional<z.ZodArray<typeof interval>>
  >
  const exception = z.object({
    date: dateSchema(),
    until: dateSchema().optional(),
    label: z.string().optional(),
    hours: z.array(interval),
  })
  return z
    .object({ ...days, exceptions: z.array(exception).optional() })
    .superRefine((hours, context) => {
      for (const issue of openingHoursIssues(hours, options)) context.addIssue({ code: 'custom', ...issue })
    })
    .check(check)
}

/** The exception that applies on `day` (a day number), if any. */
function exceptionOn(hours: OpeningHours, day: number): OpeningHoursException | undefined {
  return hours.exceptions?.find((exception) => {
    const from = parseIsoDate(exception.date)
    const to = exception.until === undefined ? from : parseIsoDate(exception.until)
    return from !== undefined && to !== undefined && from <= day && day <= to
  })
}

/** The hours that open on `date` (`YYYY-MM-DD`): a matching exception's, or the weekday's. */
export function hoursOn(hours: OpeningHours, date: string): OpeningInterval[] {
  const day = parseIsoDate(date)
  if (day === undefined) throw new RangeError(`Not a date: ${date}`)
  return exceptionOn(hours, day)?.hours ?? hours[WEEKDAYS[weekdayOf(day)]] ?? []
}

/**
 * Whether the place is open at an instant. Hours are wall-clock times of the place, so pass its
 * `timeZone` (such as `Europe/Amsterdam`) unless the code runs in that zone. Daylight saving time
 * needs no special care: a bar open 22:00–04:00 closes at 04:00 local time, even on the night the
 * clocks change. Hours past midnight belong to the day they open, so a Friday 22:00–03:00 is
 * still open at 01:00 on a Saturday that is closed as a special date.
 */
export function isOpenAt(hours: OpeningHours, date: Date, options: { timeZone?: string } = {}): boolean {
  const now = wallClockAt(date, options.timeZone)
  const day = parseIsoDate(now.date)!
  const today = hoursOn(hours, now.date)
  const yesterday = hoursOn(hours, formatIsoDate(day - 1))
  return (
    today.some((interval) => {
      const minutes = intervalMinutes(interval)
      return minutes !== undefined && minutes[0] <= now.minutes && now.minutes < minutes[1]
    }) ||
    yesterday.some((interval) => {
      const minutes = intervalMinutes(interval)
      return minutes !== undefined && now.minutes < minutes[1] - DAY
    })
  )
}

/** A schema.org `OpeningHoursSpecification`, as used in JSON-LD. */
export interface OpeningHoursSpecification {
  '@type': 'OpeningHoursSpecification'
  dayOfWeek?: string[]
  opens: string
  closes: string
  validFrom?: string
  validThrough?: string
}

// Google reads `00:00`–`00:00` as closed all day, and asks for `23:59` as the end of a day.
const schemaClose = (interval: OpeningInterval) =>
  interval.closes === '24:00' || (interval.closes === '00:00' && !isOvernight(interval)) ? '23:59' : interval.closes

/**
 * Convert to schema.org `OpeningHoursSpecification`s for a site's structured data (JSON-LD), in the
 * form Google's local business guidelines describe: days with the same hours share an entry,
 * special dates get `validFrom` / `validThrough`, and a closed special date is `00:00`–`00:00`.
 * Pass `from` (`YYYY-MM-DD`) to leave out special dates that ended before it.
 */
export function toOpeningHoursSpecification(hours: OpeningHours, options: { from?: string } = {}): OpeningHoursSpecification[] {
  const groups = new Map<string, { interval: OpeningInterval; days: Weekday[] }>()
  for (const day of WEEKDAYS) {
    for (const interval of hours[day] ?? []) {
      const key = `${interval.opens}-${interval.closes}`
      const group = groups.get(key) ?? { interval, days: [] }
      group.days.push(day)
      groups.set(key, group)
    }
  }
  const weekly = [...groups.values()]
    .sort((a, b) => WEEKDAYS.indexOf(a.days[0]) - WEEKDAYS.indexOf(b.days[0]) || a.interval.opens.localeCompare(b.interval.opens))
    .map(({ interval, days }): OpeningHoursSpecification => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: days.map((day) => WEEKDAY_NAMES[day]),
      opens: interval.opens,
      closes: schemaClose(interval),
    }))

  const from = options.from === undefined ? undefined : parseIsoDate(options.from)
  const special = (hours.exceptions ?? [])
    .filter((exception) => from === undefined || (parseIsoDate(exception.until ?? exception.date) ?? Infinity) >= from)
    .flatMap((exception): OpeningHoursSpecification[] => {
      const valid = { validFrom: exception.date, validThrough: exception.until ?? exception.date }
      if (exception.hours.length === 0) return [{ '@type': 'OpeningHoursSpecification', opens: '00:00', closes: '00:00', ...valid }]
      return exception.hours.map((interval) => ({
        '@type': 'OpeningHoursSpecification',
        opens: interval.opens,
        closes: schemaClose(interval),
        ...valid,
      }))
    })
  return [...weekly, ...special]
}

const OSM_DAYS: Record<Weekday, string> = { mon: 'Mo', tue: 'Tu', wed: 'We', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su' }
const OSM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function osmTimes(intervals: readonly OpeningInterval[]): string {
  if (intervals.length === 0) return 'off'
  return [...intervals]
    .sort((a, b) => a.opens.localeCompare(b.opens))
    .map((interval) => {
      // OSM writes the end of the day as 24:00; 22:00-03:00 wraps past midnight as is.
      const closes = interval.closes === '00:00' ? '24:00' : interval.closes
      return `${interval.opens}-${closes}`
    })
    .join(',')
}

/** `Mo-We,Fr` from day indexes. */
function osmDays(indexes: number[]): string {
  const parts: string[] = []
  for (let at = 0; at < indexes.length; ) {
    let end = at
    while (end + 1 < indexes.length && indexes[end + 1] === indexes[end] + 1) end++
    const [first, last] = [OSM_DAYS[WEEKDAYS[indexes[at]]], OSM_DAYS[WEEKDAYS[indexes[end]]]]
    parts.push(end === at ? first : end === at + 1 ? `${first},${last}` : `${first}-${last}`)
    at = end + 1
  }
  return parts.join(',')
}

function osmDate(day: number, previous?: number): string {
  const civil = civilFromDay(day)
  const dayNumber = String(civil.day).padStart(2, '0')
  if (previous === undefined) return `${civil.year} ${OSM_MONTHS[civil.month - 1]} ${dayNumber}`
  const before = civilFromDay(previous)
  if (before.year !== civil.year) return `${civil.year} ${OSM_MONTHS[civil.month - 1]} ${dayNumber}`
  return before.month === civil.month ? dayNumber : `${OSM_MONTHS[civil.month - 1]} ${dayNumber}`
}

/**
 * The OpenStreetMap `opening_hours` value, such as `Mo-Fr 09:00-17:30; Sa 10:00-16:00;
 * 2026 Dec 25 off`, for OSM tags or as a compact summary. Closed weekdays are left out.
 */
export function toOsmOpeningHours(hours: OpeningHours): string {
  const groups = new Map<string, number[]>()
  WEEKDAYS.forEach((day, index) => {
    const intervals = hours[day] ?? []
    if (intervals.length === 0) return
    const times = osmTimes(intervals)
    groups.set(times, [...(groups.get(times) ?? []), index])
  })
  const rules = [...groups.entries()].map(([times, days]) => `${osmDays(days)} ${times}`)
  if (rules.length === 0) rules.push('off')
  for (const exception of hours.exceptions ?? []) {
    const from = parseIsoDate(exception.date)
    const to = exception.until === undefined ? from : parseIsoDate(exception.until)
    if (from === undefined || to === undefined) continue
    const dates = to > from ? `${osmDate(from)}-${osmDate(to, from)}` : osmDate(from)
    rules.push(`${dates} ${osmTimes(exception.hours)}`)
  }
  return rules.join('; ')
}
