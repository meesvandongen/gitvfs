import { useMemo, useState, type ReactNode } from 'react'
import { Marked } from 'marked'
import { diffLines } from '../changes.js'
import type { ContentType } from '../config.js'
import { serializeDocument } from '../document.js'
import { pruneBlankOptionals } from './autoform.js'

const marked = new Marked({ gfm: true })

export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// The frame is sandboxed without allow-scripts, so content from the repository can never run
// code next to the access token. The CSP is a second line of defence.
const PREVIEW_CSP =
  "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src * 'unsafe-inline'; font-src * data:"

const DEFAULT_PREVIEW_STYLES = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.65 system-ui, sans-serif; max-width: 46rem; margin: 0 auto; padding: 1.5rem; }
  img, video { max-width: 100%; }
  pre { overflow: auto; padding: 1rem; border-radius: 6px; background: rgba(127, 127, 127, 0.12); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid rgba(127, 127, 127, 0.4); }
  table { border-collapse: collapse; } td, th { border: 1px solid rgba(127, 127, 127, 0.4); padding: 0.3rem 0.6rem; }
`

export interface PreviewDocumentOptions {
  html: string
  stylesheets?: string[]
  /** Resolve relative links and images in the content against this URL. */
  baseUrl?: string
}

/** Build the standalone HTML document shown in the preview frame. */
export function buildPreviewDocument({ html, stylesheets = [], baseUrl }: PreviewDocumentOptions): string {
  const links = stylesheets
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('')
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    baseUrl ? `<base href="${escapeHtml(baseUrl)}">` : '',
    stylesheets.length ? links : `<style>${DEFAULT_PREVIEW_STYLES}</style>`,
    `</head><body><article>${html}</article></body></html>`,
  ].join('')
}

export interface PreviewFrameProps extends PreviewDocumentOptions {
  title?: string
}

/** Render untrusted HTML in a sandboxed iframe. */
export function PreviewFrame({ title = 'Preview', ...options }: PreviewFrameProps) {
  const srcDoc = useMemo(() => buildPreviewDocument(options), [options.html, options.baseUrl, options.stylesheets?.join('\n')])
  return <iframe className="gcms-preview-frame" title={title} sandbox="" srcDoc={srcDoc} />
}

/** Split raw form values into the file the CMS would write. */
/** Fields cleared in the form hold null; saving drops them, so the source should not show them. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls)
  if (value === null || typeof value !== 'object' || value instanceof Date) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) if (entry !== null) result[key] = withoutNulls(entry)
  return result
}

export function toSource(contentType: ContentType, values: Record<string, unknown>): string {
  // Show what a save writes: cleared values and optional groups left blank are dropped there too.
  values = pruneBlankOptionals(contentType.schema as never, withoutNulls(values)) as Record<string, unknown>
  // Form values arrive in no particular order; show fields in schema order.
  const ordered: Record<string, unknown> = {}
  for (const key of Object.keys(contentType.schema.shape)) if (key in values) ordered[key] = values[key]
  values = { ...ordered, ...values }
  try {
    if (contentType.format !== 'markdown') {
      return serializeDocument(contentType.format, { data: values, body: '' })
    }
    const { [contentType.bodyField]: body, ...data } = values
    return serializeDocument('markdown', { data, body: typeof body === 'string' ? body : '' })
  } catch (error) {
    return `Cannot serialize: ${(error as Error).message}`
  }
}

export interface PreviewProps {
  contentType: ContentType
  values: Record<string, unknown>
}

/** Default rendered preview: the title as a heading followed by the markdown body. */
export function MarkdownPreview({ contentType, values }: PreviewProps) {
  const title = values.title
  const body = values[contentType.bodyField]
  const html = useMemo(
    () =>
      (typeof title === 'string' && title ? `<h1>${escapeHtml(title)}</h1>` : '')
      + renderMarkdown(typeof body === 'string' ? body : ''),
    [title, body],
  )
  return (
    <PreviewFrame html={html} stylesheets={contentType.previewStylesheets} baseUrl={contentType.previewBaseUrl} />
  )
}

export interface PreviewComparison {
  /** The document on the base branch; `null` when it is new in this change. */
  values: Record<string, unknown> | null
  /** The base branch's name, e.g. `main`. */
  label: string
}

export interface DocumentPreviewProps extends PreviewProps {
  /** Replaces the rendered tab, e.g. with your site's own components. */
  render?: (props: PreviewProps) => ReactNode
  /** Adds a Changes tab comparing `values` with this version. */
  compare?: PreviewComparison
}

/** The serialized source of both versions, line by line. */
export function SourceDiff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after])
  const marks = { same: ' ', added: '+', removed: '−' } as const
  return (
    <pre className="gcms-source gcms-diff" aria-label="Changes to the file">
      {lines.map((line, index) => (
        <span key={index} className={`gcms-diff-line gcms-diff-line--${line.kind}`}>
          <span className="gcms-diff-mark" aria-hidden="true">{marks[line.kind]}</span>
          {line.kind === 'same' ? null : <span className="gcms-visually-hidden">{line.kind === 'added' ? 'Added: ' : 'Removed: '}</span>}
          {line.text || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}

/**
 * Before and after: both versions rendered with the same preview (side by side when there is room),
 * so any field type compares the way readers will see it. Falls back to the source when nothing
 * renders.
 */
export function PreviewComparisonView({
  contentType,
  values,
  render,
  compare,
}: PreviewProps & { render?: DocumentPreviewProps['render']; compare: PreviewComparison }) {
  const hasRendered = Boolean(render) || contentType.format === 'markdown'
  const [mode, setMode] = useState<'rendered' | 'source'>(hasRendered ? 'rendered' : 'source')
  const active = hasRendered ? mode : 'source'
  const show = (props: PreviewProps) => (render ? render(props) : <MarkdownPreview {...props} />)

  return (
    <div className="gcms-compare">
      <div className="gcms-compare-toolbar">
        {hasRendered ? (
          <div className="gcms-segmented" role="group" aria-label="Compare">
            <button type="button" aria-pressed={active === 'rendered'} onClick={() => setMode('rendered')}>
              Before &amp; after
            </button>
            <button type="button" aria-pressed={active === 'source'} onClick={() => setMode('source')}>
              Source changes
            </button>
          </div>
        ) : null}
        {compare.values === null ? <span className="gcms-muted">New in this change</span> : null}
      </div>
      {active === 'source' ? (
        <SourceDiff before={compare.values ? toSource(contentType, compare.values) : ''} after={toSource(contentType, values)} />
      ) : (
        <div className="gcms-compare-sides">
          <section className="gcms-compare-side" aria-label={`On ${compare.label}`}>
            <p className="gcms-compare-label">On {compare.label}</p>
            <div className="gcms-compare-body">
              {compare.values ? show({ contentType, values: compare.values }) : <p className="gcms-empty">Not on {compare.label} yet.</p>}
            </div>
          </section>
          <section className="gcms-compare-side" aria-label="In this change">
            <p className="gcms-compare-label">In this change</p>
            <div className="gcms-compare-body">{show({ contentType, values })}</div>
          </section>
        </div>
      )}
    </div>
  )
}

/** Tabs with the rendered page (markdown only, or `render`), the file source, and with `compare` the changes. */
export function DocumentPreview({ contentType, values, render, compare }: DocumentPreviewProps) {
  const hasRendered = Boolean(render) || contentType.format === 'markdown'
  const [tab, setTab] = useState<'rendered' | 'source' | 'changes'>(hasRendered ? 'rendered' : 'source')
  const active = tab === 'changes' ? (compare ? 'changes' : hasRendered ? 'rendered' : 'source') : hasRendered ? tab : 'source'

  return (
    <div className="gcms-preview">
      <div className="gcms-tabs" role="tablist">
        {hasRendered && (
          <button
            type="button"
            role="tab"
            aria-selected={active === 'rendered'}
            className="gcms-tab"
            onClick={() => setTab('rendered')}
          >
            Preview
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={active === 'source'}
          className="gcms-tab"
          onClick={() => setTab('source')}
        >
          Source
        </button>
        {compare ? (
          <button
            type="button"
            role="tab"
            aria-selected={active === 'changes'}
            className="gcms-tab"
            onClick={() => setTab('changes')}
          >
            Changes
          </button>
        ) : null}
      </div>
      <div className="gcms-preview-body" role="tabpanel">
        {active === 'changes' && compare ? (
          <PreviewComparisonView contentType={contentType} values={values} render={render} compare={compare} />
        ) : active === 'source' ? (
          <pre className="gcms-source">{toSource(contentType, values)}</pre>
        ) : render ? (
          render({ contentType, values })
        ) : (
          <MarkdownPreview contentType={contentType} values={values} />
        )}
      </div>
    </div>
  )
}
