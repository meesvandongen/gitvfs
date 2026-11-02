import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ConflictError, type PullRequestInfo } from 'gitvfs'
import type { ContentChange } from '../cms.js'
import { changeTitle } from '../changes.js'
import { useChangeReview, useCms, useCmsState } from './context.js'
import { errorMessage, useAsync } from './use-async.js'

const STATUS_LABEL: Record<ContentChange['status'], string> = {
  added: 'New',
  modified: 'Edited',
  removed: 'Deleted',
  renamed: 'Renamed',
}

export function ChangeStatusBadge({ status }: { status: ContentChange['status'] }) {
  return <span className={`gcms-badge gcms-badge--${status}`}>{STATUS_LABEL[status]}</span>
}

/** Run one action at a time, keeping its error for display. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(
        caught instanceof ConflictError
          ? `${errorMessage(caught)}. Resolve the conflict on the host, then come back.`
          : errorMessage(caught),
      )
    } finally {
      setBusy(null)
    }
  }
  return { busy, error, run }
}

/** Sidebar control: which change is being edited, and starting a new one. */
export function ChangeSwitcher() {
  const cms = useCms()
  const state = useCmsState()
  const selectId = useId()
  const changes = useAsync(() => cms.listChanges(), [cms, state.version])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const action = useAction()
  const prefix = cms.changes?.branchPrefix ?? ''

  const options = changes.data ?? []
  const known = options.some((change) => change.branch === state.branch)

  const start = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    void action.run('Starting…', async () => {
      await cms.startChange(title)
      setCreating(false)
      setTitle('')
    })
  }

  return (
    <div className="gcms-change-switcher">
      <label className="gcms-nav-heading" htmlFor={selectId}>
        Editing
      </label>
      <select
        id={selectId}
        className="gcms-input"
        value={state.inChange ? state.branch : ''}
        disabled={action.busy !== null}
        // Pick up changes others started since the list loaded.
        onFocus={() => changes.reload()}
        onChange={(event) => void action.run('Switching…', () => cms.switchTo(event.target.value || null))}
      >
        <option value="">{state.base} (published)</option>
        {state.inChange && !known ? <option value={state.branch}>{changeTitle(prefix, state.branch)}</option> : null}
        {options.map((change) => (
          <option key={change.branch} value={change.branch}>
            {change.title}
            {change.pullRequest ? ` · #${change.pullRequest.number}` : ''}
          </option>
        ))}
      </select>
      {creating ? (
        <form className="gcms-change-new" onSubmit={start}>
          <input
            className="gcms-input"
            placeholder="What are you changing?"
            aria-label="Name of the change"
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <div className="gcms-change-new-actions">
            <button type="submit" className="gcms-button gcms-button--primary gcms-button--small" disabled={!title.trim() || action.busy !== null}>
              Start
            </button>
            <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="gcms-button gcms-button--small" onClick={() => setCreating(true)}>
          New change
        </button>
      )}
      {action.busy ? <p className="gcms-muted">{action.busy}</p> : null}
      {action.error ? <p className="gcms-error" role="alert">{action.error}</p> : null}
      {changes.error ? <p className="gcms-error" role="alert">Could not list changes: {errorMessage(changes.error)}</p> : null}
    </div>
  )
}

export interface ChangesViewProps {
  /** Open a changed entry or singleton. */
  onOpen: (change: ContentChange) => void
}

/** Review the current change: what it changed, its pull request, and publishing or discarding it. */
export function ChangesView(props: ChangesViewProps) {
  const cms = useCms()
  const state = useCmsState()
  const review = useChangeReview()
  const prefix = cms.changes?.branchPrefix ?? ''
  const repository = cms.fs.repository
  const supportsPulls = repository.listPullRequests !== undefined && repository.createPullRequest !== undefined
  const pull = useAsync(() => (supportsPulls ? cms.pullRequest() : Promise.resolve(null)), [cms, state.branch, state.version])
  const action = useAction()
  const title = changeTitle(prefix, state.branch)
  const comparison = review?.data
  const changes = comparison?.changes ?? []

  const publish = () => {
    if (!window.confirm(`Publish “${pull.data?.title ?? title}” to ${state.base}?`)) return
    void action.run('Publishing…', () => cms.publishChange())
  }
  const discard = () => {
    if (!window.confirm(`Discard “${title}”? Its branch${pull.data?.state === 'open' ? ' and pull request' : ''} will be closed.`)) return
    void action.run('Discarding…', () => cms.discardChange())
  }

  return (
    <div className="gcms-review">
      <header className="gcms-document-header">
        <div className="gcms-document-title">
          <h2>{pull.data?.title ?? title}</h2>
          <p className="gcms-muted">
            <code>{state.branch}</code> → <code>{state.base}</code>
            {comparison ? ` · ${comparison.ahead} commit${comparison.ahead === 1 ? '' : 's'}` : null}
          </p>
        </div>
        <div className="gcms-actions">
          {action.busy ? <span className="gcms-status">{action.busy}</span> : null}
          <button type="button" className="gcms-button gcms-button--danger" disabled={action.busy !== null} onClick={discard}>
            Discard change
          </button>
        </div>
      </header>

      {action.error ? <div className="gcms-notice gcms-error" role="alert">{action.error}</div> : null}

      {comparison && comparison.behind > 0 ? (
        <div className="gcms-notice gcms-review-behind" role="status">
          <span>
            {state.base} has {comparison.behind} newer commit{comparison.behind === 1 ? '' : 's'} that this change does not include yet.
          </span>
          <button
            type="button"
            className="gcms-button gcms-button--small"
            disabled={action.busy !== null}
            onClick={() => void action.run('Updating…', () => cms.updateChange())}
          >
            Update from {state.base}
          </button>
        </div>
      ) : null}

      <section className="gcms-review-section" aria-label="Review and publish">
        {supportsPulls ? (
          pull.loading && pull.data === undefined ? (
            <p className="gcms-muted">Looking for a pull request…</p>
          ) : pull.data && pull.data.state === 'open' ? (
            <PullRequestCard pull={pull.data} base={state.base} busy={action.busy !== null} onPublish={publish} onRefresh={() => pull.reload()} />
          ) : (
            <OpenPullRequestForm
              defaultTitle={title}
              previous={pull.data ?? null}
              disabled={changes.length === 0 || action.busy !== null}
              onSubmit={(values) => action.run('Opening pull request…', () => cms.openPullRequest(values))}
            />
          )
        ) : (
          <div className="gcms-card">
            <p>Publishing merges this change into {state.base}.</p>
            <button
              type="button"
              className="gcms-button gcms-button--primary"
              disabled={changes.length === 0 || action.busy !== null}
              onClick={publish}
            >
              Publish
            </button>
          </div>
        )}
      </section>

      <section className="gcms-review-section" aria-label="Changed content">
        <h3 className="gcms-review-heading">
          Changed content {comparison ? <span className="gcms-muted">({changes.length})</span> : null}
        </h3>
        {review?.loading && !comparison ? <p className="gcms-muted">Comparing with {state.base}…</p> : null}
        {review?.error ? <p className="gcms-error" role="alert">Could not compare: {errorMessage(review.error)}</p> : null}
        {comparison && changes.length === 0 ? (
          <p className="gcms-muted">Nothing changed yet. Edits you save now go into this change.</p>
        ) : null}
        <ul className="gcms-review-list">
          {changes.map((change) => {
            const openable = change.contentType !== undefined && change.status !== 'removed'
            return (
              <li key={change.path}>
                <button
                  type="button"
                  className="gcms-entry gcms-review-item"
                  disabled={!openable}
                  onClick={() => openable && props.onOpen(change)}
                >
                  <span className="gcms-review-item-main">
                    <ChangeStatusBadge status={change.status} />
                    <span className="gcms-entry-label">{change.label}</span>
                  </span>
                  <span className="gcms-entry-path">
                    {change.contentType ? `${change.contentType.label} · ` : 'Other file · '}
                    {change.previousPath ? `${change.previousPath} → ` : ''}
                    {change.path}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

function PullRequestCard(props: {
  pull: PullRequestInfo
  base: string
  busy: boolean
  onPublish: () => void
  onRefresh: () => void
}) {
  const { pull } = props
  const refresh = useRef(props.onRefresh)
  refresh.current = props.onRefresh
  // Hosts work out mergeability in the background; ask again shortly, after each answer.
  useEffect(() => {
    if (pull.mergeable !== null) return
    const timer = setTimeout(() => refresh.current(), 3000)
    return () => clearTimeout(timer)
  }, [pull])

  return (
    <div className="gcms-card">
      <div className="gcms-card-header">
        <span className="gcms-badge gcms-badge--open">{pull.draft ? 'Draft' : 'Open'}</span>
        <a href={pull.url} target="_blank" rel="noreferrer" className="gcms-card-title">
          #{pull.number} {pull.title}
        </a>
      </div>
      <p className="gcms-muted">
        {pull.author ? `Opened by ${pull.author}. ` : ''}
        {pull.mergeable === false
          ? `It conflicts with ${props.base}: resolve that in the pull request before publishing.`
          : pull.mergeable === null
            ? 'Checking whether it can be merged…'
            : `Ready to publish to ${props.base}.`}
      </p>
      <div className="gcms-actions">
        <a className="gcms-button" href={pull.url} target="_blank" rel="noreferrer">
          View pull request
        </a>
        <button
          type="button"
          className="gcms-button gcms-button--primary"
          disabled={props.busy || pull.mergeable === false || pull.draft}
          onClick={props.onPublish}
        >
          Publish
        </button>
      </div>
    </div>
  )
}

function OpenPullRequestForm(props: {
  defaultTitle: string
  previous: PullRequestInfo | null
  disabled: boolean
  onSubmit: (values: { title: string; body: string }) => Promise<void>
}) {
  const [title, setTitle] = useState(props.previous?.title ?? props.defaultTitle)
  const [body, setBody] = useState('')
  const id = useId()

  return (
    <form
      className="gcms-card"
      onSubmit={(event) => {
        event.preventDefault()
        void props.onSubmit({ title, body })
      }}
    >
      <p>
        {props.previous?.state === 'merged'
          ? <>Pull request <a href={props.previous.url} target="_blank" rel="noreferrer">#{props.previous.number}</a> was merged. Open another one for newer edits.</>
          : props.previous?.state === 'closed'
            ? <>Pull request <a href={props.previous.url} target="_blank" rel="noreferrer">#{props.previous.number}</a> was closed without publishing.</>
            : 'Ask for review: open a pull request, then publish it once it is approved.'}
      </p>
      <div className="gcms-field">
        <label className="gcms-label" htmlFor={`${id}-title`}>Title</label>
        <input id={`${id}-title`} className="gcms-input" value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="gcms-field">
        <label className="gcms-label" htmlFor={`${id}-body`}>Description</label>
        <textarea
          id={`${id}-body`}
          className="gcms-input gcms-textarea"
          rows={3}
          placeholder="What changed, and why?"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <div className="gcms-actions">
        <button type="submit" className="gcms-button gcms-button--primary" disabled={props.disabled || !title.trim()}>
          Open pull request
        </button>
      </div>
    </form>
  )
}
