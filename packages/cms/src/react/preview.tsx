import { useMemo, useState, type ReactNode } from 'react'
import { Marked } from 'marked'
import type { ContentType } from '../config.js'
import { serializeDocument } from '../document.js'

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
export function toSource(contentType: ContentType, values: Record<string, unknown>): string {
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

export interface DocumentPreviewProps extends PreviewProps {
  /** Replaces the rendered tab, e.g. with your site's own components. */
  render?: (props: PreviewProps) => ReactNode
}

/** Tabs with the rendered page (markdown only, or `render`) and the file source. */
export function DocumentPreview({ contentType, values, render }: DocumentPreviewProps) {
  const hasRendered = Boolean(render) || contentType.format === 'markdown'
  const [tab, setTab] = useState<'rendered' | 'source'>(hasRendered ? 'rendered' : 'source')
  const active = hasRendered ? tab : 'source'

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
      </div>
      <div className="gcms-preview-body" role="tabpanel">
        {active === 'source' ? (
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
