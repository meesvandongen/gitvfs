import { useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { fileName, focusToObjectPosition, formatBytes, isImagePath, type FocusPoint, type MediaConfig } from '../media.js'
import { useReadOnly } from './field-utils.js'
import { useAssetUrl, type MediaStore } from './media-store.js'

// Pieces shared by the media fields (media.tsx) and the media library view (media-library.tsx).

type Limits = Pick<MediaConfig, 'accept' | 'maxSize'>

/** A hidden file input and a function that opens it. */
export function useFilePicker(media: Pick<MediaConfig, 'accept'>, multiple: boolean, onFiles: (files: File[]) => void) {
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

/** Drag and drop of files onto an element. Read-only fields, and `disabled`, take no files. */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const [over, setOver] = useState(false)
  const readOnly = useReadOnly() || disabled
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        if (readOnly || !draggingFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setOver(true)
      },
      onDragLeave: (event: DragEvent) => {
        // Moving onto a child element is not leaving.
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setOver(false)
      },
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

/** `Images, up to 10 MB`, `.pdf, up to 1 MB`, `Any file, up to 10 MB`. */
export function describeLimits(media: Limits): string {
  const accept = media.accept === 'image/*' ? 'Images' : media.accept ? media.accept.split(',').map((type) => type.trim()).join(', ') : 'Any file'
  return `${accept}, up to ${formatBytes(media.maxSize)}`
}

/** An image from the repository or a pending upload; other URLs are shown as they are. */
export function Thumbnail({ store, src, alt, focus, className, onSize }: {
  store: MediaStore
  src: string
  alt?: string
  focus?: FocusPoint
  className?: string
  onSize?: (size: [number, number]) => void
}) {
  const path = store.resolve(src)
  const { url, error } = useAssetUrl(path)
  // The image's own aspect ratio lets the stylesheet scale small images up without distorting
  // them, so a focal point picked on the preview maps exactly onto the image.
  const [aspect, setAspect] = useState<number>()
  if (error) return <span className={`${className ?? ''} gcms-media-missing`}>Not found</span>
  const shown = path ? url : src
  if (!shown) return <span className={`${className ?? ''} gcms-media-loading`} aria-label="Loading" />
  const style = { objectPosition: focusToObjectPosition(focus), '--gcms-aspect': aspect } as CSSProperties
  return (
    <img
      className={className}
      src={shown}
      alt={alt ?? ''}
      draggable={false}
      style={style}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget
        if (naturalWidth > 0 && naturalHeight > 0) setAspect(naturalWidth / naturalHeight)
        onSize?.([naturalWidth, naturalHeight])
      }}
    />
  )
}

export function FileIcon({ name }: { name: string }) {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? 'file'
  return (
    <span className="gcms-file-icon" aria-hidden>
      {extension.toUpperCase()}
    </span>
  )
}

/**
 * A file as a button in a grid: a thumbnail for images, a file card for other files, the name and,
 * when known, the size. The fields' library and the media library view both use it.
 */
export function MediaTile({ store, path, src, size, selected, badge, onClick }: {
  store: MediaStore
  path: string
  /** URL content stores for the file, which the thumbnail is read through. */
  src: string
  size?: number
  /** Shown as the current item (`aria-current`), e.g. while its details are open. */
  selected?: boolean
  badge?: ReactNode
  onClick: () => void
}) {
  return (
    <button type="button" className="gcms-library-item" aria-current={selected || undefined} onClick={onClick}>
      {isImagePath(path) ? <Thumbnail store={store} src={src} className="gcms-library-thumb" /> : <FileIcon name={path} />}
      <span className="gcms-media-name">{fileName(path)}</span>
      {size !== undefined || badge ? (
        <span className="gcms-library-meta">
          {size === undefined ? null : <span className="gcms-muted">{formatBytes(size)}</span>}
          {badge}
        </span>
      ) : null}
    </button>
  )
}

/** Saves a repository file through the browser, which also works for private repositories. */
export async function download(store: MediaStore, path: string) {
  const asset = await store.load(path)
  const link = document.createElement('a')
  link.href = asset.url
  link.download = fileName(path)
  document.body.append(link)
  link.click()
  link.remove()
}
