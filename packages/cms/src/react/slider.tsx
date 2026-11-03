import type { AutoFormFieldProps } from '@autoform/react'
import { numberBounds, type SliderCustomData } from '../slider.js'
import { fieldOptions, useField } from './field-utils.js'

/**
 * A range input with a number box for the exact value. Without both bounds in the schema only the
 * number box is shown.
 */
export function SliderField({ id, inputProps, parsedField, label }: AutoFormFieldProps) {
  const field = useField(id)
  const options = fieldOptions<NonNullable<SliderCustomData['slider']>>(parsedField, 'slider')
  const bounds = options.schema ? numberBounds(options.schema) : {}
  const { min, max } = bounds
  const hasRange = min !== undefined && max !== undefined && max > min
  const step = options.step ?? bounds.step ?? (hasRange ? (max - min) / 100 : undefined)
  const value = typeof field.value === 'number' && Number.isFinite(field.value) ? field.value : undefined
  const name = typeof label === 'string' ? label : 'Value'
  const unit = options.unit

  return (
    <div className="gcms-slider">
      {hasRange ? (
        <input
          type="range"
          className={`gcms-slider-range${value === undefined ? ' gcms-slider-range--empty' : ''}`}
          {...inputProps}
          id={id}
          name={field.name}
          ref={field.ref}
          min={min}
          max={max}
          step={step}
          value={value ?? min}
          aria-valuetext={value === undefined ? 'Not set' : `${value}${unit ? ` ${unit}` : ''}`}
          onChange={(event) => field.onChange(Number(event.target.value))}
          onBlur={field.onBlur}
        />
      ) : null}
      <div className="gcms-slider-value">
        <input
          type="number"
          className="gcms-input"
          {...inputProps}
          id={hasRange ? `${id}-value` : id}
          ref={hasRange ? undefined : field.ref}
          aria-label={hasRange ? `${name}, exact value${unit ? ` in ${unit}` : ''}` : undefined}
          min={min}
          max={max}
          step={step ?? 'any'}
          value={value ?? ''}
          onChange={(event) => field.onChange(event.target.value === '' ? null : event.target.valueAsNumber)}
          onBlur={field.onBlur}
        />
        {unit ? <span className="gcms-unit" aria-hidden>{unit}</span> : null}
      </div>
    </div>
  )
}
