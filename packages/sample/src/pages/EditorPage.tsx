import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext, useSearch } from '@tanstack/react-router'
import { useMemo, useState, useTransition } from 'react'
import { AsyncBoundary } from '../components/AsyncBoundary'
import {
  getDirectoryQueryOptions,
  getFileTextQueryOptions,
  getGitFs,
  saveFileAndCommit,
  type RepoSelection,
  type RepoSession,
  updateCachedFileText,
} from '../lib/git-data'

export function EditorPage() {
  const repoSelection = useSearch({ from: '/editor' }) as RepoSelection
  const { token } = useRouteContext({ from: '/editor' }) as { token: string }
  const session = useMemo(() => ({ ...repoSelection, token }), [repoSelection, token])

  return <EditorPageContent key={getRepoResetKey(session)} session={session} />
}

function getRepoResetKey(session: RepoSession): string {
  return session.kind === 'github'
    ? `github:${session.owner}/${session.repo}:${session.branch}`
    : `gitlab:${session.projectId}:${session.branch}`
}

function EditorPageContent(props: { session: RepoSession }) {
  const { session } = props
  const navigate = useNavigate({ from: '/editor' })

  const [directoryPath, setDirectoryPath] = useState('')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isNavigating, startNavigation] = useTransition()

  const repoLabel = session.kind === 'github'
    ? `${session.owner}/${session.repo}`
    : session.name

  const parentPath = useMemo(() => {
    if (directoryPath === '') {
      return null
    }

    const index = directoryPath.lastIndexOf('/')
    return index === -1 ? '' : directoryPath.slice(0, index)
  }, [directoryPath])

  return (
    <section className="editor-layout">
      <header className="section-heading editor-heading">
        <div>
          <p className="eyebrow">Saved Token</p>
          <h1 className="section-title">{repoLabel}</h1>
          <p className="section-copy">Branch: {session.branch}</p>
        </div>
        <div className="editor-heading-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate({ to: '/repositories' })}>
            ← Repositories
          </button>
          {isNavigating ? <span className="status-pill">Loading…</span> : null}
        </div>
      </header>

      {statusMessage ? <div className="callout callout-success">{statusMessage}</div> : null}

      <div className="app-body">
        <aside className={`sidebar${isNavigating ? ' pane-pending' : ''}`}>
          <div className="sidebar-header">
            <span className="breadcrumb">{directoryPath ? `/ ${directoryPath}` : '/ (root)'}</span>
          </div>
          <AsyncBoundary
            resetKey={directoryPath}
            fallback={(
              <div className="loading-inline">
                <div className="spinner spinner-sm"></div>
                Loading directory…
              </div>
            )}
            errorTitle="Could not load this directory."
          >
            <DirectoryPane
              session={session}
              directoryPath={directoryPath}
              parentPath={parentPath}
              selectedFile={selectedFile}
              onSelectDirectory={(path) => {
                setStatusMessage(null)
                startNavigation(() => {
                  setDirectoryPath(path)
                  setSelectedFile(null)
                })
              }}
              onSelectFile={(path) => {
                setStatusMessage(null)
                startNavigation(() => {
                  setSelectedFile(path)
                })
              }}
            />
          </AsyncBoundary>
        </aside>

        <main className={`editor-pane${isNavigating ? ' pane-pending' : ''}`}>
          {selectedFile === null ? (
            <div className="editor-empty">
              <p>Select a file to read or edit its contents.</p>
            </div>
          ) : (
            <AsyncBoundary
              resetKey={selectedFile}
              fallback={(
                <div className="loading-inline">
                  <div className="spinner spinner-sm"></div>
                  Loading file…
                </div>
              )}
              errorTitle="Could not load this file."
            >
              <FileEditorPane
                key={selectedFile}
                session={session}
                path={selectedFile}
                onStatusChange={setStatusMessage}
              />
            </AsyncBoundary>
          )}
        </main>
      </div>
    </section>
  )
}

function DirectoryPane(props: {
  session: RepoSession
  directoryPath: string
  parentPath: string | null
  selectedFile: string | null
  onSelectDirectory: (path: string) => void
  onSelectFile: (path: string) => void
}) {
  const queryClient = useQueryClient()
  const { data: entries } = useSuspenseQuery(
    getDirectoryQueryOptions(props.session, props.directoryPath),
  )

  return (
    <div className="file-list">
      {props.parentPath !== null && (
        <button type="button" className="file-item file-item-dir" onClick={() => props.onSelectDirectory(props.parentPath!)}>
          <span>..</span>
        </button>
      )}
      {entries.map((entry) => {
        const path = props.directoryPath ? `${props.directoryPath}/${entry.name}` : entry.name
        const isActive = props.selectedFile === path

        return (
          <button
            key={path}
            type="button"
            className={`file-item ${entry.type === 'tree' ? 'file-item-dir' : 'file-item-file'} ${isActive ? 'file-item-active' : ''}`}
            onClick={() => (entry.type === 'tree' ? props.onSelectDirectory(path) : props.onSelectFile(path))}
            onMouseEnter={() => {
              const prefetch = entry.type === 'tree'
                ? queryClient.prefetchQuery(getDirectoryQueryOptions(props.session, path))
                : queryClient.prefetchQuery(getFileTextQueryOptions(props.session, path))

              prefetch.catch(() => {
                // Ignore warm-up failures.
              })
            }}
          >
            <span>{entry.name}</span>
          </button>
        )
      })}
      {entries.length === 0 ? <div className="file-list-empty">No entries found.</div> : null}
    </div>
  )
}

function FileEditorPane(props: {
  session: RepoSession
  path: string
  onStatusChange: (message: string | null) => void
}) {
  const queryClient = useQueryClient()
  const { data: originalContent } = useSuspenseQuery(
    getFileTextQueryOptions(props.session, props.path),
  )
  const [draftContent, setDraftContent] = useState(originalContent)

  const saveMutation = useMutation({
    mutationFn: async (content: string) => {
      await saveFileAndCommit({
        fs: getGitFs(props.session),
        path: props.path,
        content,
      })
      return content
    },
    onSuccess: (content) => {
      updateCachedFileText(queryClient, props.session, props.path, content)
      props.onStatusChange(`Committed changes to ${props.path}`)
    },
    onError: (error) => {
      props.onStatusChange(null)
      throw error
    },
  })

  const isDirty = draftContent !== originalContent

  return (
    <div className="editor-content">
      <div className="editor-toolbar">
        <span className="file-path-label">{props.path}</span>
        <div className="editor-heading-actions">
          <span className="helper-copy">{isDirty ? 'Unsaved changes' : 'All changes committed'}</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!isDirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate(draftContent)}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save & Commit'}
          </button>
        </div>
      </div>
      {saveMutation.error instanceof Error ? (
        <div className="callout callout-danger">{saveMutation.error.message}</div>
      ) : null}
      <textarea
        className="file-editor"
        spellCheck={false}
        value={draftContent}
        onChange={(event) => setDraftContent(event.target.value)}
      />
    </div>
  )
}
