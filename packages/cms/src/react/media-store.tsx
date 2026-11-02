import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { GitCms, PendingAsset } from '../cms.js'
import { mimeType, toDataUrl, toPublicPath, toRepoPath, type MediaConfig } from '../media.js'

interface Asset {
  blob: Blob
  /** `blob:` URL for the editor's own page. */
  url: string
}

interface Entry {
  promise: Promise<Asset>
  asset?: Asset
  error?: unknown
  /** The preview frame is sandboxed into an opaque origin, which cannot load the editor's `blob:` URLs. */
  dataUrl?: string
  loadingDataUrl?: boolean
}

interface PendingEntry extends Entry {
  asset: Asset
  src: string
}

/** A file the user added, waiting for the next save. */
export interface AddedAsset {
  path: string
  /** What content stores: the URL the site will serve the file at. */
  src: string
  url: string
}

// Files read from the repository, per CMS, shared by all editors so each file is fetched once. Paths
// are a good key: uploads never overwrite files. The URLs live as long as the CMS.
const repositoryFiles = new WeakMap<GitCms, Map<string, Entry>>()

function cacheOf(cms: GitCms): Map<string, Entry> {
  let cache = repositoryFiles.get(cms)
  if (!cache) repositoryFiles.set(cms, (cache = new Map()))
  return cache
}

/** `<img src>` attributes in HTML replaced by `replace`, which returns undefined to keep one. */
export function rewriteImageSources(html: string, replace: (src: string) => string | undefined): string {
  if (typeof DOMParser === 'undefined' || !/<img\s/i.test(html)) return html
  // Parsing into an inert document runs nothing and loads nothing.
  const document = new DOMParser().parseFromString(html, 'text/html')
  let changed = false
  for (const image of document.querySelectorAll('img[src]')) {
    const next = replace(image.getAttribute('src')!)
    if (next !== undefined) {
      image.setAttribute('src', next)
      changed = true
    }
  }
  return changed ? document.body.innerHTML : html
}

/**
 * Files of one document's media fields: uploads waiting for the next save, and repository files
 * read through the CMS (so they show for private repositories too), as `blob:` URLs.
 */
export class MediaStore {
  private pending = new Map<string, PendingEntry>()
  private listeners = new Set<() => void>()
  private version = 0
  private adding: Promise<unknown> = Promise.resolve()

  constructor(
    readonly cms: GitCms,
    /** Media folders of the document's fields, used to find files from URLs in content. */
    readonly folders: MediaConfig[] = [],
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Changes whenever a file is added or finishes loading. */
  getVersion = () => this.version

  private notify() {
    this.version++
    for (const listener of this.listeners) listener()
  }

  /** Add a file under a free name in the field's folder. The next save that refers to it commits it. */
  add(media: MediaConfig, file: File): Promise<AddedAsset> {
    // One at a time, so files added together get different names.
    const run = this.adding.then(async () => {
      const path = await this.cms.availableAssetPath(media.folder, file.name, this.pending.keys())
      const src = toPublicPath(media, path)!
      const asset = { blob: file, url: URL.createObjectURL(file) }
      this.pending.set(path, { promise: Promise.resolve(asset), asset, src })
      this.notify()
      return { path, src, url: asset.url }
    })
    this.adding = run.catch(() => undefined)
    return run
  }

  isPending(path: string): boolean {
    return this.pending.has(path)
  }

  /** Paths of the pending uploads in a folder. */
  pendingIn(folder: string): string[] {
    const prefix = folder ? `${folder}/` : ''
    return [...this.pending.keys()].filter((path) => path.startsWith(prefix))
  }

  /** Repository path of a URL stored in content, when it points into a media folder. */
  resolve(src: string, media?: MediaConfig): string | undefined {
    for (const folder of media ? [media] : this.folders) {
      const path = toRepoPath(folder, src)
      if (path !== undefined) return path
    }
    return undefined
  }

  private entry(path: string): Entry | undefined {
    return this.pending.get(path) ?? cacheOf(this.cms).get(path)
  }

  /** The file's `blob:` URL, if it is pending or already loaded. */
  peek(path: string): string | undefined {
    return this.entry(path)?.asset?.url
  }

  /** Why the file could not be loaded, if it could not. */
  failure(path: string): unknown {
    return this.entry(path)?.error
  }

  /** Load a repository file, once per CMS. */
  load(path: string): Promise<Asset> {
    return this.ensure(path).promise
  }

  private ensure(path: string): Entry {
    const existing = this.entry(path)
    if (existing) return existing
    const entry: Entry = {
      promise: this.cms.readAsset(path).then((bytes) => {
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType(path) })
        return { blob, url: URL.createObjectURL(blob) }
      }),
    }
    entry.promise
      .then(
        (asset) => (entry.asset = asset),
        (error: unknown) => (entry.error = error),
      )
      .finally(() => this.notify())
    cacheOf(this.cms).set(path, entry)
    return entry
  }

  /** A `data:` URL of the file for the sandboxed preview frame, if ready; starts loading it if not. */
  previewUrl(path: string): string | undefined {
    const entry = this.ensure(path)
    if (entry.dataUrl === undefined && !entry.loadingDataUrl) {
      entry.loadingDataUrl = true
      entry.promise
        .then(async (asset) => {
          entry.dataUrl = toDataUrl(new Uint8Array(await asset.blob.arrayBuffer()), asset.blob.type || mimeType(path))
          this.notify()
        })
        .catch(() => undefined)
    }
    return entry.dataUrl
  }

  /** Size in bytes: of the pending or loaded file, else from the repository listing. */
  async size(path: string): Promise<number | undefined> {
    const asset = this.entry(path)?.asset
    if (asset) return asset.blob.size
    return (await this.cms.fs.stat(path)).size
  }

  /** Pending uploads that `values` refers to, with their content, for `saveEntry` and `saveSingleton`. */
  async assets(values: unknown): Promise<PendingAsset[]> {
    const text = JSON.stringify(values) ?? ''
    const referenced = [...this.pending].filter(([, upload]) => text.includes(upload.src))
    return Promise.all(
      referenced.map(async ([path, upload]) => ({ path, content: new Uint8Array(await upload.asset.blob.arrayBuffer()) })),
    )
  }

  /** After a save: committed uploads are repository files now, and keep their URLs. */
  committed(paths: Iterable<string>): void {
    for (const path of paths) {
      const upload = this.pending.get(path)
      if (!upload) continue
      this.pending.delete(path)
      cacheOf(this.cms).set(path, upload)
    }
    this.notify()
  }

  /** Release the URLs of uploads that were never saved. */
  dispose(): void {
    for (const upload of this.pending.values()) URL.revokeObjectURL(upload.asset.url)
    this.pending.clear()
  }
}

const MediaContext = createContext<MediaStore | null>(null)

/** Gives media fields and previews their store. `DocumentEditor` provides one per document. */
export function MediaProvider({ store, children }: { store: MediaStore; children?: ReactNode }) {
  return <MediaContext.Provider value={store}>{children}</MediaContext.Provider>
}

export function useMediaStore(): MediaStore | null {
  return useContext(MediaContext)
}

const noSubscription = () => () => {}
const noVersion = () => 0

/** Re-render when files are added or loaded. */
export function useMediaVersion(store: MediaStore | null): number {
  return useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getVersion ?? noVersion, noVersion)
}

/** `blob:` URL of a repository or pending file, loading it when needed. */
export function useAssetUrl(path: string | undefined): { url?: string; error?: unknown } {
  const store = useMediaStore()
  useMediaVersion(store)
  useEffect(() => {
    if (store && path) store.load(path).catch(() => undefined)
  }, [store, path])
  if (!store || !path) return {}
  return { url: store.peek(path), error: store.failure(path) }
}

/** Size in bytes of a repository or pending file. */
export function useAssetSize(path: string | undefined): number | undefined {
  const store = useMediaStore()
  const [size, setSize] = useState<{ path: string; bytes?: number }>()
  useEffect(() => {
    if (!store || !path) return
    let cancelled = false
    store.size(path).then(
      (bytes) => !cancelled && setSize({ path, bytes }),
      () => !cancelled && setSize({ path }),
    )
    return () => {
      cancelled = true
    }
  }, [store, path])
  return size && size.path === path ? size.bytes : undefined
}

/**
 * A URL that shows a stored image in the editor: for files in a media folder, a `blob:` URL read
 * through the CMS (so private repositories work), else `src` itself. For custom previews.
 */
export function useMediaUrl(src: string | undefined): string | undefined {
  const store = useMediaStore()
  const path = src && store ? store.resolve(src) : undefined
  const { url } = useAssetUrl(path)
  return path ? url : src
}
