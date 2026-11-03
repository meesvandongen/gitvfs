import { useEffect, useState } from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import { useFieldRHF } from '@autoform/react/react-hook-form'
import { civilFromDay, formatIsoDate, parseWallClock, wallClockAsUtcDate, wallClockAt, weekdayOf, type WallClock } from '../calendar.js'
import {
  FREQUENCIES,
  RRULE_WEEKDAYS,
  describeRecurrence,
  expandRecurrence,
  formatRule,
  ordinal,
  parseRule,
  type Frequency,
  type Recurrence,
  type RecurrenceCustomData,
  type RecurrenceRule,
  type RRuleWeekday,
} from '../recurrence.js'
import { NestedErrors } from './field-utils.js'

// Not imported from ./autoform.js, which imports this module for its field components.
const useField = (name: string) => useFieldRHF({ name }).field

const FREQUENCY_LABELS: Record<Frequency, [label: string, unit: string]> = {
  DAILY: ['Daily', 'day'],
  WEEKLY: ['Weekly', 'week'],
  MONTHLY: ['Monthly', 'month'],
  YEARLY: ['Yearly', 'year'],
}
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTH_DAYS = [...Array.from({ length: 31 }, (_, index) => index + 1), -1]
const WEEK_ORDINALS = [1, 2, 3, 4, 5, -1]

type MonthlyPattern = { kind: 'day'; day: number } | { kind: 'weekday'; n: number; day: RRuleWeekday } | { kind: 'custom' }

/** What the start date suggests: its day of the month, and which weekday of the month it is. */
function startDefaults(start: WallClock | undefined) {
  if (!start) return { monthDay: 1, n: 1, weekday: 'MO' as RRuleWeekday }
  const day = civilFromDay(start.day).day
  const n = Math.ceil(day / 7)
  return { monthDay: day, n: n === 5 ? -1 : n, weekday: RRULE_WEEKDAYS[weekdayOf(start.day)] }
}

/** The monthly pattern the controls can show, or `custom` for rules only the text can express. */
function monthlyPattern(rule: RecurrenceRule, start: WallClock | undefined): MonthlyPattern {
  const { byDay, byMonthDay, bySetPos, byMonth } = rule
  if (byMonth) return { kind: 'custom' }
  if (!byDay && !bySetPos) {
    if (!byMonthDay) return { kind: 'day', day: startDefaults(start).monthDay }
    if (byMonthDay.length === 1 && MONTH_DAYS.includes(byMonthDay[0])) return { kind: 'day', day: byMonthDay[0] }
  }
  if (!byMonthDay && byDay?.length === 1) {
    const n = byDay[0].n ?? (bySetPos?.length === 1 ? bySetPos[0] : undefined)
    const plain = byDay[0].n === undefined ? bySetPos?.length === 1 : !bySetPos
    if (plain && n !== undefined && WEEK_ORDINALS.includes(n)) return { kind: 'weekday', n, day: byDay[0].day }
  }
  return { kind: 'custom' }
}

const withoutPattern = (rule: RecurrenceRule): RecurrenceRule => ({ ...rule, byDay: undefined, byMonthDay: undefined, bySetPos: undefined, byMonth: undefined })

function setMonthly(rule: RecurrenceRule, pattern: MonthlyPattern): RecurrenceRule {
  if (pattern.kind === 'day') return { ...withoutPattern(rule), byMonthDay: [pattern.day] }
  if (pattern.kind === 'weekday') return { ...withoutPattern(rule), byDay: [{ day: pattern.day, n: pattern.n }] }
  return rule
}

/** A new frequency starts from the start date's pattern; the interval, the end and unknown parts stay. */
function changeFrequency(rule: RecurrenceRule, freq: Frequency, start: WallClock | undefined): RecurrenceRule {
  const next = { ...withoutPattern(rule), freq }
  const defaults = startDefaults(start)
  if (freq === 'WEEKLY' && start) next.byDay = [{ day: defaults.weekday }]
  if (freq === 'MONTHLY' && start) next.byMonthDay = [defaults.monthDay]
  return next
}

/** Move a pattern that followed the old start (its weekday, its day of the month) to the new one. */
function followStart(rule: RecurrenceRule, before: WallClock | undefined, after: WallClock | undefined): RecurrenceRule {
  if (!before || !after) return rule
  const [old, now] = [startDefaults(before), startDefaults(after)]
  if (rule.freq === 'WEEKLY' && rule.byDay?.length === 1 && rule.byDay[0].day === old.weekday && !rule.byDay[0].n) {
    return { ...rule, byDay: [{ day: now.weekday }] }
  }
  if (rule.freq === 'MONTHLY') {
    const pattern = monthlyPattern(rule, before)
    if (pattern.kind === 'day' && pattern.day === old.monthDay && rule.byMonthDay) return setMonthly(rule, { kind: 'day', day: now.monthDay })
    if (pattern.kind === 'weekday' && pattern.n === old.n && pattern.day === old.weekday) {
      return setMonthly(rule, { kind: 'weekday', n: now.n, day: now.weekday })
    }
  }
  return rule
}

/** A whole number input that lets people clear it while typing. */
function CountInput({ id, value, onChange, label, min = 1 }: { id: string; value: number; onChange: (value: number) => void; label: string; min?: number }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft((current) => (Number(current) === value ? current : String(value))), [value])
  return (
    <input
      id={id}
      className="gcms-input gcms-recurrence-number"
      type="number"
      inputMode="numeric"
      min={min}
      aria-label={label}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        const number = Number(event.target.value)
        if (Number.isInteger(number) && number >= min) onChange(number)
      }}
    />
  )
}

function now(time: boolean): string {
  const clock = wallClockAt(new Date())
  return time ? `${clock.date}T${clock.time}` : clock.date
}

function formatOccurrence(text: string, locale: string | undefined): string {
  const clock = parseWallClock(text)!
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(clock.minutes === undefined ? {} : { hour: '2-digit', minute: '2-digit' }),
  }).format(wallClockAsUtcDate(clock))
}

/**
 * A repeating date: start, frequency, interval, weekdays or a monthly pattern, and an end; with the
 * series in words, the next dates, and the RRULE text for rules the controls cannot express.
 */
export function RecurrenceField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const options = (props.parsedField.fieldConfig?.customData as RecurrenceCustomData | undefined)?.recurrence ?? {}
  const value = (field.value ?? undefined) as Partial<Recurrence> | undefined
  const id = props.id
  const time = Boolean(options.time)
  const start = parseWallClock(value?.start)
  const ruleText = value?.rule ?? ''

  let rule: RecurrenceRule | undefined
  let ruleError: string | undefined
  if (value) {
    try {
      rule = parseRule(ruleText)
    } catch (error) {
      ruleError = (error as Error).message
    }
  }

  const write = (next: RecurrenceRule, nextStart = value?.start ?? '') => field.onChange({ start: nextStart, rule: formatRule(next, ruleText || undefined) })
  const update = (change: (rule: RecurrenceRule) => RecurrenceRule) => rule && write(change({ ...rule }))

  const onFrequency = (choice: string) => {
    // null, not undefined: react-hook-form would show the default value again.
    if (choice === '') return field.onChange(null)
    const freq = choice as Frequency
    if (!value) {
      // A new series starts today, at 09:00 when it has a time.
      const first = time ? `${now(false)}T09:00` : now(false)
      return write(changeFrequency({ freq }, freq, parseWallClock(first)), first)
    }
    if (rule) write(changeFrequency(rule, freq, start))
  }

  const frequencySelect = (
    <label className="gcms-sched-label">
      <span>Repeats</span>
      <select
        className="gcms-input"
        id={value ? `${id}-freq` : id}
        {...(value ? {} : props.inputProps)}
        value={rule?.freq ?? ''}
        disabled={Boolean(value) && !rule}
        onChange={(event) => onFrequency(event.target.value)}
      >
        {!value || !props.parsedField.required ? <option value="">{props.parsedField.required ? 'Choose…' : 'Does not repeat'}</option> : null}
        {FREQUENCIES.map((freq) => (
          <option key={freq} value={freq}>
            {FREQUENCY_LABELS[freq][0]}
          </option>
        ))}
        {rule && !FREQUENCIES.includes(rule.freq as Frequency) ? (
          <option value={rule.freq} disabled>
            {rule.freq.toLowerCase()} (as written)
          </option>
        ) : null}
      </select>
    </label>
  )

  if (!value) {
    return (
      <div className="gcms-recurrence" tabIndex={-1} ref={field.ref as never}>
        <div className="gcms-recurrence-line">{frequencySelect}</div>
        <NestedErrors name={id} />
      </div>
    )
  }

  const defaults = startDefaults(start)
  const unit = FREQUENCIES.includes(rule?.freq as Frequency) ? FREQUENCY_LABELS[rule!.freq as Frequency][1] : undefined
  const interval = rule?.interval ?? 1
  const ends = rule?.count !== undefined ? 'count' : rule?.until ? 'until' : 'never'
  const monthly = rule?.freq === 'MONTHLY' ? monthlyPattern(rule, start) : undefined
  const weekdays = rule?.byDay?.map((entry) => entry.day) ?? [defaults.weekday]

  let upcoming: string[] = []
  let first: string | undefined
  let expandError: string | undefined
  if (rule && start) {
    try {
      upcoming = expandRecurrence(value as Recurrence, { from: now(start.minutes !== undefined), limit: options.preview ?? 5 })
      first = expandRecurrence(value as Recurrence, { limit: 1 })[0]
    } catch (error) {
      expandError = (error as Error).message
    }
  }

  const ruleInput = (
    <label className="gcms-sched-label">
      <span>Rule (RFC 5545 RRULE)</span>
      <input
        className="gcms-input gcms-recurrence-rule"
        spellCheck={false}
        autoComplete="off"
        value={ruleText}
        onChange={(event) => field.onChange({ ...value, rule: event.target.value.trim().replace(/^RRULE:/i, '') })}
      />
    </label>
  )

  return (
    <div className="gcms-recurrence" tabIndex={-1} ref={field.ref as never}>
      <div className="gcms-recurrence-line">
        <label className="gcms-sched-label">
          <span>Starts</span>
          <input
            className="gcms-input"
            type={time ? 'datetime-local' : 'date'}
            {...props.inputProps}
            id={id}
            value={value.start ?? ''}
            onChange={(event) => {
              const nextStart = event.target.value
              if (rule) write(followStart(rule, start, parseWallClock(nextStart)), nextStart)
              else field.onChange({ ...value, start: nextStart })
            }}
            onBlur={field.onBlur}
          />
        </label>
        {frequencySelect}
        {rule && unit ? (
          <div className="gcms-sched-label">
            <label htmlFor={`${id}-interval`}>Every</label>
            <span className="gcms-recurrence-inline">
              <CountInput id={`${id}-interval`} label={`Every how many ${unit}s`} value={interval} onChange={(next) => update((current) => ({ ...current, interval: next }))} />
              <span>{interval === 1 ? unit : `${unit}s`}</span>
            </span>
          </div>
        ) : null}
      </div>

      {rule?.freq === 'WEEKLY' ? (
        <div className="gcms-recurrence-days" role="group" aria-label="On these days">
          {RRULE_WEEKDAYS.map((day, index) => {
            const pressed = weekdays.includes(day)
            return (
              <button
                key={day}
                type="button"
                className="gcms-recurrence-day"
                aria-pressed={pressed}
                aria-label={DAY_LABELS[index]}
                title={pressed && weekdays.length === 1 ? 'At least one day is needed' : undefined}
                onClick={() => {
                  if (pressed && weekdays.length === 1) return
                  const next = pressed ? weekdays.filter((other) => other !== day) : [...weekdays, day]
                  update((current) => ({ ...current, byDay: RRULE_WEEKDAYS.filter((other) => next.includes(other)).map((other) => ({ day: other })) }))
                }}
              >
                {DAY_LABELS[index].slice(0, 2)}
              </button>
            )
          })}
        </div>
      ) : null}

      {monthly ? (
        <div className="gcms-recurrence-options" role="radiogroup" aria-label="Day of the month">
          <label className="gcms-recurrence-option">
            <input
              type="radio"
              name={`${id}-monthly`}
              checked={monthly.kind === 'day'}
              onChange={() => update((current) => setMonthly(current, { kind: 'day', day: defaults.monthDay }))}
            />
            <span>On day</span>
            <select
              className="gcms-input gcms-sched-inline"
              aria-label="Day of the month"
              value={monthly.kind === 'day' ? monthly.day : defaults.monthDay}
              onChange={(event) => update((current) => setMonthly(current, { kind: 'day', day: Number(event.target.value) }))}
            >
              {MONTH_DAYS.map((day) => (
                <option key={day} value={day}>
                  {day === -1 ? 'last' : day}
                </option>
              ))}
            </select>
          </label>
          <label className="gcms-recurrence-option">
            <input
              type="radio"
              name={`${id}-monthly`}
              checked={monthly.kind === 'weekday'}
              onChange={() => update((current) => setMonthly(current, { kind: 'weekday', n: defaults.n, day: defaults.weekday }))}
            />
            <span>On the</span>
            <select
              className="gcms-input gcms-sched-inline"
              aria-label="Which week of the month"
              value={monthly.kind === 'weekday' ? monthly.n : defaults.n}
              onChange={(event) =>
                update((current) => setMonthly(current, { kind: 'weekday', n: Number(event.target.value), day: monthly.kind === 'weekday' ? monthly.day : defaults.weekday }))
              }
            >
              {WEEK_ORDINALS.map((n) => (
                <option key={n} value={n}>
                  {ordinal(n)}
                </option>
              ))}
            </select>
            <select
              className="gcms-input gcms-sched-inline"
              aria-label="Weekday"
              value={monthly.kind === 'weekday' ? monthly.day : defaults.weekday}
              onChange={(event) =>
                update((current) => setMonthly(current, { kind: 'weekday', n: monthly.kind === 'weekday' ? monthly.n : defaults.n, day: event.target.value as RRuleWeekday }))
              }
            >
              {RRULE_WEEKDAYS.map((day, index) => (
                <option key={day} value={day}>
                  {DAY_LABELS[index]}
                </option>
              ))}
            </select>
          </label>
          {monthly.kind === 'custom' ? (
            <label className="gcms-recurrence-option">
              <input type="radio" name={`${id}-monthly`} checked readOnly />
              <span>A custom pattern, kept from the rule below</span>
            </label>
          ) : null}
          {monthly.kind === 'day' && monthly.day > 28 ? (
            <p className="gcms-sched-help">Months without a day {monthly.day} are skipped. Choose “last” for the end of every month.</p>
          ) : null}
        </div>
      ) : null}

      {rule && (rule.freq === 'DAILY' || rule.freq === 'YEARLY') && (rule.byDay || rule.byMonthDay || rule.byMonth || rule.bySetPos) ? (
        <p className="gcms-sched-help">A custom pattern, kept from the rule below.</p>
      ) : null}

      {rule ? (
        <div className="gcms-recurrence-options" role="radiogroup" aria-label="Ends">
          <span className="gcms-recurrence-heading">Ends</span>
          <label className="gcms-recurrence-option">
            <input type="radio" name={`${id}-ends`} checked={ends === 'never'} onChange={() => update((current) => ({ ...current, count: undefined, until: undefined }))} />
            <span>Never</span>
          </label>
          <label className="gcms-recurrence-option">
            <input
              type="radio"
              name={`${id}-ends`}
              checked={ends === 'until'}
              onChange={() => {
                const last = formatIsoDate((start?.day ?? parseWallClock(now(false))!.day) + 91)
                update((current) => ({ ...current, count: undefined, until: time ? `${last}T23:59:59` : last }))
              }}
            />
            <span>On</span>
            <input
              className="gcms-input gcms-sched-inline"
              type="date"
              aria-label="Last date"
              disabled={ends !== 'until'}
              min={value.start?.slice(0, 10)}
              value={rule.until?.slice(0, 10) ?? ''}
              onChange={(event) => {
                const last = event.target.value
                if (last) update((current) => ({ ...current, count: undefined, until: time ? `${last}T23:59:59` : last }))
              }}
            />
          </label>
          <label className="gcms-recurrence-option">
            <input type="radio" name={`${id}-ends`} checked={ends === 'count'} onChange={() => update((current) => ({ ...current, until: undefined, count: 10 }))} />
            <span>After</span>
            {ends === 'count' ? (
              <CountInput id={`${id}-count`} label="Number of times" value={rule.count!} onChange={(count) => update((current) => ({ ...current, count }))} />
            ) : (
              <input className="gcms-input gcms-recurrence-number" type="number" aria-label="Number of times" disabled value="" />
            )}
            <span>times</span>
          </label>
        </div>
      ) : null}

      {rule ? (
        <div className="gcms-recurrence-summary" aria-live="polite">
          <strong>{describeRecurrence(value as Recurrence, { locale: options.locale })}</strong>
          {expandError ? (
            <p className="gcms-sched-help">Upcoming dates cannot be shown. {expandError}; the rule is kept as written.</p>
          ) : start ? (
            <>
              {first && first !== value.start ? (
                <p className="gcms-sched-help">The start does not match the rule, so the series begins on {formatOccurrence(first, options.locale)}.</p>
              ) : null}
              {upcoming.length > 0 ? (
                <>
                  <span className="gcms-sched-help">Next dates</span>
                  <ol className="gcms-recurrence-dates">
                    {upcoming.map((date) => (
                      <li key={date}>
                        <time dateTime={date}>{formatOccurrence(date, options.locale)}</time>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <p className="gcms-sched-help">No upcoming dates.</p>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {ruleError ? (
        <>
          <p className="gcms-error" role="alert">
            The rule cannot be read: {ruleError}.
          </p>
          {ruleInput}
        </>
      ) : (
        <details className="gcms-recurrence-advanced">
          <summary>Rule as text</summary>
          {ruleInput}
          <p className="gcms-sched-help">Paste a rule from a calendar app. Parts the controls do not show are kept.</p>
        </details>
      )}
      <NestedErrors name={id} />
    </div>
  )
}
