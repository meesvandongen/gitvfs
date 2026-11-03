import { createContext, useContext, useEffect, useState, type ComponentType } from 'react'
import { useFormState } from 'react-hook-form'
import { useFieldRHF } from '@autoform/react/react-hook-form'
import type { AutoFormFieldProps, FieldWrapperProps } from '@autoform/react'

// Shared by the field components. Not in ./autoform.js, which imports those components.

/** The form binding (`value`, `onChange`, `onBlur`, `name`, `ref`) of a field. */
export const useField = (name: string) => useFieldRHF({ name }).field

/** The options a field helper stored under `customData[key]`. */
export function fieldOptions<T extends object>(parsedField: AutoFormFieldProps['parsedField'], key: string): T {
  return ((parsedField.fieldConfig?.customData as Record<string, T> | undefined)?.[key] ?? {}) as T
}

/** Error messages of the parts of a field (`location.lat`, `price.amount`), which AutoForm does not show. */
export function useNestedErrors(name: string): string[] {
  const { errors } = useFormState({ name })
  let node: unknown = errors
  for (const key of name.split('.')) node = (node as Record<string, unknown> | undefined)?.[key]
  const messages: string[] = []
  const collect = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 4) return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'ref' || key === 'root') continue
      const message = (child as { message?: unknown } | undefined)?.message
      if (typeof message === 'string' && key !== 'message') messages.push(message)
      else collect(child, depth + 1)
    }
  }
  collect(node, 0)
  return [...new Set(messages)]
}

export function NestedErrors({ name }: { name: string }) {
  const messages = useNestedErrors(name)
  if (messages.length === 0) return null
  return (
    <p className="gcms-error" role="alert">
      {messages.join('. ')}
    </p>
  )
}

/**
 * Text typed into a number-like input, kept while it means the same value, so people can type
 * freely (`-`, `19,`) while the form holds the parsed value. Follows outside changes of `value`.
 */
export function useDraft<T>(value: T | undefined, format: (value: T) => string, parse: (text: string) => T | undefined) {
  const [draft, setDraft] = useState(value === undefined ? '' : format(value))
  useEffect(() => {
    setDraft((current) => (current.trim() !== '' && parse(current) === value ? current : value === undefined ? '' : format(value)))
    // `format` and `parse` are pure; only a new value should reset the draft.
  }, [value])
  return [draft, setDraft] as const
}

const ReadOnlyContext = createContext(false)

/**
 * True inside a read-only field (`field({ readOnly: true })`). Its native inputs and buttons are
 * already disabled; components that react to pointer gestures (such as maps) should ignore them.
 */
export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext)
}

interface FieldFlags {
  readOnly?: boolean
  hidden?: boolean
}

const withState = new WeakMap<ComponentType<FieldWrapperProps>, ComponentType<FieldWrapperProps>>()

/**
 * Add `readOnly` and `hidden` to a field wrapper. A hidden field renders nothing; the form keeps
 * its value and saves it. A read-only field sits in a disabled fieldset, which disables every
 * input and button inside it, whatever the field type.
 */
export function withFieldState(Wrapper: ComponentType<FieldWrapperProps>): ComponentType<FieldWrapperProps> {
  let wrapped = withState.get(Wrapper)
  if (!wrapped) {
    wrapped = function FieldStateWrapper(props: FieldWrapperProps) {
      const flags = (props.parsedField.fieldConfig?.customData ?? {}) as FieldFlags
      if (flags.hidden) return null
      if (!flags.readOnly) return <Wrapper {...props} />
      return (
        <fieldset className="gcms-readonly" disabled>
          <ReadOnlyContext.Provider value>
            <Wrapper {...props} />
          </ReadOnlyContext.Provider>
        </fieldset>
      )
    }
    withState.set(Wrapper, wrapped)
  }
  return wrapped
}

/** The form errors under `name` (an object mirroring the value), or `undefined`. */
export function useErrorTree(name: string): unknown {
  const { errors } = useFormState({ name })
  let node: unknown = errors
  for (const key of name.split('.')) node = (node as Record<string, unknown> | undefined)?.[key]
  return node
}

/** Every message in an error tree, including its own, without duplicates. */
export function errorMessages(tree: unknown): string[] {
  const messages: string[] = []
  const collect = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 6) return
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string') messages.push(message)
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'ref' && key !== 'message') collect(child, depth + 1)
    }
  }
  collect(tree, 0)
  return [...new Set(messages)]
}
