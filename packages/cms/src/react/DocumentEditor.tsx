import { useDeferredValue, useId, useMemo, useState, type ReactNode } from 'react'
import type { LoadedDocument } from '../cms.js'
import type { ContentType } from '../config.js'
import { isValidSlug, slugify } from '../slug.js'
import { ContentForm, type ContentFormProps } from './autoform.js'
import { useCms, useCmsState } from './context.js'
import { BaseValuesContext } from './field-changes.js'
import { mermaidRendererOf } from './mermaid.js'
import { DocumentPreview, type PreviewProps } from './preview.js'
import { errorMessage, useAsync } from './use-async.js'

export interface SavedDocument {
  path: string
  commitSha: string
  /** New slug of a collection entry. */
  slug?: string
}

export interface DocumentEditorProps {
  contentType: ContentType
  /** Collection entries only: the slug to edit, or `null` for a new entry. */
  slug?: string | null
  onSaved?: (saved: SavedDocument) => void
  onDeleted?: () => void
  /** Replace the rendered preview, e.g. with your site's components. */
  renderPreview?: (props: PreviewProps) => ReactNode
  uiComponents?: ContentFormProps['uiComponents']
  formComponents?: ContentFormProps['formComponents']
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'saved'; sha: string }
  | { kind: 'error'; message: string }

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const NEW_DOCUMENT: LoadedDocument = { path: '', exists: false, data: {}, issues: [] }

/** Load, edit, preview and commit one document. */
export function DocumentEditor(props: DocumentEditorProps) {
  const cms = useCms()
  const { branch, inChange } = useCmsState()
  const { contentType } = props
  const isEntry = contentType.kind === 'collection'
  const slug = isEntry ? (props.slug ?? null) : null

  const document = useAsync<LoadedDocument>(async () => {
    if (contentType.kind === 'singleton') return cms.readSingleton(contentType.name)
    return slug === null ? NEW_DOCUMENT : cms.readEntry(contentType.name, slug)
  }, [cms, contentType, slug, branch])

  // Inside a change: the published version, to compare against. `null` when it is new.
  const base = useAsync<LoadedDocument | null | undefined>(async () => {
    if (!inChange) return undefined
    if (contentType.kind === 'singleton') return cms.readBaseSingleton(contentType.name)
    return slug === null ? null : cms.readBaseEntry(contentType.name, slug)
  }, [cms, contentType, slug, branch, inChange])

  if (document.loading && !document.data) {
    return <div className="gcms-empty">Loading…</div>
  }
  if (document.error || !document.data) {
    return (
      <div className="gcms-empty gcms-error" role="alert">
        Could not load this document: {errorMessage(document.error)}
      </div>
    )
  }

  return (
    <LoadedEditor
      key={`${branch}:${contentType.name}:${slug ?? ''}:${document.data.path}`}
      {...props}
      slug={slug}
      document={document.data}
      // While loading, `data` can still be the previous document's.
      base={base.loading ? undefined : base.data}
    />
  )
}

function LoadedEditor(
  props: DocumentEditorProps & {
    slug: string | null
    document: LoadedDocument
    /** The base branch's version inside a change (`null` when new there), else `undefined`. */
    base: LoadedDocument | null | undefined
  },
) {
  const cms = useCms()
  const state = useCmsState()
  const editable = cms.canEdit()
  const { contentType, document, base } = props
  const isEntry = contentType.kind === 'collection'
  const formId = useId()

  const [values, setValues] = useState<Record<string, unknown>>(document.data)
  const [baseline, setBaseline] = useState<string | null>(null)
  const [slugInput, setSlugInput] = useState(props.slug ?? '')
  const [slugTouched, setSlugTouched] = useState(props.slug !== null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // What is wrong with the file as stored. A save only succeeds with values that pass the schema,
  // so the stored file is valid from then on.
  const [storedIssues, setStoredIssues] = useState(document.issues)
  const previewValues = useDeferredValue(values)
  // The base version as the form would hold it: with the schema's defaults filled in, so a
  // default the file leaves out does not count as a change.
  const baseFormValues = useMemo(() => {
    if (!base) return base
    const parsed = contentType.schema.safeParse(base.data)
    return parsed.success ? { ...base.data, ...(parsed.data as Record<string, unknown>) } : base.data
  }, [base, contentType])
  const baseValues = useMemo(
    () => (baseFormValues ? { values: baseFormValues, label: state.base } : null),
    [baseFormValues, state.base],
  )
  const compare = baseFormValues === undefined ? undefined : { values: baseFormValues, label: state.base }

  const snapshot = JSON.stringify(values)
  const dirty = baseline !== null && baseline !== snapshot
  const busy = status.kind === 'busy'

  const derivedSlug =
    contentType.kind === 'collection' && !slugTouched
      ? slugify(asText(values[contentType.slugField]))
      : slugInput
  const slugError = isEntry && derivedSlug && !isValidSlug(derivedSlug)
    ? 'Use letters, digits, dots, dashes and underscores'
    : null

  const handleValues = (next: Record<string, unknown>) => {
    setValues(next)
    setBaseline((current) => current ?? JSON.stringify(next))
  }

  const save = async (data: Record<string, unknown>) => {
    if (isEntry && (!derivedSlug || slugError)) {
      setStatus({ kind: 'error', message: slugError ?? 'Enter a slug for this entry' })
      return
    }
    setStatus({ kind: 'busy', message: 'Committing…' })
    try {
      const result = contentType.kind === 'collection'
        ? await cms.saveEntry(contentType.name, {
          slug: derivedSlug,
          data,
          previousSlug: props.slug ?? undefined,
        })
        : await cms.saveSingleton(contentType.name, data)
      setBaseline(snapshot)
      setStoredIssues([])
      setSlugInput(derivedSlug)
      setSlugTouched(true)
      setStatus({ kind: 'saved', sha: result.commit.sha })
      props.onSaved?.({
        path: result.path,
        commitSha: result.commit.sha,
        slug: isEntry ? derivedSlug : undefined,
      })
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) })
    }
  }

  const remove = async () => {
    if (props.slug === null || !window.confirm(`Delete ${document.path}? This creates a commit.`)) return
    setStatus({ kind: 'busy', message: 'Deleting…' })
    try {
      await cms.deleteEntry(contentType.name, props.slug)
      props.onDeleted?.()
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) })
    }
  }

  const heading = isEntry
    ? props.slug === null ? 'New entry' : asText(values[contentType.labelField]) || props.slug
    : contentType.label

  return (
    <div className="gcms-document">
      <header className="gcms-document-header">
        <div className="gcms-document-title">
          <h2>{heading}</h2>
          <p className="gcms-muted">
            {contentType.kind === 'collection'
              ? `${contentType.folder ? `${contentType.folder}/` : ''}${derivedSlug || '{slug}'}.${contentType.extension}`
              : document.path}
            {dirty ? <span className="gcms-badge">Unsaved</span> : null}
            {base === null && document.exists ? <span className="gcms-badge gcms-badge--added">New in this change</span> : null}
          </p>
        </div>
        <div className="gcms-actions">
          <StatusText status={status} />
          {isEntry && props.slug !== null && (
            <button type="button" className="gcms-button gcms-button--danger" disabled={busy || !editable} onClick={remove}>
              Delete
            </button>
          )}
          <button type="submit" form={formId} className="gcms-button gcms-button--primary" disabled={busy || !editable}>
            {props.slug === null && isEntry ? 'Create' : 'Save'}
          </button>
        </div>
      </header>

      {!editable && (
        <div className="gcms-notice" role="status">
          {state.base} is published content. Start a change in the sidebar to edit it.
        </div>
      )}

      {storedIssues.length > 0 && (
        <div className="gcms-notice" role="status">
          The stored file does not match the schema:{' '}
          {storedIssues.map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`).join('; ')}
        </div>
      )}

      <div className="gcms-panes">
        <div className="gcms-pane gcms-pane--form">
          {isEntry && (
            <div className="gcms-field">
              <label className="gcms-label" htmlFor={`${formId}-slug`}>
                Slug
              </label>
              <input
                id={`${formId}-slug`}
                className="gcms-input"
                value={derivedSlug}
                aria-invalid={slugError ? true : undefined}
                onChange={(event) => {
                  setSlugTouched(true)
                  setSlugInput(event.target.value)
                }}
              />
              <p className={slugError ? 'gcms-error' : 'gcms-description'}>
                {slugError ?? 'File name of the entry.'}
              </p>
            </div>
          )}
          <BaseValuesContext.Provider value={baseValues}>
            <ContentForm
              contentType={contentType}
              defaultValues={document.data}
              onSubmit={save}
              onValuesChange={handleValues}
              formId={formId}
              uiComponents={props.uiComponents}
              formComponents={props.formComponents}
            />
          </BaseValuesContext.Provider>
        </div>
        <div className="gcms-pane gcms-pane--preview">
          <DocumentPreview
            contentType={contentType}
            values={previewValues}
            render={props.renderPreview}
            renderMermaid={mermaidRendererOf(props.formComponents)}
            compare={compare}
          />
        </div>
      </div>
    </div>
  )
}

function StatusText({ status }: { status: Status }) {
  switch (status.kind) {
    case 'idle':
      return null
    case 'busy':
      return <span className="gcms-status">{status.message}</span>
    case 'saved':
      return <span className="gcms-status gcms-status--ok">Committed {status.sha.slice(0, 7)}</span>
    case 'error':
      return (
        <span className="gcms-status gcms-status--error" role="alert">
          {status.message}
        </span>
      )
  }
}
