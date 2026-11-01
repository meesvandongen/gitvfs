import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitProvider, RepositoryInfo } from 'gitvfs'
import { errorMessage } from './use-async.js'

export interface RepositoryPickerProps {
  /** Where to list repositories from, e.g. `github({ token })`. */
  provider: GitProvider
  onSelect: (repository: RepositoryInfo) => void
  /** Only offer repositories this returns true for, e.g. ones that contain your content. */
  filter?: (repository: RepositoryInfo) => boolean
  /** Shown above the list. Default: "Choose a repository" */
  title?: ReactNode
  /** Adds a Cancel button, e.g. to go back to the repository that was open before. */
  onCancel?: () => void
}

/** Flush the list to the screen every this many repositories while pages are still loading. */
const BATCH = 100

/**
 * Lists the repositories the signed-in account can reach and lets the user pick one. Pair it with
 * `provider.repository(picked.fullName)` to create the `GitVFS` for `createCms`.
 */
export function RepositoryPicker(props: RepositoryPickerProps) {
  const { provider } = props
  // A ref, so an inline `filter` function does not restart loading on every render.
  const filterRef = useRef(props.filter)
  filterRef.current = props.filter
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setRepositories([])
    setError(undefined)
    setLoading(true)
    void (async () => {
      const found: RepositoryInfo[] = []
      try {
        for await (const repository of provider.listRepositories({ signal: controller.signal })) {
          if (controller.signal.aborted) return
          if (filterRef.current && !filterRef.current(repository)) continue
          found.push(repository)
          if (found.length % BATCH === 0) setRepositories([...found])
        }
        if (!controller.signal.aborted) setRepositories(found)
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [provider, attempt])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return repositories
    return repositories.filter(
      (repository) =>
        repository.fullName.toLowerCase().includes(needle) ||
        (repository.description ?? '').toLowerCase().includes(needle),
    )
  }, [repositories, search])

  return (
    <div className="gcms-app gcms-app--picker">
      <main className="gcms-picker">
        <div className="gcms-picker-header">
          <div className="gcms-picker-title">
            <h1 className="gcms-document-title">{props.title ?? 'Choose a repository'}</h1>
            {props.onCancel ? (
              <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={props.onCancel}>
                Cancel
              </button>
            ) : null}
          </div>
          <input
            className="gcms-input"
            type="search"
            placeholder="Search repositories"
            aria-label="Search repositories"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {error !== undefined ? (
          <div className="gcms-error" role="alert">
            Could not list repositories: {errorMessage(error)}{' '}
            <button type="button" className="gcms-button gcms-button--small" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : null}

        <ul className="gcms-picker-list" aria-busy={loading}>
          {visible.map((repository) => (
            <li key={repository.fullName}>
              <button type="button" className="gcms-entry gcms-picker-item" onClick={() => props.onSelect(repository)}>
                <span className="gcms-entry-label">
                  {repository.fullName}
                  {repository.private ? <span className="gcms-badge">private</span> : null}
                </span>
                {repository.description ? <span className="gcms-entry-path">{repository.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>

        {loading ? <p className="gcms-muted">Loading repositories…</p> : null}
        {!loading && error === undefined && visible.length === 0 ? (
          <p className="gcms-muted">{repositories.length === 0 ? 'No repositories found for this account.' : 'No repositories match.'}</p>
        ) : null}
      </main>
    </div>
  )
}
