import { useState, type ReactNode } from 'react'
import type { GitCms } from '../cms.js'
import type { Collection, EntrySummary } from '../config.js'
import { CmsProvider, useCms } from './context.js'
import { DocumentEditor, type DocumentEditorProps } from './DocumentEditor.js'
import { errorMessage, useAsync, type AsyncState } from './use-async.js'

export type CmsView =
  | { type: 'collection'; name: string; slug?: string | null }
  | { type: 'singleton'; name: string }

export interface CmsAppProps {
  cms: GitCms
  /** Shown at the top of the sidebar. */
  title?: ReactNode
  /** Shown at the bottom of the sidebar, e.g. the signed-in user and a sign-out button. */
  sidebarFooter?: ReactNode
  /** Custom rendered previews per collection or singleton name. */
  previews?: Record<string, DocumentEditorProps['renderPreview']>
  /** Controlled view; pair with `onViewChange` to sync it with your router. */
  view?: CmsView
  onViewChange?: (view: CmsView) => void
  uiComponents?: DocumentEditorProps['uiComponents']
  formComponents?: DocumentEditorProps['formComponents']
}

function firstView(cms: GitCms): CmsView | undefined {
  if (cms.collections[0]) return { type: 'collection', name: cms.collections[0].name }
  if (cms.singletons[0]) return { type: 'singleton', name: cms.singletons[0].name }
  return undefined
}

/** A complete editing UI: content types, entry lists, and the editor with live preview. */
export function CmsApp(props: CmsAppProps) {
  const [ownView, setOwnView] = useState<CmsView | undefined>(() => firstView(props.cms))
  const view = props.view ?? ownView
  const navigate = (next: CmsView) => {
    setOwnView(next)
    props.onViewChange?.(next)
  }

  return (
    <CmsProvider cms={props.cms}>
      <div className="gcms-app">
        <Sidebar title={props.title} footer={props.sidebarFooter} view={view} onNavigate={navigate} />
        {view === undefined ? (
          <main className="gcms-main gcms-empty">Configure a collection or singleton to start editing.</main>
        ) : view.type === 'collection' ? (
          <CollectionView {...props} view={view} onNavigate={navigate} />
        ) : (
          <main className="gcms-main">
            <DocumentEditor
              contentType={props.cms.getSingleton(view.name)}
              renderPreview={props.previews?.[view.name]}
              uiComponents={props.uiComponents}
              formComponents={props.formComponents}
            />
          </main>
        )}
      </div>
    </CmsProvider>
  )
}

function Sidebar(props: {
  title?: ReactNode
  footer?: ReactNode
  view?: CmsView
  onNavigate: (view: CmsView) => void
}) {
  const cms = useCms()
  const isActive = (type: CmsView['type'], name: string) =>
    props.view?.type === type && props.view.name === name

  return (
    <nav className="gcms-sidebar" aria-label="Content">
      <div className="gcms-brand">{props.title ?? 'Content'}</div>
      {cms.collections.length > 0 && (
        <div className="gcms-nav-group">
          <p className="gcms-nav-heading">Collections</p>
          {cms.collections.map((collection) => (
            <button
              key={collection.name}
              type="button"
              className="gcms-nav-item"
              aria-current={isActive('collection', collection.name) ? 'page' : undefined}
              onClick={() => props.onNavigate({ type: 'collection', name: collection.name })}
            >
              {collection.label}
            </button>
          ))}
        </div>
      )}
      {cms.singletons.length > 0 && (
        <div className="gcms-nav-group">
          <p className="gcms-nav-heading">Settings</p>
          {cms.singletons.map((singleton) => (
            <button
              key={singleton.name}
              type="button"
              className="gcms-nav-item"
              aria-current={isActive('singleton', singleton.name) ? 'page' : undefined}
              onClick={() => props.onNavigate({ type: 'singleton', name: singleton.name })}
            >
              {singleton.label}
            </button>
          ))}
        </div>
      )}
      {props.footer ? <div className="gcms-sidebar-footer">{props.footer}</div> : null}
    </nav>
  )
}

function CollectionView(
  props: CmsAppProps & {
    view: Extract<CmsView, { type: 'collection' }>
    onNavigate: (view: CmsView) => void
  },
) {
  const { cms, view } = props
  const collection = cms.getCollection(view.name)
  const entries = useAsync(() => cms.listEntries(collection.name), [cms, collection])
  const open = (slug: string | null | undefined) =>
    props.onNavigate({ type: 'collection', name: collection.name, slug })

  return (
    <>
      <EntryList
        collection={collection}
        entries={entries}
        activeSlug={view.slug}
        onOpen={open}
      />
      <main className="gcms-main">
        {view.slug === undefined ? (
          <div className="gcms-empty">
            Select an entry or{' '}
            <button type="button" className="gcms-link" onClick={() => open(null)}>
              create a new one
            </button>
            .
          </div>
        ) : (
          <DocumentEditor
            contentType={collection}
            slug={view.slug}
            renderPreview={props.previews?.[collection.name]}
            uiComponents={props.uiComponents}
            formComponents={props.formComponents}
            onSaved={(saved) => {
              entries.reload()
              if (saved.slug !== view.slug) open(saved.slug)
            }}
            onDeleted={() => {
              entries.reload()
              open(undefined)
            }}
          />
        )}
      </main>
    </>
  )
}

function EntryList(props: {
  collection: Collection
  entries: AsyncState<EntrySummary[]>
  activeSlug?: string | null
  onOpen: (slug: string | null) => void
}) {
  const { collection, entries } = props
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const visible = (entries.data ?? []).filter(
    (entry) => !needle || entry.label.toLowerCase().includes(needle) || entry.slug.includes(needle),
  )

  return (
    <section className="gcms-list" aria-label={`${collection.label} entries`}>
      <div className="gcms-list-header">
        <h2>{collection.label}</h2>
        <button type="button" className="gcms-button gcms-button--primary gcms-button--small" onClick={() => props.onOpen(null)}>
          New
        </button>
      </div>
      <input
        type="search"
        className="gcms-input"
        placeholder="Filter…"
        aria-label="Filter entries"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {entries.loading && !entries.data ? <p className="gcms-muted">Loading…</p> : null}
      {entries.error ? (
        <p className="gcms-error" role="alert">
          {errorMessage(entries.error)}
        </p>
      ) : null}
      {entries.data && visible.length === 0 ? <p className="gcms-muted">No entries.</p> : null}
      <ul className="gcms-entries">
        {visible.map((entry) => (
          <li key={entry.slug}>
            <button
              type="button"
              className="gcms-entry"
              aria-current={entry.slug === props.activeSlug ? 'page' : undefined}
              onClick={() => props.onOpen(entry.slug)}
            >
              <span className="gcms-entry-label">{entry.label}</span>
              <span className="gcms-entry-path">{entry.slug}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
