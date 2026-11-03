import { useEffect, useMemo, useRef, type ReactNode, type Ref } from 'react'
import { useFormContext } from 'react-hook-form'
import { AutoForm, useFieldRHF } from '@autoform/react/react-hook-form'
import type {
  ArrayElementWrapperProps,
  ArrayWrapperProps,
  AutoFormFieldComponents,
  AutoFormFieldProps,
  AutoFormUIComponents,
  FieldWrapperProps,
  ObjectWrapperProps,
} from '@autoform/react'
import { ZodProvider } from '@autoform/zod'
import { z } from 'zod'
import type { ContentType } from '../config.js'
import { GeoCircleField, GeoLineField, GeoPointField, GeoPointsField, GeoPolygonField } from './map.js'
import { DateTimeField, TimeField } from './datetime.js'
import { DurationField } from './duration.js'
import { withFieldState } from './field-utils.js'
import { MoneyField } from './money.js'
import { PhoneField } from './phone.js'
import { SliderField } from './slider.js'
import { TableField } from './table.js'
import { TreeField } from './tree.js'
import { FieldChange } from './field-changes.js'

/**
 * The form binding (`value`, `onChange`, `onBlur`, `name`, `ref`) for a field, for custom field
 * components: `const field = useField(props.id)`.
 */
export function useField(name: string) {
  return useFieldRHF({ name }).field
}

function StringField({ id, inputProps }: AutoFormFieldProps) {
  const field = useField(id)
  return (
    <input
      type="text"
      className="gcms-input"
      {...inputProps}
      id={id}
      name={field.name}
      ref={field.ref}
      value={field.value ?? ''}
      onChange={(event) => field.onChange(event.target.value)}
      onBlur={field.onBlur}
    />
  )
}

function NumberField({ id, inputProps }: AutoFormFieldProps) {
  const field = useField(id)
  return (
    <input
      type="number"
      className="gcms-input"
      {...inputProps}
      id={id}
      name={field.name}
      ref={field.ref}
      value={field.value ?? ''}
      onChange={(event) =>
        field.onChange(event.target.value === '' ? undefined : event.target.valueAsNumber)}
      onBlur={field.onBlur}
    />
  )
}

function BooleanField({ id, inputProps }: AutoFormFieldProps) {
  const field = useField(id)
  return (
    <input
      type="checkbox"
      className="gcms-checkbox-input"
      {...inputProps}
      id={id}
      name={field.name}
      ref={field.ref}
      checked={Boolean(field.value)}
      onChange={(event) => field.onChange(event.target.checked)}
      onBlur={field.onBlur}
    />
  )
}

/** `<input type="date">` wants YYYY-MM-DD; frontmatter may hold a Date or any ISO string. */
export function toDateInputValue(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value.slice(0, 10)
  return ''
}

function DateField({ id, inputProps }: AutoFormFieldProps) {
  const field = useField(id)
  return (
    <input
      type="date"
      className="gcms-input"
      {...inputProps}
      id={id}
      name={field.name}
      ref={field.ref}
      value={toDateInputValue(field.value)}
      onChange={(event) => field.onChange(event.target.value || undefined)}
      onBlur={field.onBlur}
    />
  )
}

function SelectField({ id, inputProps, parsedField }: AutoFormFieldProps) {
  const field = useField(id)
  return (
    <select
      className="gcms-input"
      {...inputProps}
      id={id}
      name={field.name}
      ref={field.ref}
      value={field.value ?? ''}
      onChange={(event) => field.onChange(event.target.value || undefined)}
      onBlur={field.onBlur}
    >
      {(!parsedField.required || field.value === undefined) && <option value="">—</option>}
      {(parsedField.options ?? []).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  )
}

function TextareaField({ id, inputProps }: AutoFormFieldProps) {
  const field = useField(id)
  return (
    <textarea
      className="gcms-input gcms-textarea"
      rows={4}
      {...inputProps}
      id={id}
      name={field.name}
      ref={field.ref}
      value={field.value ?? ''}
      onChange={(event) => field.onChange(event.target.value)}
      onBlur={field.onBlur}
    />
  )
}

type Formatter =
  | { kind: 'wrap'; before: string; after: string; placeholder: string }
  | { kind: 'line'; prefix: string }

const MARKDOWN_TOOLS: Array<{ label: string; title: string; format: Formatter }> = [
  { label: 'B', title: 'Bold', format: { kind: 'wrap', before: '**', after: '**', placeholder: 'bold' } },
  { label: 'I', title: 'Italic', format: { kind: 'wrap', before: '_', after: '_', placeholder: 'italic' } },
  { label: 'H', title: 'Heading', format: { kind: 'line', prefix: '## ' } },
  { label: '•', title: 'Bulleted list', format: { kind: 'line', prefix: '- ' } },
  { label: '❝', title: 'Quote', format: { kind: 'line', prefix: '> ' } },
  { label: '<>', title: 'Code', format: { kind: 'wrap', before: '`', after: '`', placeholder: 'code' } },
  {
    label: 'Link',
    title: 'Link',
    format: { kind: 'wrap', before: '[', after: '](https://)', placeholder: 'text' },
  },
]

/** Apply a toolbar action to `value`, returning the new text and selection. */
export function applyMarkdownFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: Formatter,
): { value: string; selectionStart: number; selectionEnd: number } {
  if (format.kind === 'wrap') {
    const selected = value.slice(selectionStart, selectionEnd) || format.placeholder
    const start = selectionStart + format.before.length
    return {
      value: value.slice(0, selectionStart) + format.before + selected + format.after + value.slice(selectionEnd),
      selectionStart: start,
      selectionEnd: start + selected.length,
    }
  }
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
  return {
    value: value.slice(0, lineStart) + format.prefix + value.slice(lineStart),
    selectionStart: selectionStart + format.prefix.length,
    selectionEnd: selectionEnd + format.prefix.length,
  }
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as { current: T | null }).current = node
    }
  }
}

function MarkdownField({ id, inputProps }: AutoFormFieldProps) {
  const field = useField(id)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const pendingSelection = useRef<[number, number] | null>(null)
  const value: string = field.value ?? ''

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea && pendingSelection.current) {
      textarea.focus()
      textarea.setSelectionRange(...pendingSelection.current)
      pendingSelection.current = null
    }
  }, [value])

  const format = (formatter: Formatter) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const next = applyMarkdownFormat(value, textarea.selectionStart, textarea.selectionEnd, formatter)
    pendingSelection.current = [next.selectionStart, next.selectionEnd]
    field.onChange(next.value)
  }

  return (
    <div className="gcms-markdown">
      <div className="gcms-markdown-toolbar" role="toolbar" aria-label="Formatting">
        {MARKDOWN_TOOLS.map((tool) => (
          <button
            key={tool.title}
            type="button"
            className="gcms-tool"
            title={tool.title}
            aria-label={tool.title}
            onClick={() => format(tool.format)}
          >
            {tool.label}
          </button>
        ))}
      </div>
      <textarea
        className="gcms-input gcms-textarea gcms-markdown-input"
        rows={18}
        spellCheck
        {...inputProps}
        id={id}
        name={field.name}
        ref={mergeRefs(field.ref, textareaRef)}
        value={value}
        onChange={(event) => field.onChange(event.target.value)}
        onBlur={field.onBlur}
      />
    </div>
  )
}

/** Zod's messages for missing values are written for developers; show editors something plainer. */
export function friendlyError(error: ReactNode): ReactNode {
  return typeof error === 'string' && /received undefined|received null/.test(error) ? 'Required' : error
}

function FieldWrapper({ label, error, children, id, parsedField }: FieldWrapperProps) {
  // Arrays and objects render their own legend, so only add the error here.
  if (parsedField.type === 'array' || parsedField.type === 'object') {
    return (
      <div className={`gcms-field gcms-field--${parsedField.type}`}>
        {parsedField.type === 'array' ? <FieldChange name={id} revertable={false} /> : null}
        {children}
        {error ? <p className="gcms-error" role="alert">{friendlyError(error)}</p> : null}
      </div>
    )
  }

  const description = parsedField.fieldConfig?.description ?? parsedField.description
  const isCheckbox = parsedField.type === 'boolean'
  // Array items have no label of their own (their key is the index).
  const hasLabel = typeof label === 'string'
    ? label !== '' && !/^\d+$/.test(label)
    : typeof label !== 'number' && label !== null && label !== undefined && label !== false
  const required = parsedField.required && !isCheckbox ? <span className="gcms-required"> *</span> : null

  return (
    <div className={`gcms-field gcms-field--${parsedField.type}`}>
      {isCheckbox ? (
        <div className="gcms-field-row">
          <label className="gcms-checkbox" htmlFor={id}>
            {children}
            <span>{label}</span>
          </label>
          <FieldChange name={id} />
        </div>
      ) : (
        <>
          {hasLabel ? (
            <div className="gcms-field-row">
              <label className="gcms-label" htmlFor={id}>
                {label}
                {required}
              </label>
              <FieldChange name={id} />
            </div>
          ) : (
            <FieldChange name={id} />
          )}
          {children}
        </>
      )}
      {description ? <p className="gcms-description">{description}</p> : null}
      {error ? (
        <p className="gcms-error" role="alert">
          {friendlyError(error)}
        </p>
      ) : null}
    </div>
  )
}

function ObjectWrapper({ label, children }: ObjectWrapperProps) {
  return (
    <fieldset className="gcms-group">
      <legend className="gcms-legend">{label}</legend>
      {children}
    </fieldset>
  )
}

function ArrayWrapper({ label, error, children, onAddItem }: ArrayWrapperProps) {
  return (
    <fieldset className="gcms-group gcms-array">
      <legend className="gcms-legend">{label}</legend>
      {children}
      {error ? <p className="gcms-error">{friendlyError(error)}</p> : null}
      <button type="button" className="gcms-button gcms-button--small" onClick={onAddItem}>
        Add item
      </button>
    </fieldset>
  )
}

function ArrayElementWrapper({ children, onRemove, index }: ArrayElementWrapperProps) {
  return (
    <div className="gcms-array-item">
      <div className="gcms-array-item-body">{children}</div>
      <button
        type="button"
        className="gcms-button gcms-button--ghost gcms-button--small"
        aria-label={`Remove item ${index + 1}`}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  )
}

export const uiComponents: AutoFormUIComponents = {
  Form: (props) => <form className="gcms-form" noValidate {...props} />,
  FieldWrapper,
  ErrorMessage: ({ error }) => <p className="gcms-error">{error}</p>,
  SubmitButton: ({ children }) => (
    <button type="submit" className="gcms-button gcms-button--primary">
      {children}
    </button>
  ),
  ObjectWrapper,
  ArrayWrapper,
  ArrayElementWrapper,
}

export const formComponents: AutoFormFieldComponents = {
  string: StringField,
  number: NumberField,
  boolean: BooleanField,
  date: DateField,
  select: SelectField,
  textarea: TextareaField,
  markdown: MarkdownField,
  geopoint: GeoPointField,
  geocircle: GeoCircleField,
  geoline: GeoLineField,
  geopolygon: GeoPolygonField,
  geopoints: GeoPointsField,
  datetime: DateTimeField,
  time: TimeField,
  slider: SliderField,
  money: MoneyField,
  duration: DurationField,
  phone: PhoneField,
  table: TableField,
  tree: TreeField,
  fallback: StringField,
}

function ValuesSpy({ onChange }: { onChange: (values: Record<string, unknown>) => void }) {
  const { watch, getValues } = useFormContext()
  const latest = useRef(onChange)
  latest.current = onChange

  useEffect(() => {
    latest.current(getValues())
    const subscription = watch((values) => latest.current({ ...values }))
    return () => subscription.unsubscribe()
  }, [watch, getValues])

  return null
}

export interface ContentFormProps {
  contentType: ContentType
  defaultValues?: Record<string, unknown>
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>
  /** Called with the raw (unvalidated) values on every change, e.g. for a live preview. */
  onValuesChange?: (values: Record<string, unknown>) => void
  /** `id` of the form element, so buttons elsewhere can submit it with `form="..."`. */
  formId?: string
  uiComponents?: Partial<AutoFormUIComponents>
  formComponents?: Partial<AutoFormFieldComponents>
  children?: ReactNode
}

interface ZodNode {
  _zod: { def: { type: string; innerType?: ZodNode; shape?: Record<string, ZodNode> } }
}

function isOptional(schema: ZodNode): boolean {
  const { def } = schema._zod
  return def.type === 'optional' || (def.innerType !== undefined && isOptional(def.innerType))
}

function objectShape(schema: ZodNode): Record<string, ZodNode> | undefined {
  const { def } = schema._zod
  if (def.type === 'object') return def.shape
  return def.innerType ? objectShape(def.innerType) : undefined
}

/**
 * AutoForm fills every object in the schema with `{}`, even optional ones, so an optional group the
 * user never touched (a location, a map field) fails validation for its required parts. Mark optional
 * keys that the document does not have as explicitly `undefined`, which wins over those defaults.
 */
export function unsetMissingOptionals(schema: ZodNode, data: Record<string, unknown> = {}): Record<string, unknown> {
  const shape = objectShape(schema)
  if (!shape) return data
  const result: Record<string, unknown> = { ...data }
  for (const [key, child] of Object.entries(shape)) {
    const value = data[key]
    if (value === undefined) {
      if (isOptional(child)) result[key] = undefined
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      result[key] = unsetMissingOptionals(child, value as Record<string, unknown>)
    }
  }
  return result
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)

/** Nothing filled in: undefined, null, '' or an object of only those. An empty list is a value. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  return isPlainObject(value) && Object.values(value).every(isBlank)
}

/**
 * Drop optional groups the user left blank. AutoForm's inputs recreate `{ venue: undefined, ... }`
 * for every group they render, which would otherwise fail validation of an optional `z.object`.
 */
export function pruneBlankOptionals(schema: ZodNode, data: unknown): unknown {
  const shape = objectShape(schema)
  if (!shape || !isPlainObject(data)) return data
  const result: Record<string, unknown> = { ...data }
  for (const [key, child] of Object.entries(shape)) {
    const value = result[key]
    if (!isPlainObject(value)) continue
    result[key] = isOptional(child) && isBlank(value) ? undefined : pruneBlankOptionals(child, value)
  }
  return result
}

/** Validates with blank optional groups removed; parses the form from the schema as is. */
class CmsZodProvider<T extends ContentType['schema']> extends ZodProvider<T> {
  private validation: T | undefined

  getSchema(): T {
    const schema = super.getSchema()
    this.validation ??= z.preprocess((values) => pruneBlankOptionals(schema as unknown as ZodNode, values), schema) as unknown as T
    return this.validation
  }
}

/** AutoForm for a collection or singleton schema, rendered with the CMS field components. */
export function ContentForm(props: ContentFormProps) {
  const schema = useMemo(() => new CmsZodProvider(props.contentType.schema), [props.contentType.schema])
  const defaultValues = useMemo(
    () => unsetMissingOptionals(props.contentType.schema as unknown as ZodNode, props.defaultValues),
    [props.contentType.schema, props.defaultValues],
  )

  return (
    <AutoForm
      schema={schema}
      defaultValues={defaultValues}
      onSubmit={props.onSubmit}
      uiComponents={{
        ...uiComponents,
        ...props.uiComponents,
        // `readOnly` and `hidden` work with any field wrapper, including a custom one.
        FieldWrapper: withFieldState(props.uiComponents?.FieldWrapper ?? uiComponents.FieldWrapper),
      }}
      formComponents={{ ...formComponents, ...props.formComponents } as AutoFormFieldComponents}
      formProps={{ id: props.formId }}
    >
      {props.onValuesChange ? <ValuesSpy onChange={props.onValuesChange} /> : null}
      {props.children}
    </AutoForm>
  )
}
