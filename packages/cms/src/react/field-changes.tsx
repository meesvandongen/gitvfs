import { createContext, useContext } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { valueAt, valuesEqual } from '../changes.js'

export interface BaseValues {
  /** The document's form values on the base branch. */
  values: Record<string, unknown>
  /** The base branch's name, e.g. `main`. */
  label: string
}

/** The base branch's version of the document being edited, for marking fields that differ from it. */
export const BaseValuesContext = createContext<BaseValues | null>(null)

function describe(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return 'empty'
  if (typeof value === 'string') return value.length > 160 ? `“${value.slice(0, 160)}…”` : `“${value}”`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/**
 * Marks a field whose value differs from the base branch's, whatever kind of field it is, with a
 * button to put the base branch's value back. Renders nothing outside a change.
 */
export function FieldChange({ name, revertable = true }: { name: string; revertable?: boolean }) {
  const base = useContext(BaseValuesContext)
  const form = useFormContext() as ReturnType<typeof useFormContext> | null
  if (!base || !form) return null
  return <FieldChangeMarker name={name} base={base} revertable={revertable} />
}

function FieldChangeMarker({ name, base, revertable }: { name: string; base: BaseValues; revertable: boolean }) {
  const { setValue } = useFormContext()
  const value: unknown = useWatch({ name })
  const before = valueAt(base.values, name)
  if (valuesEqual(value, before)) return null

  const previous = describe(before)
  return (
    <span className="gcms-change" title={previous ? `On ${base.label}: ${previous}` : `Differs from ${base.label}`}>
      <span className="gcms-change-dot" aria-hidden="true" />
      Changed
      {revertable ? (
        <button
          type="button"
          className="gcms-link gcms-change-revert"
          aria-label={`Revert ${name} to ${base.label}`}
          onClick={() => setValue(name, before === undefined ? before : structuredClone(before), { shouldDirty: true })}
        >
          Revert
        </button>
      ) : null}
    </span>
  )
}
