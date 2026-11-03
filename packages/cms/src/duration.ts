import { z } from 'zod'
import { fieldWithOptions, type FieldOptions } from './field-options.js'

// Durations are stored as ISO 8601 duration strings (`PT1H30M`): the format of schema.org
// (`cookTime`, `duration`), YouTube and `Temporal.Duration.from()`, and readable in a file, where a
// number of seconds (5400) is not. They are kept as entered (`PT90M` stays 90 minutes). Years and
// months have no fixed length, so only weeks, days, hours, minutes and seconds are accepted.

export type DurationUnit = 'days' | 'hours' | 'minutes' | 'seconds'

/** The parts of a duration. Weeks are read as 7 days. */
export type DurationParts = Partial<Record<DurationUnit, number>>

export interface DurationOptions {
  /** Inputs the editor shows, from large to small. Default: `['hours', 'minutes']`. */
  units?: DurationUnit[]
  /** Locale of the written-out summary. Default: the browser's. */
  locale?: string
}

/** Where duration fields keep their options in AutoForm's `customData`. */
export interface DurationCustomData {
  duration?: DurationOptions
}

export const DURATION_UNITS: readonly DurationUnit[] = ['days', 'hours', 'minutes', 'seconds']

const SECONDS: Record<DurationUnit, number> = { days: 86_400, hours: 3600, minutes: 60, seconds: 1 }
const DESIGNATORS: Record<DurationUnit, string> = { days: 'D', hours: 'H', minutes: 'M', seconds: 'S' }
const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

/** Read `PT1H30M`, `P1DT2H`, `P2W`. Returns `undefined` for anything else, including years and months. */
export function parseDuration(value: string): DurationParts | undefined {
  const match = DURATION.exec(value)
  if (!match || value === 'P') return undefined
  const [weeks, days, hours, minutes, seconds] = match.slice(1).map((part) => (part === undefined ? undefined : Number(part)))
  const parts: DurationParts = {}
  if (weeks !== undefined || days !== undefined) parts.days = (weeks ?? 0) * 7 + (days ?? 0)
  if (hours !== undefined) parts.hours = hours
  if (minutes !== undefined) parts.minutes = minutes
  if (seconds !== undefined) parts.seconds = seconds
  return parts
}

/** Whether `value` is a duration `parseDuration` reads. */
export function isDuration(value: unknown): value is string {
  return typeof value === 'string' && parseDuration(value) !== undefined
}

/** Write parts as ISO 8601, leaving out zeros: `{ hours: 1, minutes: 30 }` → `PT1H30M`; nothing → `PT0S`. */
export function formatDuration(parts: DurationParts): string {
  const part = (unit: DurationUnit) => (parts[unit] ? `${Math.round(parts[unit]!)}${DESIGNATORS[unit]}` : '')
  const time = part('hours') + part('minutes') + part('seconds')
  const result = `P${part('days')}${time ? `T${time}` : ''}`
  return result === 'P' ? 'PT0S' : result
}

/** Total length in seconds, counting a day as 24 hours. */
export function durationToSeconds(value: string | DurationParts): number {
  const parts = typeof value === 'string' ? parseDuration(value) : value
  if (!parts) return Number.NaN
  return DURATION_UNITS.reduce((total, unit) => total + (parts[unit] ?? 0) * SECONDS[unit], 0)
}

/** Spread seconds over `units`, largest first; what is left below the smallest unit is rounded. */
export function splitDuration(seconds: number, units: readonly DurationUnit[] = DURATION_UNITS): DurationParts {
  const ordered = DURATION_UNITS.filter((unit) => units.includes(unit))
  const parts: DurationParts = {}
  let rest = seconds
  ordered.forEach((unit, index) => {
    const size = SECONDS[unit]
    parts[unit] = index === ordered.length - 1 ? Math.round(rest / size) : Math.floor(rest / size)
    rest -= parts[unit]! * size
  })
  return parts
}

/**
 * The parts of a stored duration in the editor's units: as written when it only uses those units,
 * otherwise recalculated (`P1D` in hours and minutes is 24 hours).
 */
export function durationInUnits(value: string, units: readonly DurationUnit[]): DurationParts | undefined {
  const parts = parseDuration(value)
  if (!parts) return undefined
  const fits = DURATION_UNITS.every((unit) => !parts[unit] || units.includes(unit))
  return fits ? parts : splitDuration(durationToSeconds(parts), units)
}

const SINGULAR: Record<DurationUnit, string> = { days: 'day', hours: 'hour', minutes: 'minute', seconds: 'second' }

/** Written out: `1 hour, 30 minutes` (in English; other locales with `locale`). */
export function describeDuration(value: string | DurationParts, locale?: string): string {
  const parts = typeof value === 'string' ? parseDuration(value) : value
  if (!parts) return ''
  const present = DURATION_UNITS.filter((unit) => parts[unit] !== undefined)
  const shown = present.filter((unit) => parts[unit] !== 0)
  const units = shown.length > 0 ? shown : [present.at(-1) ?? 'minutes']
  const items = units.map((unit) =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: SINGULAR[unit], unitDisplay: 'long' }).format(parts[unit] ?? 0),
  )
  return new Intl.ListFormat(locale, { type: 'unit', style: 'long' }).format(items)
}

/**
 * A length of time, stored as an ISO 8601 duration: `PT1H30M`.
 *
 * ```ts
 * runtime: duration({ label: 'Running time' })
 * prepTime: duration({ label: 'Preparation', units: ['minutes'] })
 * ```
 */
export function duration(config: FieldOptions<DurationOptions> = {}) {
  return z
    .string()
    .refine(isDuration, 'Use an ISO 8601 duration like PT1H30M')
    .check(fieldWithOptions(config, ['units', 'locale'], 'duration'))
}
