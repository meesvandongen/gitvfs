import { z } from 'zod'
import type { FieldOptions } from './field-options.js'
import { field } from './fields.js'

export interface SliderOptions {
  /** Step between values. Default: the schema's `.multipleOf()`, 1 for `.int()`, otherwise 1/100 of the range. */
  step?: number
  /** Shown after the value, such as `'%'`, `'px'` or `'min'`. */
  unit?: string
}

/** Where a slider keeps its options in AutoForm's `customData`. */
export interface SliderCustomData {
  slider?: SliderOptions & {
    /** The number schema the slider is attached to, to read its bounds from; set by `slider()`. */
    schema?: z.core.$ZodType
  }
}

/** The range a slider covers. `min` or `max` is missing when the schema has no such bound. */
export interface NumberBounds {
  min?: number
  max?: number
  step?: number
}

interface CheckDef {
  check: string
  value?: number
  format?: string
}

/** Bounds of a zod number schema: `.min()`/`.gte()`/`.gt()`, `.max()`/..., `.multipleOf()` and `.int()`. */
export function numberBounds(schema: z.core.$ZodType): NumberBounds {
  const def = schema._zod.def as { checks?: Array<{ _zod: { def: CheckDef } }> }
  // `z.int()` is a check itself, with the later checks in its definition.
  const checks = [...(schema._zod.traits.has('$ZodCheck') ? [schema as never] : []), ...(def.checks ?? [])]
  const bounds: NumberBounds = {}
  let isInt = false
  for (const check of checks) {
    const { check: kind, value, format } = check._zod.def
    if (kind === 'greater_than' && value !== undefined) bounds.min = Math.max(bounds.min ?? -Infinity, value)
    else if (kind === 'less_than' && value !== undefined) bounds.max = Math.min(bounds.max ?? Infinity, value)
    else if (kind === 'multiple_of' && value !== undefined) bounds.step = value
    else if (kind === 'number_format' && format?.includes('int')) isInt = true
  }
  if (bounds.step === undefined && isInt) bounds.step = 1
  return bounds
}

/**
 * Edit a bounded number with a slider and a number box. The range comes from the schema:
 *
 * ```ts
 * volume: z.number().int().min(0).max(100).check(slider({ label: 'Volume', unit: '%' }))
 * ```
 *
 * Call it once per field: it remembers the schema it is attached to.
 */
export function slider({ step, unit, ...config }: FieldOptions<SliderOptions> = {}): z.core.$ZodCheck<number> {
  const options: NonNullable<SliderCustomData['slider']> = { step, unit }
  // A zod check object carries the field config like `field()` does, and also learns its schema:
  // zod calls `onattach` for every schema built with it, the last one being the final schema.
  const check = z.check<number>(field({ ...config, fieldType: 'slider', customData: { slider: options } }) as never)
  check._zod.onattach.push((schema) => {
    options.schema = schema
  })
  return check
}
