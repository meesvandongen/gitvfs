import { useFormState } from 'react-hook-form'

/** Error messages of the parts of a field (`location.lat`, `area.2.lng`), which AutoForm does not show. */
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
