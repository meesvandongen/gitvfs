import { useRef } from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import { useFieldRHF } from '@autoform/react/react-hook-form'
import { formatTime, wallClockAt } from '../calendar.js'
import {
  WEEKDAYS,
  WEEKDAY_NAMES,
  intervalMinutes,
  isOvernight,
  type OpeningHours,
  type OpeningHoursCustomData,
  type OpeningHoursException,
  type OpeningInterval,
  type Weekday,
} from '../opening-hours.js'
import { NestedErrors } from './field-utils.js'

// Not imported from ./autoform.js, which imports this module for its field components.
const useField = (name: string) => useFieldRHF({ name }).field

const DEFAULT_INTERVAL: OpeningInterval = { opens: '09:00', closes: '17:00' }

/** `<input type="time">` cannot show 24:00; midnight reads the same as a closing time of 00:00. */
const timeInputValue = (time: string) => (time === '24:00' ? '00:00' : time)

/** An interval after the last one, for "Add hours": an hour later, three hours long. */
function nextInterval(intervals: readonly OpeningInterval[], fallback: OpeningInterval): OpeningInterval {
  const last = intervals.at(-1)
  const end = last ? intervalMinutes(last)?.[1] : undefined
  if (end === undefined) return fallback
  const opens = Math.min(end + 60, 23 * 60)
  return { opens: formatTime(opens), closes: formatTime(Math.min(opens + 180, 24 * 60 - 1)) }
}

function intervalNote(interval: OpeningInterval): string | undefined {
  const minutes = intervalMinutes(interval)
  if (!minutes) return undefined
  if (minutes[1] - minutes[0] === 24 * 60) return '24 hours'
  return isOvernight(interval) ? 'next day' : undefined
}

function Intervals({
  name,
  intervals,
  onChange,
  firstId,
  inputProps,
}: {
  /** Used in accessible names: "Monday opens". */
  name: string
  intervals: OpeningInterval[]
  onChange: (intervals: OpeningInterval[]) => void
  firstId?: string
  inputProps?: Record<string, unknown>
}) {
  const update = (index: number, patch: Partial<OpeningInterval>) =>
    onChange(intervals.map((interval, at) => (at === index ? { ...interval, ...patch } : interval)))
  return (
    <div className="gcms-hours-intervals">
      {intervals.map((interval, index) => {
        const suffix = intervals.length > 1 ? ` (${index + 1})` : ''
        const note = intervalNote(interval)
        return (
          <div className="gcms-hours-interval" key={index}>
            <input
              className="gcms-input gcms-hours-time"
              type="time"
              {...(index === 0 ? inputProps : {})}
              id={index === 0 ? firstId : undefined}
              aria-label={`${name} opens${suffix}`}
              value={interval.opens}
              onChange={(event) => update(index, { opens: event.target.value })}
            />
            <span aria-hidden>–</span>
            <input
              className="gcms-input gcms-hours-time"
              type="time"
              aria-label={`${name} closes${suffix}`}
              value={timeInputValue(interval.closes)}
              onChange={(event) => update(index, { closes: event.target.value })}
            />
            {note ? <span className="gcms-hours-note">{note}</span> : null}
            <button
              type="button"
              className="gcms-button gcms-button--ghost gcms-button--small"
              aria-label={`Remove ${name} ${interval.opens}–${interval.closes}`}
              title="Remove these hours"
              onClick={() => onChange(intervals.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** A "Closed" checkbox that remembers the hours it cleared, to bring them back when unticked. */
function ClosedToggle({
  name,
  intervals,
  onChange,
  fallback,
}: {
  name: string
  intervals: OpeningInterval[]
  onChange: (intervals: OpeningInterval[]) => void
  fallback: OpeningInterval
}) {
  const remembered = useRef<OpeningInterval[]>([])
  const closed = intervals.length === 0
  return (
    <label className="gcms-hours-closed">
      <input
        type="checkbox"
        checked={closed}
        aria-label={`${name} closed`}
        onChange={(event) => {
          if (event.target.checked) {
            remembered.current = intervals
            onChange([])
          } else onChange(remembered.current.length > 0 ? remembered.current : [{ ...fallback }])
        }}
      />
      <span>Closed</span>
    </label>
  )
}

/** Today's date in the browser, for a new special date. */
const today = () => wallClockAt(new Date()).date

/**
 * Weekly opening hours: one row per day with any number of intervals (for lunch breaks), a closed
 * toggle and "Copy to all days", plus special dates for holidays.
 */
export function OpeningHoursField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const options = (props.parsedField.fieldConfig?.customData as OpeningHoursCustomData | undefined)?.openingHours ?? {}
  const fallback = options.defaultInterval ?? DEFAULT_INTERVAL
  const value = (field.value ?? {}) as OpeningHours
  const exceptions = value.exceptions ?? []

  // Write every day, so a closed day reads as `sun: []` instead of being missing.
  const set = (patch: Partial<OpeningHours>) => {
    const next = { ...value, ...patch }
    const week = Object.fromEntries(WEEKDAYS.map((day) => [day, next[day] ?? []]))
    field.onChange(next.exceptions?.length ? { ...week, exceptions: next.exceptions } : week)
  }
  const setException = (index: number, patch: Partial<OpeningHoursException>) =>
    set({ exceptions: exceptions.map((exception, at) => (at === index ? { ...exception, ...patch } : exception)) })

  return (
    <div className="gcms-hours" tabIndex={-1} ref={field.ref as never}>
      <div className="gcms-hours-week">
        {WEEKDAYS.map((day: Weekday, index) => {
          const name = WEEKDAY_NAMES[day]
          const intervals = value[day] ?? []
          const change = (next: OpeningInterval[]) => set({ [day]: next })
          return (
            <div className="gcms-hours-row" role="group" aria-label={name} key={day}>
              <span className="gcms-hours-day">{name}</span>
              <ClosedToggle name={name} intervals={intervals} onChange={change} fallback={fallback} />
              {intervals.length > 0 ? (
                <Intervals
                  name={name}
                  intervals={intervals}
                  onChange={change}
                  firstId={index === 0 ? props.id : undefined}
                  inputProps={index === 0 ? props.inputProps : undefined}
                />
              ) : null}
              <div className="gcms-hours-actions">
                <button
                  type="button"
                  className="gcms-button gcms-button--small"
                  aria-label={`Add hours on ${name}`}
                  onClick={() => change([...intervals, nextInterval(intervals, fallback)])}
                >
                  Add hours
                </button>
                <button
                  type="button"
                  className="gcms-button gcms-button--ghost gcms-button--small"
                  aria-label={`Copy ${name}'s hours to all days`}
                  onClick={() => set(Object.fromEntries(WEEKDAYS.map((other) => [other, intervals.map((interval) => ({ ...interval }))])))}
                >
                  Copy to all days
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {options.exceptions === false ? null : (
        <fieldset className="gcms-hours-special">
          <legend>Special dates</legend>
          {exceptions.length === 0 ? <p className="gcms-sched-help">Holidays and other days with different hours.</p> : null}
          {exceptions.map((exception, index) => {
            const name = exception.label || exception.date || `Special date ${index + 1}`
            const hours = exception.hours ?? []
            return (
              <div className="gcms-hours-exception" role="group" aria-label={name} key={index}>
                <div className="gcms-hours-exception-dates">
                  <label className="gcms-sched-label">
                    <span>Date</span>
                    <input className="gcms-input" type="date" value={exception.date} onChange={(event) => setException(index, { date: event.target.value })} />
                  </label>
                  <label className="gcms-sched-label">
                    <span>Until (optional)</span>
                    <input
                      className="gcms-input"
                      type="date"
                      min={exception.date || undefined}
                      value={exception.until ?? ''}
                      onChange={(event) => setException(index, { until: event.target.value || undefined })}
                    />
                  </label>
                  <label className="gcms-sched-label">
                    <span>Name</span>
                    <input
                      className="gcms-input"
                      placeholder="Christmas"
                      value={exception.label ?? ''}
                      onChange={(event) => setException(index, { label: event.target.value || undefined })}
                    />
                  </label>
                </div>
                <div className="gcms-hours-row">
                  <ClosedToggle name={name} intervals={hours} onChange={(next) => setException(index, { hours: next })} fallback={fallback} />
                  {hours.length > 0 ? <Intervals name={name} intervals={hours} onChange={(next) => setException(index, { hours: next })} /> : null}
                  <div className="gcms-hours-actions">
                    <button
                      type="button"
                      className="gcms-button gcms-button--small"
                      aria-label={`Add hours on ${name}`}
                      onClick={() => setException(index, { hours: [...hours, nextInterval(hours, fallback)] })}
                    >
                      Add hours
                    </button>
                    <button
                      type="button"
                      className="gcms-button gcms-button--ghost gcms-button--small"
                      aria-label={`Remove ${name}`}
                      onClick={() => set({ exceptions: exceptions.filter((_, at) => at !== index) })}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
          <button type="button" className="gcms-button gcms-button--small" onClick={() => set({ exceptions: [...exceptions, { date: today(), hours: [] }] })}>
            Add special date
          </button>
        </fieldset>
      )}

      {!props.parsedField.required && field.value != null ? (
        <div>
          {/* null, not undefined: react-hook-form would show the default value again. */}
          <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={() => field.onChange(null)}>
            Clear opening hours
          </button>
        </div>
      ) : null}
      <NestedErrors name={props.id} />
    </div>
  )
}
