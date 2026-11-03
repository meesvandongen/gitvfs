import type { AutoFormFieldProps } from '@autoform/react'
import { useFieldRHF } from '@autoform/react/react-hook-form'
import { describeRangeLength, formatDateRange, isDateRange, moveRangeStart, type DateRange, type DateRangeCustomData } from '../date-range.js'
import { NestedErrors } from './field-utils.js'

// Not imported from ./autoform.js, which imports this module for its field components.
const useField = (name: string) => useFieldRHF({ name }).field

/** Start and end inputs with the range in words; moving the start keeps the length. */
export function DateRangeField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const options = (props.parsedField.fieldConfig?.customData as DateRangeCustomData | undefined)?.dateRange ?? {}
  const value = (field.value ?? {}) as Partial<DateRange>
  const type = options.time ? 'datetime-local' : 'date'
  // Cleared is null: react-hook-form would show the default value again for undefined.
  const set = (next: Partial<DateRange>) => field.onChange(next.start || next.end ? next : null)
  const summary = isDateRange(value) ? [formatDateRange(value, options.locale), describeRangeLength(value, options.unit)].filter(Boolean).join(' · ') : ''

  return (
    <div className="gcms-daterange" tabIndex={-1} ref={field.ref as never}>
      <div className="gcms-daterange-inputs">
        <label className="gcms-sched-label">
          <span>Start</span>
          <input
            className="gcms-input"
            type={type}
            {...props.inputProps}
            id={props.id}
            value={value.start ?? ''}
            onChange={(event) => set(moveRangeStart(value, event.target.value))}
            onBlur={field.onBlur}
          />
        </label>
        <label className="gcms-sched-label">
          <span>End</span>
          <input
            className="gcms-input"
            type={type}
            id={`${props.id}-end`}
            min={value.start || undefined}
            value={value.end ?? ''}
            onChange={(event) => set({ ...value, end: event.target.value })}
            onBlur={field.onBlur}
          />
        </label>
      </div>
      {summary ? (
        <p className="gcms-sched-help" aria-live="polite">
          {summary}
        </p>
      ) : null}
      <NestedErrors name={props.id} />
    </div>
  )
}
