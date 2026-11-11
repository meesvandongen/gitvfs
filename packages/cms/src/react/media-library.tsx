import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { fileName, formatBytes, isImagePath, uploadError } from '../media.js'
import { describeMediaUsage, type MediaFile, type MediaLibraryFolder, type MediaUsage } from '../media-library.js'
import type { CmsView } from './CmsApp.js'
import { useChangeReview, useCms, useCmsState } from './context.js'
import { describeLimits, download, FileIcon, MediaTile, Thumbnail, useFileDrop, useFilePicker } from './media-parts.js'
import { MediaProvider, MediaStore } from './media-store.js'
import { errorMessage, useAsync, type AsyncState } from './use-async.js'

/** The media library's place in `CmsView`: a folder, and the file whose details are open. */
export type MediaView = Extract<CmsView, { type: 'media' }>

export interface MediaLibraryViewProps {
  view: MediaView
  /** Open another folder or file, or (from "Used in") an entry or singleton. */
  onNavigate: (view: CmsView) => void
}

/**
 * Browse, upload, inspect and delete the files of the media folders, on the branch being edited.
 * Uploads and deletes are commits of their own; `CmsApp` shows it under **Media**.
 */
export function MediaLibraryView({ view, onNavigate }: MediaLibraryViewProps) {
  const cms = useCms()
  const folders = cms.mediaFolders()
  // Thumbnails and downloads are read through the CMS, so private repositories work too.
  const store = useMemo(() => new MediaStore(cms, folders), [cms, folders])
  const folder = folders.find((entry) => entry.folder === view.folder) ?? folders[0]

  if (!folder) return <div className="gcms-empty">No media folders: add an image or file field, or the `media` option.</div>
  return (
    <MediaProvider store={store}>
      <FolderView key={folder.folder} store={store} folder={folder} folders={folders} path={view.path} onNavigate={onNavigate} />
    </MediaProvider>
  )
}

function FolderView({ store, folder, folders, path, onNavigate }: {
  store: MediaStore
  folder: MediaLibraryFolder
  folders: MediaLibraryFolder[]
  path?: string
  onNavigate: (view: CmsView) => void
}) {
  const cms = useCms()
  const state = useCmsState()
  const editable = cms.canEdit()
  const listing = useAsync(() => cms.listMedia(folder.folder), [cms, folder, state.branch, state.version])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [announcement, setAnnouncement] = useState('')
  const changed = useChangedMedia()

  const grid = useRef<HTMLUListElement | null>(null)
  const open = (next: { folder?: string; path?: string }) =>
    onNavigate({ type: 'media', folder: next.folder ?? folder.folder, ...(next.path ? { path: next.path } : {}) })
  const closeDetails = () => {
    const closing = path
    open({})
    // Back to the file's tile, where keyboard users were before the details opened.
    setTimeout(() => {
      const items = [...(grid.current?.querySelectorAll<HTMLElement>('li') ?? [])]
      items.find((item) => item.dataset.path === closing)?.querySelector('button')?.focus()
    })
  }

  const upload = async (files: File[]) => {
    if (!editable) return
    const problems = files.map((file) => uploadError(folder, file)).filter((problem) => problem !== undefined)
    const accepted = files.filter((file) => uploadError(folder, file) === undefined)
    setErrors(problems)
    setAnnouncement('')
    if (accepted.length === 0) return
    setBusy(`Uploading ${accepted.length === 1 ? accepted[0].name : `${accepted.length} files`}…`)
    try {
      const uploads = await Promise.all(accepted.map(async (file) => ({ name: file.name, content: new Uint8Array(await file.arrayBuffer()) })))
      const result = await cms.uploadMedia(folder.folder, uploads)
      // A path can be one a deleted file had; its old content must not show.
      for (const uploaded of result.paths) store.forget(uploaded)
      const names = result.paths.map(fileName)
      setAnnouncement(`Uploaded ${names.length === 1 ? names[0] : `${names.length} files`} in commit ${result.commit.sha.slice(0, 7)}.`)
      if (result.paths.length === 1) open({ path: result.paths[0] })
    } catch (error) {
      setErrors((current) => [...current, errorMessage(error)])
    } finally {
      setBusy(null)
    }
  }

  const remove = async (file: MediaFile, usage: MediaUsage[] | null) => {
    const warning = usage === null
      ? '\n\nIt could not be checked whether content uses it.'
      : usage.length > 0 ? `\n\n${describeMediaUsage(usage)} They will point at a missing file.` : ''
    if (!window.confirm(`Delete ${file.path}? This creates a commit.${warning}`)) return
    setErrors([])
    setAnnouncement('')
    setBusy(`Deleting ${file.name}…`)
    try {
      const result = await cms.deleteMedia(file.path)
      store.forget(file.path)
      setAnnouncement(`Deleted ${file.name} in commit ${result.commit.sha.slice(0, 7)}.`)
      open({})
    } catch (error) {
      setErrors([errorMessage(error)])
    } finally {
      setBusy(null)
    }
  }

  const picker = useFilePicker(folder, true, (files) => void upload(files))
  const drop = useFileDrop((files) => void upload(files), !editable)
  const needle = query.trim().toLowerCase()
  const files = listing.data ?? []
  const visible = files.filter((file) => file.name.toLowerCase().includes(needle))
  const selected = path === undefined ? undefined : files.find((file) => file.path === path)

  return (
    <div className="gcms-media-library" data-over={drop.over || undefined} {...drop.handlers}>
      {picker.element}
      <header className="gcms-document-header">
        <div className="gcms-document-title">
          <h2>Media</h2>
          <p className="gcms-muted">
            {folder.folder || '(repository root)'} → {folder.publicPath}
          </p>
        </div>
        <div className="gcms-actions">
          <p className="gcms-status" role="status">
            {busy ?? announcement}
          </p>
          {editable ? (
            <button type="button" className="gcms-button gcms-button--primary" disabled={busy !== null} onClick={picker.open}>
              Upload…
            </button>
          ) : null}
        </div>
      </header>

      {!editable ? (
        <div className="gcms-notice" role="status">
          {state.base} is published content. Start a change in the sidebar to upload or delete files.
        </div>
      ) : null}
      {errors.length > 0 ? (
        <div className="gcms-notice gcms-error" role="alert">
          {errors.map((error) => <p key={error}>{error}</p>)}
        </div>
      ) : null}

      <div className="gcms-media-toolbar">
        {folders.length > 1 ? (
          folders.length > 6 ? (
            <label className="gcms-media-folder-select">
              <span className="gcms-visually-hidden">Folder</span>
              <select className="gcms-input" value={folder.folder} onChange={(event) => open({ folder: event.target.value })}>
                {folders.map((entry) => (
                  <option key={entry.folder} value={entry.folder}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="gcms-media-folders" role="group" aria-label="Folder">
              {folders.map((entry) => (
                <button
                  key={entry.folder}
                  type="button"
                  className="gcms-media-folder"
                  aria-pressed={entry.folder === folder.folder}
                  title={entry.folder}
                  onClick={() => open({ folder: entry.folder })}
                >
                  {entry.label}
                  {changed.perFolder.get(entry.folder) ? (
                    <span className="gcms-nav-count" aria-label={`${changed.perFolder.get(entry.folder)} changed`}>
                      {changed.perFolder.get(entry.folder)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )
        ) : null}
        <input
          type="search"
          className="gcms-input gcms-media-filter"
          placeholder="Filter…"
          aria-label="Filter files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="gcms-muted gcms-media-count">
          {listing.data ? `${visible.length === files.length ? '' : `${visible.length} of `}${files.length} file${files.length === 1 ? '' : 's'}` : null}
        </span>
      </div>

      <div className="gcms-media-body" data-selected={path === undefined ? undefined : true}>
        <section className="gcms-media-files" aria-label={`Files in ${folder.label}`}>
          {listing.loading && !listing.data ? <p className="gcms-muted">Loading…</p> : null}
          {listing.error ? <p className="gcms-error" role="alert">Could not list {folder.folder}: {errorMessage(listing.error)}</p> : null}
          {listing.data && files.length === 0 ? (
            <p className="gcms-muted">No files here yet.</p>
          ) : null}
          {listing.data && files.length > 0 && visible.length === 0 ? <p className="gcms-muted">No file names match “{query.trim()}”.</p> : null}
          <ul ref={grid} className="gcms-media-grid">
            {visible.map((file) => (
              <li key={file.path} data-path={file.path}>
                <MediaTile
                  store={store}
                  path={file.path}
                  src={file.publicPath}
                  size={file.size}
                  selected={file.path === path}
                  badge={changed.added.has(file.path) ? <span className="gcms-badge gcms-badge--added">New</span> : null}
                  onClick={() => open({ path: file.path })}
                />
              </li>
            ))}
          </ul>
          {editable ? <p className="gcms-muted gcms-media-hint">Drop files anywhere here to upload them. {describeLimits(folder)}.</p> : null}
        </section>
        {path !== undefined ? (
          <FileDetails
            key={path}
            store={store}
            path={path}
            file={selected}
            loaded={listing.data !== undefined}
            editable={editable && busy === null}
            onClose={closeDetails}
            onNavigate={onNavigate}
            onDelete={remove}
          />
        ) : null}
      </div>
      {drop.over ? (
        <div className="gcms-media-drop" aria-hidden>
          Drop to upload to {folder.folder || 'the repository root'}
        </div>
      ) : null}
    </div>
  )
}

/** In a change: how many media files it changed per folder, and the paths of those it added. */
function useChangedMedia() {
  const changes = useChangeReview()?.data?.changes ?? []
  const perFolder = new Map<string, number>()
  const added = new Set<string>()
  for (const change of changes) {
    if (change.mediaFolder === undefined) continue
    perFolder.set(change.mediaFolder, (perFolder.get(change.mediaFolder) ?? 0) + 1)
    if (change.status === 'added') added.add(change.path)
  }
  return { perFolder, added }
}

function FileDetails({ store, path, file, loaded, editable, onClose, onNavigate, onDelete }: {
  store: MediaStore
  path: string
  file: MediaFile | undefined
  loaded: boolean
  editable: boolean
  onClose: () => void
  onNavigate: (view: CmsView) => void
  onDelete: (file: MediaFile, usage: MediaUsage[] | null) => void
}) {
  const cms = useCms()
  const state = useCmsState()
  const headingId = useId()
  const panel = useRef<HTMLElement | null>(null)
  const [dimensions, setDimensions] = useState<[number, number]>()
  const [copied, setCopied] = useState<string>()
  const [downloadError, setDownloadError] = useState<string>()
  const usage = useAsync(() => (file ? cms.findMediaUsage(path) : Promise.resolve([])), [cms, path, file !== undefined, state.branch, state.version])

  // Opened from the grid: move focus into the panel, so keyboard users land on its content.
  useEffect(() => {
    if (document.activeElement?.closest('.gcms-media-grid')) panel.current?.focus()
  }, [])

  const copy = (text: string) => {
    const failed = () => setCopied('Copy failed: select the text instead')
    if (!navigator.clipboard) return failed()
    navigator.clipboard.writeText(text).then(() => setCopied('Copied'), failed)
  }

  return (
    <aside
      ref={panel}
      className="gcms-media-panel"
      aria-labelledby={headingId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="gcms-media-panel-header">
        <h3 id={headingId} className="gcms-media-panel-title" title={path}>
          {fileName(path)}
        </h3>
        <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={onClose}>
          Close
        </button>
      </div>
      {!file ? (
        <p className="gcms-muted">{loaded ? `${path} is not in this folder (any more).` : 'Loading…'}</p>
      ) : (
        <>
          <div className="gcms-media-panel-preview">
            {isImagePath(file.path) ? (
              <Thumbnail store={store} src={file.publicPath} alt="" className="gcms-media-panel-image" onSize={setDimensions} />
            ) : (
              <FileIcon name={file.path} />
            )}
          </div>
          <dl className="gcms-media-facts-list">
            <dt>Repository path</dt>
            <dd>
              <code>{file.path}</code>
            </dd>
            <dt>Public path</dt>
            <dd className="gcms-media-copy">
              <code>{file.publicPath}</code>
              <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={() => copy(file.publicPath)}>
                Copy
              </button>
              <span className="gcms-muted" role="status">
                {copied}
              </span>
            </dd>
            {file.size === undefined ? null : (
              <>
                <dt>Size</dt>
                <dd>{formatBytes(file.size)}</dd>
              </>
            )}
            {dimensions && dimensions[0] > 0 ? (
              <>
                <dt>Dimensions</dt>
                <dd>
                  {dimensions[0]} × {dimensions[1]} px
                </dd>
              </>
            ) : null}
          </dl>
          <UsageList usage={usage} onNavigate={onNavigate} />
          <div className="gcms-media-actions">
            <button
              type="button"
              className="gcms-button gcms-button--small"
              onClick={() => {
                setDownloadError(undefined)
                download(store, file.path).catch((error: unknown) => setDownloadError(errorMessage(error)))
              }}
            >
              Download
            </button>
            {cms.canEdit() ? (
              <button
                type="button"
                className="gcms-button gcms-button--danger gcms-button--small"
                disabled={!editable || usage.loading}
                onClick={() => onDelete(file, usage.error ? null : (usage.data ?? null))}
              >
                Delete
              </button>
            ) : null}
          </div>
          {downloadError ? (
            <p className="gcms-error" role="alert">
              {downloadError}
            </p>
          ) : null}
        </>
      )}
    </aside>
  )
}

function UsageList({ usage, onNavigate }: { usage: AsyncState<MediaUsage[]>; onNavigate: (view: CmsView) => void }) {
  return (
    <section className="gcms-media-usage" aria-label="Used in">
      <h4>Used in</h4>
      {usage.loading && !usage.data ? <p className="gcms-muted">Looking through the content…</p> : null}
      {usage.error ? <p className="gcms-error">Could not check: {errorMessage(usage.error)}</p> : null}
      {usage.data && usage.data.length === 0 ? <p className="gcms-muted">No entry or singleton uses this file.</p> : null}
      {usage.data && usage.data.length > 0 ? (
        <>
          <p className="gcms-media-usage-warning">
            {describeMediaUsage(usage.data)} Deleting it leaves {usage.data.length === 1 ? 'it' : 'them'} pointing at a missing file.
          </p>
          <ul className="gcms-media-usage-list">
            {usage.data.map((source) => (
              <li key={source.path}>
                <button
                  type="button"
                  className="gcms-link"
                  onClick={() =>
                    onNavigate(
                      source.type === 'singleton'
                        ? { type: 'singleton', name: source.name }
                        : { type: 'collection', name: source.name, slug: source.slug },
                    )}
                >
                  {source.label}
                </button>{' '}
                <span className="gcms-muted">
                  {source.path} · {source.fields.join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}
