import { useEffect, useState, type AriaAttributes, type FocusEventHandler, type KeyboardEventHandler } from 'react'
import { useFormState } from 'react-hook-form'
import { getLabel, type ParsedField } from '@autoform/core'
import { cellType, type TableCellType, type TableColumn } from '../table.js'

// Inputs and error lookups shared by the table and tree editors, which edit the fields of many
// objects in one component instead of one AutoForm field per value.

export interface FieldColumn extends TableColumn {
  default?: unknown
}

/** The fields of the objects in a list field, in AutoForm's order, or `undefined` for a list of something else. */
export function objectFields(parsedField: ParsedField): FieldColumn[] | undefined {
  const element = parsedField.schema?.[0]
  if (!element || element.type !== 'object') return undefined
  return (element.schema ?? []).map((child) => ({
    key: child.key,
    label: String(getLabel(child) || child.key),
    type: cellType(child.type),
    required: child.required,
    options: child.options,
    default: child.default,
  }))
}

/**
 * A new object with the schema's defaults; required checkboxes start unchecked rather than missing.
 * Other editable fields start as `null`, which holds their place so keys follow the schema's order
 * while filling them in (AutoForm validates `null` as missing, and the source view leaves it out).
 */
export function blankObject(fields: readonly FieldColumn[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.default !== undefined) result[field.key] = structuredClone(field.default)
    else if (field.type === 'boolean' && field.required) result[field.key] = false
    else if (field.type) result[field.key] = null
  }
  return result
}

/** The errors below a field, as react-hook-form nests them: `errors.rows[2].price`. */
export function useErrorTree(name: string): unknown {
  const { errors } = useFormState({ name })
  return errorAt(errors, name.split('.'))
}

export function errorAt(errors: unknown, path: ReadonlyArray<string | number>): unknown {
  let node = errors
  for (const key of path) node = (node as Record<string | number, unknown> | undefined)?.[key]
  return node
}

const friendly = (message: string) =>
  /received undefined|received null/.test(message)
    ? 'Required'
    : /expected number, received string/.test(message)
      ? 'Enter a number'
      : message

function ownMessage(node: unknown): string | undefined {
  const value = node as { message?: unknown; root?: { message?: unknown } } | undefined
  const message = value?.message ?? value?.root?.message
  return typeof message === 'string' ? friendly(message) : undefined
}

/**
 * Every message at and below an error node, except below `skip` keys (a tree node's children
 * have their own messages).
 */
export function errorMessages(node: unknown, skip: readonly string[] = []): string[] {
  const messages: string[] = []
  const collect = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 6) return
    const own = ownMessage(value)
    if (own) messages.push(own)
    for (const [key, child] of Object.entries(value)) {
      if (key === 'ref' || key === 'root' || key === 'message' || key === 'type' || key === 'types') continue
      if (depth === 0 && skip.includes(key)) continue
      collect(child, depth + 1)
    }
  }
  collect(node, 0)
  return [...new Set(messages)]
}

export interface ValueInputProps extends AriaAttributes {
  type: TableCellType
  value: unknown
  onChange: (value: unknown) => void
  options?: TableColumn['options']
  required?: boolean
  id?: string
  className?: string
  onKeyDown?: KeyboardEventHandler<HTMLElement>
  onFocus?: FocusEventHandler<HTMLElement>
  [data: `data-${string}`]: string | number | undefined
}

const asText = (value: unknown): string =>
  value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value as string | number | boolean)

/** `<input type="date">` wants YYYY-MM-DD; values may be Dates or full ISO strings. */
function dateText(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  return typeof value === 'string' ? value.slice(0, 10) : ''
}

/**
 * Text that becomes a number while typing. Keeps what is typed (`-`, `1.`) and reports text that
 * is not a number as is, so validation flags it instead of the old value being saved silently.
 */
function NumberValue({ value, onChange, className, ...rest }: Omit<ValueInputProps, 'type' | 'options'>) {
  const text = asText(value)
  const [draft, setDraft] = useState(text)
  useEffect(() => {
    setDraft((current) => (current.trim() !== '' && Number(current) === value ? current : text))
  }, [value, text])
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={`gcms-input ${className ?? ''}`}
      {...rest}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        const typed = event.target.value.trim()
        const number = Number(typed)
        onChange(typed === '' ? undefined : Number.isFinite(number) ? number : typed)
      }}
    />
  )
}

/** One input for a string, number, checkbox, date or select value. */
export function ValueInput({ type, value, onChange, options, required, className, ...rest }: ValueInputProps) {
  const inputClass = `gcms-input ${className ?? ''}`
  switch (type) {
    case 'number':
      return <NumberValue value={value} onChange={onChange} className={className} {...rest} />
    case 'boolean':
      return (
        <input
          type="checkbox"
          className={`gcms-checkbox-input ${className ?? ''}`}
          {...rest}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      )
    case 'date':
      return <input type="date" className={inputClass} {...rest} value={dateText(value)} onChange={(event) => onChange(event.target.value || undefined)} />
    case 'select': {
      const known = options?.some(([option]) => option === value)
      return (
        <select className={inputClass} {...rest} value={asText(value)} onChange={(event) => onChange(event.target.value || undefined)}>
          {!required || value === undefined ? <option value="">—</option> : null}
          {/* A stored value that is not an option stays visible, so it can be seen and fixed. */}
          {value !== undefined && value !== '' && !known ? <option value={asText(value)}>{asText(value)}</option> : null}
          {(options ?? []).map(([option, label]) => (
            <option key={option} value={option}>
              {label}
            </option>
          ))}
        </select>
      )
    }
    default:
      // An optional value that is emptied is removed rather than stored as ''.
      return (
        <input
          type="text"
          autoComplete="off"
          className={inputClass}
          {...rest}
          value={asText(value)}
          onChange={(event) => onChange(event.target.value === '' && !required ? undefined : event.target.value)}
        />
      )
  }
}

/** A short, read-only rendering of a value the table or tree cannot edit. */
export function summarize(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (value instanceof Date) return dateText(value)
  const text = asText(value)
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}
