import { useFormState } from 'react-hook-form'

// Helpers for field components that edit a whole object or list at once. AutoForm's wrapper only
// shows the error of the field's own path, not those of its parts.

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

/** Error messages of the parts of a field (`location.lat`, `area.2.lng`), which AutoForm does not show. */
export function useNestedErrors(name: string): string[] {
  const node = useErrorTree(name)
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
