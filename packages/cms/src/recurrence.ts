import { z } from 'zod'
import type { CmsFieldConfig } from './fields.js'
import { splitFieldConfig } from './field-options.js'
import {
  civilFromDay,
  dayFromCivil,
  daysInMonth,
  formatWallClock,
  parseWallClock,
  wallClockAsUtcDate,
  wallClockOrdinal,
  wallClockToDate,
  weekdayOf,
  type WallClock,
} from './calendar.js'

// A recurrence stores where a series starts and its RFC 5545 rule, both as text:
//
//   start: 2026-11-03T19:30
//   rule: FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20270301T235959
//
// The rule is the RRULE value calendars use (Google Calendar, Outlook, iCalendar files), so it can be
// copied in and out as is; `start` is the DTSTART, as a local ("floating") wall-clock date or
// date-time. Two short keys read better in YAML than iCalendar's `DTSTART:…\nRRULE:…` text, which
// `toICalendar` produces.
//
// Supported: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (with ordinals such as
// 2TU or -1FR for monthly and yearly rules), BYMONTHDAY (negative counts from the month's end),
// BYMONTH, BYSETPOS and WKST. Other parts (BYHOUR, BYWEEKNO, BYYEARDAY, X-…) are kept when a rule is
// edited, but `expandRecurrence` refuses rules that need them, rather than return wrong dates.

export type RRuleWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

/** Weekday codes in ISO order, Monday first. */
export const RRULE_WEEKDAYS: readonly RRuleWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
export const FREQUENCIES: readonly Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']

const ALL_FREQUENCIES = ['SECONDLY', 'MINUTELY', 'HOURLY', ...FREQUENCIES]
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** A BYDAY entry: a weekday, optionally the `n`th (`2TU`) or `n`th from the end (`-1FR`). */
export interface ByDay {
  day: RRuleWeekday
  n?: number
}

/** A parsed RRULE. */
export interface RecurrenceRule {
  freq: Frequency | 'SECONDLY' | 'MINUTELY' | 'HOURLY'
  interval?: number
  count?: number
  /** Last possible occurrence, as ISO text: `2027-03-01`, `2027-03-01T23:59:59`, or with `Z` for UTC. */
  until?: string
  byDay?: ByDay[]
  byMonthDay?: number[]
  byMonth?: number[]
  bySetPos?: number[]
  wkst?: RRuleWeekday
  /** Parts this module does not interpret, as written: `[['BYHOUR', '9,17']]`. */
  other?: Array<[name: string, value: string]>
}

/** The stored value: the first occurrence (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`) and the RRULE. */
export interface Recurrence {
  start: string
  rule: string
}

// The order parts are written in when a rule is new: frequency, pattern, then the end.
const CANONICAL = ['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY', 'BYDAY', 'BYSETPOS', 'WKST', 'COUNT', 'UNTIL']

function integers(name: string, value: string, min: number, max: number, allowNegative: boolean): number[] {
  return value.split(',').map((text) => {
    const number = Number(text)
    if (!/^[+-]?\d+$/.test(text) || Math.abs(number) < min || Math.abs(number) > max || (!allowNegative && number < 0)) {
      throw new RangeError(`${name} must be ${allowNegative ? `±${min} to ±${max}` : `${min} to ${max}`}, not ${text}`)
    }
    return number
  })
}

function weekday(name: string, text: string): RRuleWeekday {
  const day = text.toUpperCase() as RRuleWeekday
  if (!RRULE_WEEKDAYS.includes(day)) throw new RangeError(`${name} must be a weekday (MO to SU), not ${text}`)
  return day
}

/**
 * Parse an RRULE value such as `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU` (an `RRULE:` prefix is allowed).
 * Throws a `RangeError` with a readable message when the rule is invalid.
 */
export function parseRule(text: string): RecurrenceRule {
  const source = text.trim().replace(/^RRULE:/i, '')
  if (source === '') throw new RangeError('The rule is empty')
  const seen = new Set<string>()
  const rule: Partial<RecurrenceRule> = {}
  for (const part of source.split(';')) {
    if (part.trim() === '') continue
    const equals = part.indexOf('=')
    if (equals <= 0) throw new RangeError(`Expected NAME=VALUE, not ${part}`)
    const written = part.slice(0, equals).trim()
    const name = written.toUpperCase()
    const value = part.slice(equals + 1).trim()
    if (seen.has(name)) throw new RangeError(`${name} appears twice`)
    seen.add(name)
    if (value === '') throw new RangeError(`${name} has no value`)
    switch (name) {
      case 'FREQ':
        if (!ALL_FREQUENCIES.includes(value.toUpperCase())) throw new RangeError(`FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY, not ${value}`)
        rule.freq = value.toUpperCase() as RecurrenceRule['freq']
        break
      case 'INTERVAL':
        rule.interval = integers(name, value, 1, 10_000, false)[0]
        break
      case 'COUNT':
        rule.count = integers(name, value, 1, 100_000, false)[0]
        break
      case 'UNTIL': {
        const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(value)
        const iso = match ? `${match[1]}-${match[2]}-${match[3]}${match[4] ? `T${match[4]}:${match[5]}:${match[6]}` : ''}` : ''
        if (!match || !parseWallClock(iso)) throw new RangeError(`UNTIL must be a date like 20270301 or 20270301T235959Z, not ${value}`)
        rule.until = match[7] ? `${iso}Z` : iso
        break
      }
      case 'BYDAY':
        rule.byDay = value.split(',').map((item) => {
          const match = /^([+-]?\d{1,2})?([A-Z]{2})$/i.exec(item)
          if (!match) throw new RangeError(`BYDAY must list weekdays like TU or 2TU, not ${item}`)
          const day = weekday(name, match[2])
          if (match[1] === undefined) return { day }
          const n = integers(name, match[1], 1, 53, true)[0]
          return { day, n }
        })
        break
      case 'BYMONTHDAY':
        rule.byMonthDay = integers(name, value, 1, 31, true)
        break
      case 'BYMONTH':
        rule.byMonth = integers(name, value, 1, 12, false)
        break
      case 'BYSETPOS':
        rule.bySetPos = integers(name, value, 1, 366, true)
        break
      case 'WKST':
        rule.wkst = weekday(name, value)
        break
      default:
        ;(rule.other ??= []).push([written, value])
    }
  }
  if (!rule.freq) throw new RangeError('The rule needs a FREQ, such as FREQ=WEEKLY')
  if (rule.count !== undefined && rule.until !== undefined) throw new RangeError('Use COUNT or UNTIL, not both')
  if (rule.byDay?.some((entry) => entry.n !== undefined) && rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') {
    throw new RangeError('Numbered weekdays (2TU) only work in monthly and yearly rules')
  }
  if (rule.byMonthDay && rule.freq === 'WEEKLY') throw new RangeError('BYMONTHDAY does not work in weekly rules')
  if (rule.bySetPos && !rule.byDay && !rule.byMonthDay && !rule.byMonth && !rule.other?.some(([key]) => /^BY/i.test(key))) {
    throw new RangeError('BYSETPOS needs another BY… part to pick from')
  }
  return rule as RecurrenceRule
}

function partValues(rule: RecurrenceRule): Map<string, string> {
  const values = new Map<string, string>()
  values.set('FREQ', rule.freq)
  if (rule.interval !== undefined && rule.interval !== 1) values.set('INTERVAL', String(rule.interval))
  if (rule.byMonth?.length) values.set('BYMONTH', rule.byMonth.join(','))
  if (rule.byMonthDay?.length) values.set('BYMONTHDAY', rule.byMonthDay.join(','))
  if (rule.byDay?.length) values.set('BYDAY', rule.byDay.map((entry) => `${entry.n ?? ''}${entry.day}`).join(','))
  if (rule.bySetPos?.length) values.set('BYSETPOS', rule.bySetPos.join(','))
  if (rule.wkst) values.set('WKST', rule.wkst)
  if (rule.count !== undefined) values.set('COUNT', String(rule.count))
  if (rule.until) values.set('UNTIL', rule.until.replace(/[-:]/g, ''))
  return values
}

/**
 * Write a rule as RRULE text. Pass the `previous` text of a rule being edited to keep the order its
 * parts were written in, so a hand-written rule changes as little as possible; a new part goes
 * before the first part that conventionally follows it (FREQ, INTERVAL, BYMONTH, BYMONTHDAY, BYDAY,
 * BYSETPOS, WKST, COUNT, UNTIL). Parts in `rule.other` are written as they were read.
 */
export function formatRule(rule: RecurrenceRule, previous?: string): string {
  const values = partValues(rule)
  const other = new Map((rule.other ?? []).map(([name, value]) => [name.toUpperCase(), [name, value] as const]))
  const parts: string[] = []
  const take = (name: string) => {
    const upper = name.toUpperCase()
    if (values.has(upper)) {
      parts.push(`${upper}=${values.get(upper)}`)
      values.delete(upper)
    } else if (other.has(upper)) {
      const [written, value] = other.get(upper)!
      parts.push(`${written}=${value}`)
      other.delete(upper)
    }
  }
  const order = previous
    ? previous
        .trim()
        .replace(/^RRULE:/i, '')
        .split(';')
        .map((part) => part.split('=')[0].trim().toUpperCase())
    : []
  // A part the previous text did not have goes before the first part that conventionally follows it.
  const rank = (name: string) => CANONICAL.indexOf(name)
  for (const name of CANONICAL) {
    if (!values.has(name) || order.includes(name)) continue
    const before = order.findIndex((other) => rank(other) > rank(name))
    order.splice(before === -1 ? order.length : before, 0, name)
  }
  for (const name of order) take(name)
  for (const [name] of other) take(name)
  return parts.join(';')
}

/** Parts that change which dates a rule produces but that `expandRecurrence` does not implement. */
export function unsupportedParts(rule: RecurrenceRule): string[] {
  const parts = (rule.other ?? []).filter(([name]) => !/^X-/i.test(name)).map(([name, value]) => `${name.toUpperCase()}=${value}`)
  return FREQUENCIES.includes(rule.freq as Frequency) ? parts : [`FREQ=${rule.freq}`, ...parts]
}

// --- Expansion -----------------------------------------------------------------------------------

const weekdayIndex = (day: RRuleWeekday) => RRULE_WEEKDAYS.indexOf(day)

/** The days in `[first, last]` that BYDAY selects, with ordinals counted within that span. */
function byDayIn(first: number, last: number, byDay: readonly ByDay[]): Set<number> {
  const result = new Set<number>()
  for (const entry of byDay) {
    const wanted = weekdayIndex(entry.day)
    const firstMatch = first + ((wanted - weekdayOf(first) + 7) % 7)
    const matches: number[] = []
    for (let day = firstMatch; day <= last; day += 7) matches.push(day)
    if (entry.n === undefined) matches.forEach((day) => result.add(day))
    else {
      const day = entry.n > 0 ? matches[entry.n - 1] : matches[matches.length + entry.n]
      if (day !== undefined) result.add(day)
    }
  }
  return result
}

function monthDayMatches(day: number, byMonthDay: readonly number[]): boolean {
  const civil = civilFromDay(day)
  const length = daysInMonth(civil.year, civil.month)
  return byMonthDay.some((wanted) => (wanted > 0 ? wanted === civil.day : length + wanted + 1 === civil.day))
}

function applySetPos(days: number[], bySetPos: readonly number[] | undefined): number[] {
  if (!bySetPos) return days
  const picked = bySetPos.map((position) => (position > 0 ? days[position - 1] : days[days.length + position]))
  return [...new Set(picked.filter((day): day is number => day !== undefined))].sort((a, b) => a - b)
}

/** Days of a month that BYMONTHDAY and BYDAY select (BYDAY ordinals count within `span`). */
function selectInMonth(year: number, month: number, rule: RecurrenceRule, fallbackDay: number, span?: [number, number]): number[] {
  const first = dayFromCivil(year, month, 1)
  const last = first + daysInMonth(year, month) - 1
  if (!rule.byMonthDay && !rule.byDay) return fallbackDay <= daysInMonth(year, month) ? [first + fallbackDay - 1] : []
  const byDay = rule.byDay ? byDayIn(...(span ?? [first, last]), rule.byDay) : undefined
  const days: number[] = []
  for (let day = first; day <= last; day++) {
    if (rule.byMonthDay && !monthDayMatches(day, rule.byMonthDay)) continue
    if (byDay && !byDay.has(day)) continue
    days.push(day)
  }
  return days
}

/** The candidate days of the `k`th period of the rule, before COUNT and UNTIL. */
function periodDays(rule: RecurrenceRule, start: number, k: number): number[] {
  const interval = rule.interval ?? 1
  const startCivil = civilFromDay(start)
  const inMonths = (day: number) => !rule.byMonth || rule.byMonth.includes(civilFromDay(day).month)
  let days: number[]
  switch (rule.freq) {
    case 'DAILY': {
      const day = start + k * interval
      const keep =
        inMonths(day) &&
        (!rule.byMonthDay || monthDayMatches(day, rule.byMonthDay)) &&
        (!rule.byDay || rule.byDay.some((entry) => weekdayIndex(entry.day) === weekdayOf(day)))
      days = keep ? [day] : []
      break
    }
    case 'WEEKLY': {
      const weekStart = weekdayIndex(rule.wkst ?? 'MO')
      const first = start - ((weekdayOf(start) - weekStart + 7) % 7) + 7 * k * interval
      const wanted = rule.byDay ? rule.byDay.map((entry) => weekdayIndex(entry.day)) : [weekdayOf(start)]
      days = []
      for (let day = first; day < first + 7; day++) if (wanted.includes(weekdayOf(day)) && inMonths(day)) days.push(day)
      break
    }
    case 'MONTHLY': {
      const index = startCivil.year * 12 + startCivil.month - 1 + k * interval
      const [year, month] = [Math.floor(index / 12), (index % 12) + 1]
      days = !rule.byMonth || rule.byMonth.includes(month) ? selectInMonth(year, month, rule, startCivil.day) : []
      break
    }
    case 'YEARLY': {
      const year = startCivil.year + k * interval
      if (!rule.byMonthDay && !rule.byDay) {
        days = (rule.byMonth ?? [startCivil.month])
          .filter((month) => startCivil.day <= daysInMonth(year, month))
          .map((month) => dayFromCivil(year, month, startCivil.day))
      } else if (rule.byMonth) {
        days = rule.byMonth.flatMap((month) => selectInMonth(year, month, rule, startCivil.day))
      } else {
        // Without BYMONTH, BYDAY ordinals count within the year ("the 20th Monday").
        const span: [number, number] = [dayFromCivil(year, 1, 1), dayFromCivil(year, 12, 31)]
        days = Array.from({ length: 12 }, (_, month) => selectInMonth(year, month + 1, rule, startCivil.day, span)).flat()
      }
      days = [...new Set(days)].sort((a, b) => a - b)
      break
    }
    default:
      throw new RangeError(`FREQ=${rule.freq} is not supported`)
  }
  return applySetPos(days, rule.bySetPos)
}

/** The ordinal of the last moment UNTIL allows; a date-only UNTIL includes the whole day. */
function untilOrdinal(until: string): number {
  const clock = parseWallClock(until.replace(/Z$/i, ''))!
  return clock.minutes === undefined ? wallClockOrdinal({ day: clock.day + 1 }) - 1 : wallClockOrdinal(clock)
}

// A rule that has not matched for this long never will: the Gregorian calendar repeats every 400 years.
const GIVE_UP_DAYS = 400 * 366
const LAST_DAY = dayFromCivil(9999, 12, 31)

export interface ExpandOptions {
  /** Only occurrences at or after this local date or date-time. COUNT still counts from the start. */
  from?: string
  /** Only occurrences at or before this local date or date-time. */
  to?: string
  /** Most occurrences to return. Default: 100. */
  limit?: number
}

/**
 * The dates of a series, as local `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` text like `start`: the start,
 * when the rule matches it (a start that does not match is skipped, as rrule.js and python-dateutil
 * do), and the following matches. Times are wall-clock times, so a weekly 09:00 stays at 09:00 across
 * daylight saving changes; `wallClockToDate` turns one into an instant in a time zone. Throws a
 * `RangeError` for an invalid start or rule, or one with `unsupportedParts`.
 */
export function expandRecurrence(recurrence: Recurrence, options: ExpandOptions = {}): string[] {
  const start = parseWallClock(recurrence.start)
  if (!start) throw new RangeError(`Not a date: ${recurrence.start}`)
  const rule = parseRule(recurrence.rule)
  const unsupported = unsupportedParts(rule)
  if (unsupported.length > 0) throw new RangeError(`Not supported: ${unsupported.join(', ')}`)
  const limit = options.limit ?? 100
  const from = options.from === undefined ? undefined : parseWallClock(options.from)
  const to = options.to === undefined ? undefined : parseWallClock(options.to)
  const until = rule.until ? untilOrdinal(rule.until) : undefined
  const end = Math.min(until ?? Infinity, to ? (to.minutes === undefined ? untilOrdinal(options.to!) : wallClockOrdinal(to)) : Infinity)
  const fromOrdinal = from ? wallClockOrdinal(from) : -Infinity

  const results: string[] = []
  let counted = 0
  let lastMatch = start.day
  for (let k = 0; ; k++) {
    const days = periodDays(rule, start.day, k)
    for (const day of days) {
      if (day < start.day) continue
      if (day > LAST_DAY) return results
      const occurrence: WallClock = { ...start, day }
      const ordinal = wallClockOrdinal(occurrence)
      if (ordinal > end) return results
      lastMatch = day
      counted++
      if (ordinal >= fromOrdinal) results.push(formatWallClock(occurrence))
      if (results.length >= limit || (rule.count !== undefined && counted >= rule.count)) return results
    }
    const progress = periodProgress(rule, start.day, k)
    if (progress > LAST_DAY + 366 || progress - lastMatch > GIVE_UP_DAYS) return results
  }
}

/** Roughly where the `k`th period starts, to know when to give up on a rule that never matches. */
function periodProgress(rule: RecurrenceRule, start: number, k: number): number {
  const interval = rule.interval ?? 1
  const unit = { DAILY: 1, WEEKLY: 7, MONTHLY: 30.4, YEARLY: 365.25 }[rule.freq as Frequency]
  return start + Math.floor(k * interval * unit)
}

// --- Words ---------------------------------------------------------------------------------------

/** `1st`, `2nd`, `last`, `2nd to last`. */
export function ordinal(n: number): string {
  if (n === -1) return 'last'
  if (n < 0) return `${ordinal(-n)} to last`
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${suffix}`
}

function list(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

const dayName = (day: RRuleWeekday) => DAY_NAMES[weekdayIndex(day)]

function describeByDay(rule: RecurrenceRule): string {
  const byDay = rule.byDay!
  // `BYDAY=TU;BYSETPOS=2` says the same as `BYDAY=2TU`.
  if (byDay.length === 1 && byDay[0].n === undefined && rule.bySetPos?.length === 1 && rule.freq !== 'WEEKLY') {
    return `the ${ordinal(rule.bySetPos[0])} ${dayName(byDay[0].day)}`
  }
  if (byDay.every((entry) => entry.n === undefined)) {
    const days = byDay.map((entry) => entry.day)
    if (days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((day) => days.includes(day as RRuleWeekday))) return 'weekdays'
    if (days.length === 2 && days.includes('SA') && days.includes('SU')) return 'weekends'
    return list(byDay.map((entry) => dayName(entry.day)))
  }
  return list(byDay.map((entry) => (entry.n === undefined ? `every ${dayName(entry.day)}` : `the ${ordinal(entry.n)} ${dayName(entry.day)}`)))
}

function describeMonthDays(days: readonly number[]): string {
  if (days.length === 1 && days[0] < 0) return `the ${ordinal(days[0])} day`
  return `${days.length === 1 ? 'day' : 'days'} ${list(days.map((day) => (day < 0 ? ordinal(day) : String(day))))}`
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * The series in words: `Every 2 weeks on Tuesday, until 1 Mar 2027`, `Every month on the 2nd
 * Tuesday, 10 times`. Dates are formatted in `locale`; the sentence is English.
 */
export function describeRecurrence(recurrence: Recurrence, options: { locale?: string } = {}): string {
  let rule: RecurrenceRule
  try {
    rule = parseRule(recurrence.rule)
  } catch {
    return ''
  }
  const start = parseWallClock(recurrence.start)
  const interval = rule.interval ?? 1
  const units: Record<RecurrenceRule['freq'], string> = {
    SECONDLY: 'second',
    MINUTELY: 'minute',
    HOURLY: 'hour',
    DAILY: 'day',
    WEEKLY: 'week',
    MONTHLY: 'month',
    YEARLY: 'year',
  }
  let text = interval === 1 ? `Every ${units[rule.freq]}` : `Every ${interval} ${units[rule.freq]}s`
  const months = rule.byMonth ? ` in ${list(rule.byMonth.map((month) => MONTH_NAMES[month - 1]))}` : ''

  if (rule.freq === 'WEEKLY') {
    text += ` on ${rule.byDay ? describeByDay(rule) : start ? DAY_NAMES[weekdayOf(start.day)] : 'the start day'}${months}`
  } else if (rule.freq === 'MONTHLY' || (rule.freq === 'YEARLY' && (rule.byDay || rule.byMonthDay))) {
    const parts = [rule.byMonthDay ? describeMonthDays(rule.byMonthDay) : '', rule.byDay ? describeByDay(rule) : ''].filter(Boolean)
    const fallback = start ? `day ${civilFromDay(start.day).day}` : 'the start day'
    text += `${months} on ${parts.length > 0 ? parts.join(' if it is ') : fallback}`
  } else if (rule.freq === 'YEARLY') {
    if (start) {
      const day = civilFromDay(start.day).day
      text += ` on ${list((rule.byMonth ?? [civilFromDay(start.day).month]).map((month) => `${day} ${MONTH_NAMES[month - 1]}`))}`
    }
  } else {
    if (rule.byDay) text += ` on ${describeByDay(rule)}`
    if (rule.byMonthDay) text += ` on ${describeMonthDays(rule.byMonthDay)}`
    text += months
  }
  if (rule.bySetPos && !(rule.byDay?.length === 1 && rule.bySetPos.length === 1 && rule.freq !== 'WEEKLY')) {
    text += `, only the ${list(rule.bySetPos.map(ordinal))} of each ${units[rule.freq]}`
  }
  const unsupported = unsupportedParts(rule).filter((part) => !part.startsWith('FREQ='))
  if (unsupported.length > 0) text += ` (with ${unsupported.join(', ')})`

  if (rule.count !== undefined) text += rule.count === 1 ? ', once' : `, ${rule.count} times`
  if (rule.until) {
    const until = parseWallClock(rule.until.replace(/Z$/i, ''))!
    const date = new Intl.DateTimeFormat(options.locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
    text += `, until ${date.format(wallClockAsUtcDate({ day: until.day }))}`
  }
  return text
}

// --- Schema --------------------------------------------------------------------------------------

export interface RecurrenceOptions {
  /** The start has a time of day (`2026-11-03T19:30`). Default: false. */
  time?: boolean
  /** Locale of dates in the summary and the list of next dates. Default: the browser's. */
  locale?: string
  /** How many upcoming dates the editor lists. Default: 5. */
  preview?: number
}

export type RecurrenceFieldConfig = Omit<CmsFieldConfig, 'fieldType' | 'customData'> & RecurrenceOptions

/** Where a recurrence field keeps its options in AutoForm's `customData`. */
export interface RecurrenceCustomData {
  recurrence: RecurrenceOptions
}

const OPTION_KEYS = ['time', 'locale', 'preview'] as const

/**
 * A repeating date: `{ start, rule }`, with an RFC 5545 RRULE.
 *
 * ```ts
 * repeats: recurrence({ label: 'Repeats', time: true }).optional()
 * ```
 */
export function recurrence(config: RecurrenceFieldConfig = {}) {
  const { check, options } = splitFieldConfig<RecurrenceOptions>(config, OPTION_KEYS, 'recurrence', 'recurrence')
  return z
    .object({
      start: z.string().refine(
        (text) => {
          const clock = parseWallClock(text)
          return clock !== undefined && (clock.minutes !== undefined) === Boolean(options.time)
        },
        options.time ? 'Use a date and time like 2026-11-03T19:30' : 'Use a date like 2026-11-03',
      ),
      rule: z.string(),
    })
    .superRefine((value, context) => {
      let rule: RecurrenceRule
      try {
        rule = parseRule(value.rule)
      } catch (error) {
        context.addIssue({ code: 'custom', path: ['rule'], message: (error as Error).message })
        return
      }
      const start = parseWallClock(value.start)
      if (start && rule.until && untilOrdinal(rule.until) < wallClockOrdinal(start)) {
        context.addIssue({ code: 'custom', path: ['rule'], message: 'The series ends before it starts' })
      }
    })
    .check(check)
}

// --- iCalendar -----------------------------------------------------------------------------------

const basic = (iso: string) => iso.replace(/[-:]/g, '')

/**
 * The series as iCalendar lines (`DTSTART…` and `RRULE:…`, joined with CRLF), for `.ics` files and
 * calendar APIs. Without `timeZone` the start is floating (local wherever it is read). With one, the
 * start gets a `TZID` and a local UNTIL is converted to UTC, as RFC 5545 requires.
 */
export function toICalendar(recurrence: Recurrence, options: { timeZone?: string } = {}): string {
  const start = parseWallClock(recurrence.start)
  if (!start) throw new RangeError(`Not a date: ${recurrence.start}`)
  const rule = parseRule(recurrence.rule)
  const value = basic(formatWallClock({ ...start, seconds: start.minutes === undefined ? undefined : (start.seconds ?? 0) }))
  // UNTIL must have the type of DTSTART: a date for dates, a date-time (in UTC when zoned) otherwise.
  const until = rule.until?.replace(/Z$/i, '')
  const untilIsDate = until !== undefined && parseWallClock(until)!.minutes === undefined
  let dtstart: string
  if (start.minutes === undefined) {
    dtstart = `DTSTART;VALUE=DATE:${value}`
    if (until) rule.until = until.slice(0, 10)
  } else {
    dtstart = options.timeZone ? `DTSTART;TZID=${options.timeZone}:${value}` : `DTSTART:${value}`
    const local = untilIsDate ? `${until}T23:59:59` : until
    if (local && options.timeZone && !/Z$/i.test(rule.until!)) {
      rule.until = `${wallClockToDate(local, options.timeZone).toISOString().slice(0, 19)}Z`
    } else if (local && untilIsDate) rule.until = local
  }
  return `${dtstart}\r\nRRULE:${formatRule(rule, recurrence.rule)}`
}
