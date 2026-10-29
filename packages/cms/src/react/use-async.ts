import { useCallback, useEffect, useState, type DependencyList } from 'react'

export interface AsyncState<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => void
}

/** Run `load` whenever `deps` change; results of stale runs are ignored. */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<Omit<AsyncState<T>, 'reload'>>({
    data: undefined,
    error: undefined,
    loading: true,
  })

  useEffect(() => {
    let cancelled = false
    setState((previous) => ({ ...previous, loading: true }))
    load().then(
      (data) => !cancelled && setState({ data, error: undefined, loading: false }),
      (error: unknown) => !cancelled && setState({ data: undefined, error, loading: false }),
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version])

  const reload = useCallback(() => setVersion((v) => v + 1), [])
  return { ...state, reload }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
