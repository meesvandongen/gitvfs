import type { AutoFormFieldProps } from '@autoform/react'
import {
  formatOffset,
  formatTime,
  fromWallClock,
  isDateTime,
  isTime,
  parseDateTime,
  stepHasSeconds,
  timeZoneOffset,
  toWallClock,
  type DateTimeOptions,
  type DateTimeZone,
  type TimeOptions,
} from '../datetime.js'
import { fieldOptions, useField } from './field-utils.js'

function zoneLabel(timeZone: DateTimeZone, value: unknown): string {
  if (timeZone === 'floating') return 'Clock time, without a time zone'
  if (timeZone === 'UTC') return 'Time in UTC'
  const name = timeZone === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : timeZone
  // The offset on the chosen date, which differs between summer and winter time.
  const parts = typeof value === 'string' ? parseDateTime(value) : undefined
  const instant = parts?.offset === undefined
    ? Date.now()
    : Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - parts.offset * 60_000
  const zone = `${name} (UTC${formatOffset(timeZoneOffset(timeZone, instant))})`
  return timeZone === 'local' ? `Your time zone, ${zone}` : `Time in ${zone}`
}

/** A date and time picker that stores an ISO 8601 string in the field's time zone mode. */
export function DateTimeField({ id, inputProps, parsedField }: AutoFormFieldProps) {
  const field = useField(id)
  const options = fieldOptions<DateTimeOptions>(parsedField, 'datetime')
  const timeZone = options.timeZone ?? 'local'
  const hintId = `${id}-zone`
  return (
    <div className="gcms-datetime">
      <input
        type="datetime-local"
        className="gcms-input"
        step={options.step}
        aria-describedby={hintId}
        {...inputProps}
        id={id}
        name={field.name}
        ref={field.ref}
        value={toWallClock(field.value, timeZone, stepHasSeconds(options.step))}
        // Incomplete input reads as '': the field is then empty. Cleared fields hold null, as
        // react-hook-form would show the default value again for undefined.
        onChange={(event) => field.onChange(event.target.value ? fromWallClock(event.target.value, timeZone) : null)}
        onBlur={field.onBlur}
      />
      <p className="gcms-description" id={hintId}>
        {zoneLabel(timeZone, field.value)}
        {isDateTime(field.value, timeZone) ? <>. Saved as <code>{field.value}</code></> : null}
      </p>
    </div>
  )
}

/** A time of day picker storing `HH:MM`, or `HH:MM:SS` when the step is below a minute. */
export function TimeField({ id, inputProps, parsedField }: AutoFormFieldProps) {
  const field = useField(id)
  const options = fieldOptions<TimeOptions>(parsedField, 'time')
  const seconds = stepHasSeconds(options.step)
  return (
    <input
      type="time"
      className="gcms-input"
      step={options.step}
      min={options.min}
      max={options.max}
      {...inputProps}
      id={id}
      name={field.name}
      ref={field.ref}
      value={isTime(field.value) ? field.value : ''}
      onChange={(event) => field.onChange(formatTime(event.target.value, seconds) ?? (event.target.value || null))}
      onBlur={field.onBlur}
    />
  )
}
