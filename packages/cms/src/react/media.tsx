import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import { NotFoundError } from 'gitvfs'
import {
  fileName,
  focusToObjectPosition,
  formatBytes,
  isImagePath,
  matchesAccept,
  mediaConfig,
  roundFocus,
  toPublicPath,
  uploadError,
  type FocusPoint,
  type ImageValue,
  type MediaConfig,
  type MediaCustomData,
} from '../media.js'
import { NestedErrors, useField, useReadOnly } from './field-utils.js'
import { useAssetSize, useAssetUrl, useMediaStore, useMediaVersion, type AddedAsset, type MediaStore } from './media-store.js'
import { errorMessage, useAsync } from './use-async.js'

/** A field's media options; a `fieldType: 'image'` set by hand gets the defaults. */
function mediaOf(props: AutoFormFieldProps): MediaConfig {
  return (props.parsedField.fieldConfig?.customData as MediaCustomData | undefined)?.media
    ?? mediaConfig(props.parsedField.type === 'file' ? 'file' : 'image', { value: props.parsedField.type === 'gallery' ? 'object' : undefined })
}

const labelText = (label: ReactNode, fallback: string) => (typeof label === 'string' && label ? label : fallback)

/** `team-photo.jpg` → `team photo`: a starting point for alt text in markdown. */
const altFromPath = (path: string) => fileName(path).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')

const isImageValue = (value: unknown): value is ImageValue =>
  typeof value === 'object' && value !== null && typeof (value as ImageValue).src === 'string' && (value as ImageValue).src !== ''

function MissingStore() {
  return <p className="gcms-error">Media fields need a MediaProvider; DocumentEditor and CmsApp provide one.</p>
}

/** Checks and stages picked files, collecting what went wrong. */
function useUploader(media: MediaConfig) {
  const store = useMediaStore()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const upload = async (files: File[]): Promise<AddedAsset[]> => {
    if (!store) return []
    const problems = files.map((file) => uploadError(media, file)).filter((problem) => problem !== undefined)
    const accepted = files.filter((file) => uploadError(media, file) === undefined)
    setError(problems.join('. ') || undefined)
    if (accepted.length === 0) return []
    setBusy(true)
    try {
      return await Promise.all(accepted.map((file) => store.add(media, file)))
    } catch (failure) {
      setError(errorMessage(failure))
      return []
    } finally {
      setBusy(false)
    }
  }
  return { store, upload, error, busy }
}

/** A hidden file input and a function that opens it. */
function useFilePicker(media: MediaConfig, multiple: boolean, onFiles: (files: File[]) => void) {
  const input = useRef<HTMLInputElement | null>(null)
  const element = (
    <input
      ref={input}
      type="file"
      className="gcms-visually-hidden"
      tabIndex={-1}
      aria-hidden
      accept={media.accept || undefined}
      multiple={multiple}
      onChange={(event) => {
        const files = [...(event.target.files ?? [])]
        event.target.value = ''
        if (files.length > 0) onFiles(files)
      }}
    />
  )
  return { element, open: () => input.current?.click() }
}

const draggingFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files')

/** Drag and drop of files onto an element. */
function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false)
  // A read-only field takes no files.
  const readOnly = useReadOnly()
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        if (readOnly || !draggingFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        if (readOnly || !draggingFiles(event)) return
        event.preventDefault()
        setOver(false)
        const files = [...event.dataTransfer.files]
        if (files.length > 0) onFiles(files)
      },
    },
  }
}

function describeLimits(media: MediaConfig): string {
  const accept = media.accept === 'image/*' ? 'Images' : media.accept ? media.accept.split(',').map((type) => type.trim()).join(', ') : 'Any file'
  return `${accept}, up to ${formatBytes(media.maxSize)}`
}

/** Where files are dropped or browsed for when a field is empty. */
function DropZone(props: {
  media: MediaConfig
  multiple?: boolean
  busy: boolean
  onFiles: (files: File[]) => void
  onLibrary?: () => void
}) {
  const picker = useFilePicker(props.media, props.multiple ?? false, props.onFiles)
  const drop = useFileDrop(props.onFiles)
  const noun = props.media.kind === 'image' ? (props.multiple ? 'images' : 'an image') : props.multiple ? 'files' : 'a file'
  return (
    <div className="gcms-dropzone" data-over={drop.over || undefined} {...drop.handlers}>
      {picker.element}
      <p className="gcms-dropzone-text">{props.busy ? 'Adding…' : `Drop ${noun} here`}</p>
      <div className="gcms-media-actions">
        <button type="button" className="gcms-button gcms-button--small" onClick={picker.open} disabled={props.busy}>
          Upload…
        </button>
        {props.onLibrary ? (
          <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={props.onLibrary}>
            Choose existing
          </button>
        ) : null}
      </div>
      <p className="gcms-muted">{describeLimits(props.media)}</p>
    </div>
  )
}

/** An image from the repository or a pending upload; other URLs are shown as they are. */
function Thumbnail({ store, src, alt, focus, className, onSize }: {
  store: MediaStore
  src: string
  alt?: string
  focus?: FocusPoint
  className?: string
  onSize?: (size: [number, number]) => void
}) {
  const path = store.resolve(src)
  const { url, error } = useAssetUrl(path)
  if (error) return <span className={`${className ?? ''} gcms-media-missing`}>Not found</span>
  const shown = path ? url : src
  if (!shown) return <span className={`${className ?? ''} gcms-media-loading`} aria-label="Loading" />
  return (
    <img
      className={className}
      src={shown}
      alt={alt ?? ''}
      draggable={false}
      style={{ objectPosition: focusToObjectPosition(focus) }}
      onLoad={(event) => onSize?.([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])}
    />
  )
}

/**
 * Click the image, or use the arrow keys, to set the point that stays in view when the image is
 * cropped. Shift moves in bigger steps.
 */
export function FocalPointPicker({ children, focus, onChange }: {
  children: ReactNode
  focus: FocusPoint | undefined
  onChange: (focus: FocusPoint | undefined) => void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const point = focus ?? { x: 0.5, y: 0.5 }
  const readOnly = useReadOnly()

  const pick = (event: MouseEvent) => {
    if (readOnly) return
    const rect = box.current?.getBoundingClientRect()
    // Without layout (tests, hidden elements) there is nothing to measure against.
    if (!rect || rect.width === 0 || rect.height === 0) return
    onChange(roundFocus({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (readOnly) return
    const step = event.shiftKey ? 0.1 : 0.02
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    onChange(roundFocus({ x: point.x + move[0], y: point.y + move[1] }))
  }

  const x = Math.round(point.x * 100)
  const y = Math.round(point.y * 100)
  return (
    <div
      ref={box}
      className="gcms-focal"
      role="slider"
      tabIndex={0}
      aria-label="Focal point"
      aria-readonly={readOnly || undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={x}
      aria-valuetext={focus ? `${x}% from the left, ${y}% from the top` : 'Not set (center)'}
      onClick={pick}
      onKeyDown={onKeyDown}
    >
      {children}
      <span className="gcms-focal-marker" data-unset={focus ? undefined : true} style={{ left: `${x}%`, top: `${y}%` }} aria-hidden />
    </div>
  )
}

/** Small crops that show how the focal point frames the image. */
function CropPreviews({ store, src, focus }: { store: MediaStore; src: string; focus?: FocusPoint }) {
  return (
    <div className="gcms-crops" aria-hidden>
      <Thumbnail store={store} src={src} focus={focus} className="gcms-crop gcms-crop--square" />
      <Thumbnail store={store} src={src} focus={focus} className="gcms-crop gcms-crop--wide" />
    </div>
  )
}

function PendingBadge({ store, src }: { store: MediaStore; src: string }) {
  const path = store.resolve(src)
  return path && store.isPending(path) ? <span className="gcms-badge" title="Committed with the next save">New</span> : null
}

/** Name, size and pixel size of a stored file. */
function FileFacts({ store, src, dimensions }: { store: MediaStore; src: string; dimensions?: [number, number] }) {
  const path = store.resolve(src)
  const size = useAssetSize(path)
  const facts = [
    size === undefined ? undefined : formatBytes(size),
    dimensions && dimensions[0] > 0 ? `${dimensions[0]} × ${dimensions[1]}` : undefined,
  ].filter(Boolean)
  return (
    <p className="gcms-media-facts">
      <span className="gcms-media-name" title={src}>
        {fileName(src)}
      </span>
      <PendingBadge store={store} src={src} />
      {facts.length > 0 ? <span className="gcms-muted"> {facts.join(' · ')}</span> : null}
    </p>
  )
}

/** Files in a media folder (and pending uploads for it), to pick one that is already there. */
function MediaLibrary({ store, media, onPick, onClose, title }: {
  store: MediaStore
  media: MediaConfig
  onPick: (path: string) => void
  onClose: () => void
  title?: string
}) {
  const panel = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  // Pending uploads change the list.
  useMediaVersion(store)
  const listing = useAsync(async () => {
    try {
      const entries = await store.cms.fs.readdir(media.folder)
      return entries.filter((entry) => entry.type === 'blob').map((entry) => `${media.folder ? `${media.folder}/` : ''}${entry.name}`)
    } catch (error) {
      if (error instanceof NotFoundError) return []
      throw error
    }
  }, [store, media.folder])

  useEffect(() => panel.current?.focus(), [])

  const paths = [...new Set([...(listing.data ?? []), ...store.pendingIn(media.folder)])]
    .filter((path) => !(media.folder ? path.slice(media.folder.length + 1) : path).includes('/'))
    .filter((path) => matchesAccept({ name: path }, media.accept))
    .filter((path) => fileName(path).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.localeCompare(b))

  return (
    <section
      ref={panel}
      className="gcms-library"
      aria-label={title ?? 'Media library'}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="gcms-library-header">
        <strong>{title ?? `Files in ${media.folder || 'the repository root'}`}</strong>
        <input
          type="search"
          className="gcms-input gcms-library-search"
          placeholder="Filter"
          aria-label="Filter files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={onClose}>
          Close
        </button>
      </div>
      {listing.loading && !listing.data ? <p className="gcms-muted">Loading…</p> : null}
      {listing.error ? <p className="gcms-error">Could not list {media.folder}: {errorMessage(listing.error)}</p> : null}
      {listing.data && paths.length === 0 ? <p className="gcms-muted">No files here yet.</p> : null}
      <ul className="gcms-library-list">
        {paths.map((path) => (
          <li key={path}>
            <button type="button" className="gcms-library-item" onClick={() => onPick(path)}>
              {isImagePath(path) ? (
                <Thumbnail store={store} src={toPublicPath(media, path)!} className="gcms-library-thumb" />
              ) : (
                <FileIcon name={path} />
              )}
              <span className="gcms-media-name">{fileName(path)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function FileIcon({ name }: { name: string }) {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? 'file'
  return (
    <span className="gcms-file-icon" aria-hidden>
      {extension.toUpperCase()}
    </span>
  )
}

/**
 * An image uploaded into the repository: drop or browse for a file, or pick one that is there. Shows
 * a preview with size and dimensions, and edits the alt text and focal point (`image()` values).
 */
export function ImageField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const media = mediaOf(props)
  const uploader = useUploader(media)
  const [library, setLibrary] = useState(false)
  const [dimensions, setDimensions] = useState<[number, number]>()
  const store = uploader.store
  const asObject = media.value === 'object'
  const value: ImageValue | undefined = asObject
    ? isImageValue(field.value) ? field.value : undefined
    : typeof field.value === 'string' && field.value ? { src: field.value } : undefined

  // Cleared is null, not undefined: react-hook-form would bring the default value back.
  const set = (next: ImageValue | undefined) => field.onChange(next === undefined ? null : asObject ? next : next.src)
  // A new image gets its own alt text and focal point; keys added by hand, like a caption, stay.
  const choose = (src: string) => {
    const { alt: _alt, focus: _focus, ...rest } = value ?? ({} as ImageValue)
    setDimensions(undefined)
    set({ ...rest, src })
  }
  const upload = async (files: File[]) => {
    const [added] = await uploader.upload(files.slice(0, 1))
    if (added) choose(added.src)
  }
  const picker = useFilePicker(media, false, (files) => void upload(files))
  const drop = useFileDrop((files) => void upload(files))

  if (!store) return <MissingStore />
  const label = labelText(props.label, 'Image')

  return (
    <div className="gcms-media" id={props.id} ref={field.ref as never} tabIndex={-1} role="group" aria-label={label}>
      {value ? (
        <div className="gcms-media-card" data-over={drop.over || undefined} {...drop.handlers}>
          {picker.element}
          <div className="gcms-media-preview">
            {asObject && media.focalPoint ? (
              <FocalPointPicker focus={value.focus} onChange={(focus) => set({ ...value, focus })}>
                <Thumbnail store={store} src={value.src} alt={value.alt} className="gcms-media-image" onSize={setDimensions} />
              </FocalPointPicker>
            ) : (
              <Thumbnail store={store} src={value.src} alt={value.alt} className="gcms-media-image" onSize={setDimensions} />
            )}
          </div>
          <div className="gcms-media-details">
            <FileFacts store={store} src={value.src} dimensions={dimensions} />
            {asObject ? (
              <label className="gcms-media-alt">
                <span>Alt text{media.requireAlt ? <span className="gcms-required"> *</span> : null}</span>
                <input
                  className="gcms-input"
                  value={value.alt ?? ''}
                  onChange={(event) => set({ ...value, alt: event.target.value || undefined })}
                  onBlur={field.onBlur}
                />
                <span className="gcms-muted">Describes the image for people who cannot see it. Leave it empty for decoration.</span>
              </label>
            ) : null}
            {asObject && media.focalPoint ? (
              <div className="gcms-media-focus">
                <span className="gcms-muted">
                  {value.focus
                    ? `Focal point ${Math.round(value.focus.x * 100)}%, ${Math.round(value.focus.y * 100)}%. Crops keep it in view:`
                    : 'Click the image to set the focal point that crops keep in view:'}
                </span>
                <CropPreviews store={store} src={value.src} focus={value.focus} />
                {value.focus ? (
                  <button type="button" className="gcms-link" onClick={() => set({ ...value, focus: undefined })}>
                    Reset focal point
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="gcms-media-actions">
              <button type="button" className="gcms-button gcms-button--small" onClick={picker.open} disabled={uploader.busy}>
                {uploader.busy ? 'Adding…' : 'Replace…'}
              </button>
              <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={() => setLibrary(true)}>
                Choose existing
              </button>
              <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={() => set(undefined)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <DropZone media={media} busy={uploader.busy} onFiles={(files) => void upload(files)} onLibrary={() => setLibrary(true)} />
      )}
      {library ? (
        <MediaLibrary
          store={store}
          media={media}
          onClose={() => setLibrary(false)}
          onPick={(path) => {
            choose(toPublicPath(media, path)!)
            setLibrary(false)
          }}
        />
      ) : null}
      {uploader.error ? (
        <p className="gcms-error" role="alert">
          {uploader.error}
        </p>
      ) : null}
      <NestedErrors name={props.id} />
    </div>
  )
}

/** Keys for list items that survive reordering, so focus stays on a moved item's buttons. */
function stableKeys(items: ImageValue[]): string[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const count = seen.get(item.src) ?? 0
    seen.set(item.src, count + 1)
    return `${item.src}#${count}`
  })
}

/** An ordered list of images: add several at once, drag or use the arrow buttons to reorder. */
export function GalleryField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const media = mediaOf(props)
  const uploader = useUploader(media)
  const [library, setLibrary] = useState(false)
  const [focusing, setFocusing] = useState<string>()
  const dragged = useRef<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const store = uploader.store
  const readOnly = useReadOnly()
  const items: ImageValue[] = Array.isArray(field.value) ? field.value.filter(isImageValue) : []
  const full = media.max !== undefined && items.length >= media.max
  const keys = stableKeys(items)

  // The latest list, for uploads that finish after other changes.
  const latest = useRef(items)
  latest.current = items
  const set = (next: ImageValue[]) => {
    latest.current = next
    field.onChange(next)
  }
  const append = (srcs: string[]) => {
    const room = media.max === undefined ? srcs.length : Math.max(0, media.max - latest.current.length)
    set([...latest.current, ...srcs.slice(0, room).map((src) => ({ src }))])
  }
  const update = (index: number, patch: Partial<ImageValue>) => set(items.map((item, at) => (at === index ? { ...item, ...patch } : item)))
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return
    const next = [...items]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    set(next)
  }
  const upload = async (files: File[]) => {
    const room = media.max === undefined ? files.length : Math.max(0, media.max - latest.current.length)
    const added = await uploader.upload(files.slice(0, room))
    append(added.map((asset) => asset.src))
  }

  if (!store) return <MissingStore />
  const label = labelText(props.label, 'Gallery')

  return (
    <div className="gcms-media gcms-gallery" id={props.id} ref={field.ref as never} tabIndex={-1} role="group" aria-label={label}>
      {items.length > 0 ? (
        <ol className="gcms-gallery-list">
          {items.map((item, index) => (
            <li
              key={keys[index]}
              className="gcms-gallery-item"
              data-drop={dropTarget === index || undefined}
              onDragOver={(event) => {
                if (dragged.current === null) return
                event.preventDefault()
                setDropTarget(index)
              }}
              onDragLeave={() => setDropTarget((current) => (current === index ? null : current))}
              onDrop={(event) => {
                if (dragged.current === null) return
                event.preventDefault()
                move(dragged.current, index)
                dragged.current = null
                setDropTarget(null)
              }}
            >
              {/* The thumbnail is the drag handle, so text in the inputs stays selectable. */}
              <div
                className="gcms-gallery-thumb"
                draggable={!readOnly}
                title="Drag to reorder"
                onDragStart={(event) => {
                  dragged.current = index
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', item.src)
                }}
                onDragEnd={() => {
                  dragged.current = null
                  setDropTarget(null)
                }}
              >
                <Thumbnail store={store} src={item.src} alt={item.alt} focus={item.focus} className="gcms-gallery-image" />
                <span className="gcms-gallery-number" aria-hidden>
                  {index + 1}
                </span>
              </div>
              <FileFacts store={store} src={item.src} />
              <label className="gcms-media-alt">
                <span>Alt text{media.requireAlt ? <span className="gcms-required"> *</span> : null}</span>
                <input
                  className="gcms-input"
                  aria-label={`Alt text for image ${index + 1}`}
                  value={item.alt ?? ''}
                  onChange={(event) => update(index, { alt: event.target.value || undefined })}
                  onBlur={field.onBlur}
                />
              </label>
              {media.focalPoint && focusing === keys[index] ? (
                <FocalPointPicker focus={item.focus} onChange={(focus) => update(index, { focus })}>
                  <Thumbnail store={store} src={item.src} alt={item.alt} className="gcms-media-image" />
                </FocalPointPicker>
              ) : null}
              <div className="gcms-media-actions">
                <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" aria-label={`Move image ${index + 1} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="gcms-button gcms-button--ghost gcms-button--small"
                  aria-label={`Move image ${index + 1} down`}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  ↓
                </button>
                {media.focalPoint ? (
                  <button
                    type="button"
                    className="gcms-button gcms-button--ghost gcms-button--small"
                    aria-expanded={focusing === keys[index]}
                    aria-label={`Focal point of image ${index + 1}`}
                    onClick={() => setFocusing((current) => (current === keys[index] ? undefined : keys[index]))}
                  >
                    Focus
                  </button>
                ) : null}
                <button
                  type="button"
                  className="gcms-button gcms-button--ghost gcms-button--small"
                  aria-label={`Remove image ${index + 1}`}
                  onClick={() => set(items.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {full ? (
        <p className="gcms-muted">The maximum of {media.max} images is reached.</p>
      ) : (
        <DropZone media={media} multiple busy={uploader.busy} onFiles={(files) => void upload(files)} onLibrary={() => setLibrary(true)} />
      )}
      {library && !full ? (
        <MediaLibrary store={store} media={media} onClose={() => setLibrary(false)} onPick={(path) => append([toPublicPath(media, path)!])} />
      ) : null}
      {uploader.error ? (
        <p className="gcms-error" role="alert">
          {uploader.error}
        </p>
      ) : null}
      <NestedErrors name={props.id} />
    </div>
  )
}

/** Saves a repository file through the browser, which also works for private repositories. */
async function download(store: MediaStore, path: string) {
  const asset = await store.load(path)
  const link = document.createElement('a')
  link.href = asset.url
  link.download = fileName(path)
  document.body.append(link)
  link.click()
  link.remove()
}

/** Any file uploaded into the repository, such as a PDF: shows its name and size, with a download. */
export function FileField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const media = mediaOf(props)
  const uploader = useUploader(media)
  const [library, setLibrary] = useState(false)
  const [downloadError, setDownloadError] = useState<string>()
  const store = uploader.store
  const src = typeof field.value === 'string' && field.value ? field.value : undefined

  const upload = async (files: File[]) => {
    const [added] = await uploader.upload(files.slice(0, 1))
    if (added) field.onChange(added.src)
  }
  const picker = useFilePicker(media, false, (files) => void upload(files))
  const drop = useFileDrop((files) => void upload(files))

  if (!store) return <MissingStore />
  const path = src ? store.resolve(src, media) : undefined

  return (
    <div className="gcms-media" id={props.id} ref={field.ref as never} tabIndex={-1} role="group" aria-label={labelText(props.label, 'File')}>
      {src ? (
        <div className="gcms-media-card gcms-file" data-over={drop.over || undefined} {...drop.handlers}>
          {picker.element}
          <FileIcon name={src} />
          <div className="gcms-media-details">
            <FileFacts store={store} src={src} />
            <div className="gcms-media-actions">
              {path ? (
                <button
                  type="button"
                  className="gcms-button gcms-button--small"
                  onClick={() => {
                    setDownloadError(undefined)
                    download(store, path).catch((error: unknown) => setDownloadError(errorMessage(error)))
                  }}
                >
                  Download
                </button>
              ) : (
                <a className="gcms-button gcms-button--small" href={src} target="_blank" rel="noreferrer noopener">
                  Open
                </a>
              )}
              <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={picker.open} disabled={uploader.busy}>
                {uploader.busy ? 'Adding…' : 'Replace…'}
              </button>
              <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={() => setLibrary(true)}>
                Choose existing
              </button>
              <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={() => field.onChange(null)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <DropZone media={media} busy={uploader.busy} onFiles={(files) => void upload(files)} onLibrary={() => setLibrary(true)} />
      )}
      {library ? (
        <MediaLibrary
          store={store}
          media={media}
          onClose={() => setLibrary(false)}
          onPick={(picked) => {
            field.onChange(toPublicPath(media, picked))
            setLibrary(false)
          }}
        />
      ) : null}
      {uploader.error || downloadError ? (
        <p className="gcms-error" role="alert">
          {uploader.error ?? downloadError}
        </p>
      ) : null}
      <NestedErrors name={props.id} />
    </div>
  )
}

/** The markdown toolbar's image panel: upload or pick an image, then insert it at the cursor. */
export function MarkdownMediaPanel({ media, onInsert, onClose }: {
  media: MediaConfig
  onInsert: (src: string, alt: string) => void
  onClose: () => void
}) {
  const uploader = useUploader(media)
  const store = uploader.store
  if (!store) return <MissingStore />
  const insert = (path: string) => onInsert(toPublicPath(media, path)!, altFromPath(path))
  return (
    <div className="gcms-markdown-media">
      <DropZone
        media={media}
        busy={uploader.busy}
        onFiles={async (files) => {
          const [added] = await uploader.upload(files.slice(0, 1))
          if (added) insert(added.path)
        }}
      />
      {uploader.error ? (
        <p className="gcms-error" role="alert">
          {uploader.error}
        </p>
      ) : null}
      <MediaLibrary store={store} media={media} title="Or insert an image that is already there" onPick={insert} onClose={onClose} />
    </div>
  )
}
