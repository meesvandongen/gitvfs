import { useEffect, useState } from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import {
  DURATION_UNITS,
  describeDuration,
  durationInUnits,
  formatDuration,
  isDuration,
  type DurationOptions,
  type DurationUnit,
} from '../duration.js'
import { fieldOptions, useField } from './field-utils.js'

type Texts = Partial<Record<DurationUnit, string>>

const WHOLE = /^\d+$/
const DESIGNATORS: Record<DurationUnit, string> = { days: 'D', hours: 'H', minutes: 'M', seconds: 'S' }

function textsOf(value: unknown, units: readonly DurationUnit[]): Texts {
  const parts = typeof value === 'string' ? durationInUnits(value, units) : undefined
  return Object.fromEntries(units.map((unit) => [unit, parts?.[unit] === undefined ? '' : String(parts[unit])]))
}

/** The field value for what is typed: empty, a duration, or (for anything but whole numbers) text that fails validation. */
function compose(texts: Texts, units: readonly DurationUnit[]): string | null {
  const filled = units.filter((unit) => texts[unit]?.trim())
  if (filled.length === 0) return null
  if (filled.every((unit) => WHOLE.test(texts[unit]!.trim()))) {
    return formatDuration(Object.fromEntries(filled.map((unit) => [unit, Number(texts[unit])])))
  }
  const part = (unit: DurationUnit) => (texts[unit]?.trim() ? `${texts[unit]!.trim()}${DESIGNATORS[unit]}` : '')
  return `P${part('days')}T${part('hours')}${part('minutes')}${part('seconds')}`
}

/** One number box per unit (hours and minutes by default) and the duration written out. */
export function DurationField({ id, inputProps, parsedField }: AutoFormFieldProps) {
  const field = useField(id)
  const options = fieldOptions<DurationOptions>(parsedField, 'duration')
  const wanted = options.units ?? ['hours', 'minutes']
  const units = DURATION_UNITS.filter((unit) => wanted.includes(unit))
  const [texts, setTexts] = useState(() => textsOf(field.value, units))

  useEffect(() => {
    // Follow changes from outside the inputs; keep what is typed when it means the same value.
    setTexts((current) => (compose(current, units) === (field.value ?? null) ? current : textsOf(field.value, units)))
  }, [field.value])

  const update = (unit: DurationUnit, text: string) => {
    const next = { ...texts, [unit]: text }
    setTexts(next)
    field.onChange(compose(next, units))
  }

  const wholeNumbers = units.every((unit) => !texts[unit]?.trim() || WHOLE.test(texts[unit]!.trim()))
  const summaryId = `${id}-summary`
  return (
    <div className="gcms-duration-field">
      <div className="gcms-duration" role="group" aria-describedby={summaryId}>
        {units.map((unit, index) => (
          <label key={unit} className="gcms-duration-part">
            <input
              className="gcms-input"
              inputMode="numeric"
              autoComplete="off"
              {...inputProps}
              id={index === 0 ? id : `${id}-${unit}`}
              name={index === 0 ? field.name : undefined}
              ref={index === 0 ? field.ref : undefined}
              value={texts[unit] ?? ''}
              onChange={(event) => update(unit, event.target.value)}
              onBlur={field.onBlur}
            />
            <span>{unit}</span>
          </label>
        ))}
      </div>
      <p className={wholeNumbers ? 'gcms-description' : 'gcms-error'} id={summaryId}>
        {!wholeNumbers
          ? 'Use whole numbers'
          : isDuration(field.value)
            ? <>{describeDuration(field.value, options.locale)}, saved as <code>{field.value}</code></>
            : null}
      </p>
    </div>
  )
}
