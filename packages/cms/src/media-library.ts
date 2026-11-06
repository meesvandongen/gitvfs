import type { GitCms } from './cms.js'
import type { ContentType } from './config.js'
import { DEFAULT_MAX_SIZE, defaultPublicPath, mediaFieldConfigs, toPublicPath, type UploadOptions } from './media.js'
import type { ReferenceSource } from './references.js'

// The media library shows the folders media fields upload to, as they are in the branch being
// edited: plain files, no metadata store. Like Decap CMS and TinaCMS (repo-based media), the files
// are the source of truth, so alt text and focal points stay in the content that uses an image.
// What a file is used by is not stored either: like Strapi's media-usage plugin, it is worked out
// on demand by scanning the content, for the warning before a delete.

/** A folder of the media library. */
export interface MediaLibraryFolder {
  /** Repository folder, e.g. `public/images`. */
  folder: string
  /** URL the site serves the folder at, e.g. `/images`. */
  publicPath: string
  /** Name shown in the library, e.g. `Images`. */
  label: string
  /** File types uploads may have, as in `<input accept>`; empty accepts any file. */
  accept: string
  /** Largest upload in bytes. */
  maxSize: number
}

/**
 * A media folder in the CMS options: one no field uses yet, or a label or limits for one a field
 * uses. Its `accept` and `maxSize` apply to uploads in the library only; fields keep their own.
 */
export interface MediaFolderOptions extends UploadOptions {
  folder: string
  label?: string
}

/** A file in a media folder. */
export interface MediaFile {
  /** Repository path, e.g. `public/images/team.jpg`. */
  path: string
  /** File name, e.g. `team.jpg`. */
  name: string
  /** URL content stores for it, e.g. `/images/team.jpg`. */
  publicPath: string
  /** Size in bytes, when the repository listing has it. */
  size?: number
}

/** A file to upload into the media library. */
export interface MediaUpload {
  /** File name as picked; it is made safe and unique (`Team Photo.JPG` → `team-photo.jpg`). */
  name: string
  content: Uint8Array
}

/** A document that uses a media file: the same shape as a reference's source. */
export type MediaUsage = ReferenceSource

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, '')

/** `public/images/posts` → `Images › Posts`; the repository root → `Repository root`. */
export function mediaFolderLabel(folder: string): string {
  const segments = trimSlashes(folder).replace(/^(public|static)(\/|$)/, '').split('/').filter(Boolean)
  if (segments.length === 0) return folder ? folder.charAt(0).toUpperCase() + folder.slice(1) : 'Repository root'
  return segments.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1)).join(' › ')
}

/** Accept lists combined: a file any of them accepts is accepted. An empty list accepts all. */
function combineAccept(lists: readonly string[]): string {
  if (lists.some((list) => !list.trim())) return ''
  const tokens = lists.flatMap((list) => list.split(',').map((token) => token.trim()).filter(Boolean))
  return [...new Set(tokens)].join(',')
}

/**
 * The media library's folders: each folder the media fields of the content types upload to
 * (markdown `media` included), once, then those of the `media` option that no field uses. A
 * folder's uploads accept what any of its fields accepts, up to the largest `maxSize`, unless the
 * option says otherwise.
 */
export function mediaLibraryFolders(contentTypes: readonly ContentType[], options: readonly MediaFolderOptions[] = []): MediaLibraryFolder[] {
  const folders = new Map<string, { option?: MediaFolderOptions; publicPath?: string; accept: string[]; maxSize: number[] }>()
  const slot = (folder: string) => {
    let found = folders.get(folder)
    if (!found) folders.set(folder, (found = { accept: [], maxSize: [] }))
    return found
  }
  for (const contentType of contentTypes) {
    for (const media of mediaFieldConfigs(contentType.schema)) {
      const found = slot(media.folder)
      found.publicPath ??= media.publicPath
      found.accept.push(media.accept)
      found.maxSize.push(media.maxSize)
    }
  }
  for (const option of options) slot(trimSlashes(option.folder)).option ??= option
  return [...folders].map(([folder, { option, publicPath, accept, maxSize }]) => ({
    folder,
    publicPath: option?.publicPath ?? publicPath ?? defaultPublicPath(folder),
    label: option?.label ?? mediaFolderLabel(folder),
    accept: option?.accept ?? combineAccept(accept),
    maxSize: option?.maxSize ?? (maxSize.length > 0 ? Math.max(...maxSize) : DEFAULT_MAX_SIZE),
  }))
}

/** The media folder a file lies in directly (not in a subfolder of it). */
export function mediaFolderOf<F extends Pick<MediaLibraryFolder, 'folder'>>(folders: readonly F[], path: string): F | undefined {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return folders.find((folder) => folder.folder === parent)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A pattern that finds a media file in text: its public URL (as stored, or with `%20` and the like
 * decoded) or its repository path (also inside a relative path such as `../../public/images/a.png`).
 * Neighbouring name characters must not continue it, so `/images/a.png` does not match
 * `/images/a.png.webp` or `/media/images/a.png`.
 */
export function mediaPattern(repoPath: string, publicUrl?: string): RegExp {
  const urls = new Set<string>()
  if (publicUrl) {
    urls.add(publicUrl)
    try {
      urls.add(decodeURI(publicUrl))
    } catch {
      // Not valid percent-encoding: only the URL as given.
    }
  }
  const alternatives = [
    ...[...urls].map((url) => `(?<![\\w.%/-])${escapeRegExp(url)}`),
    // A file at the root has no folder of its own to anchor it: `/a.png` is another folder's file.
    `(?<![\\w.%${repoPath.includes('/') ? '' : '/'}-])${escapeRegExp(repoPath)}`,
  ]
  return new RegExp(`(?:${alternatives.join('|')})(?![\\w.%/-])`)
}

/**
 * Where a document's data uses a media file: the paths of the string values `pattern` (from
 * `mediaPattern`) matches, such as `cover.src`, `photos.*.src` or `body`, with `*` for list items.
 */
export function mediaUsageIn(data: unknown, pattern: RegExp): string[] {
  const found = new Set<string>()
  const visit = (value: unknown, path: string[]) => {
    if (typeof value === 'string') {
      if (pattern.test(value)) found.add(path.join('.'))
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, [...path, '*'])
    } else if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key])
    }
  }
  visit(data, [])
  return [...found]
}

/**
 * Entries and singletons that use a media file, in any field or markdown body. Reads every
 * document, so it runs when asked (before a delete), not on every listing.
 */
export async function findMediaUsage(cms: GitCms, path: string): Promise<MediaUsage[]> {
  const folder = mediaFolderOf(cms.mediaFolders(), path)
  const pattern = mediaPattern(path, folder ? toPublicPath(folder, path) : undefined)
  const usage: MediaUsage[] = []
  for (const collection of cms.collections) {
    for (const entry of await cms.listEntries(collection.name)) {
      const fields = mediaUsageIn(entry.data, pattern)
      if (fields.length > 0) {
        usage.push({ type: 'collection', name: collection.name, slug: entry.slug, label: entry.label, path: entry.path, fields })
      }
    }
  }
  for (const singleton of cms.singletons) {
    const document = await cms.readSingleton(singleton.name)
    const fields = document.exists ? mediaUsageIn(document.data, pattern) : []
    if (fields.length > 0) {
      usage.push({ type: 'singleton', name: singleton.name, label: singleton.label, path: document.path, fields })
    }
  }
  return usage
}

/** "Used in 2 documents: “Hello” and “Site”.", for confirmations. Empty when nothing uses the file. */
export function describeMediaUsage(usage: readonly MediaUsage[]): string {
  if (usage.length === 0) return ''
  const names = usage.slice(0, 3).map((source) => `“${source.label}”`)
  const more = usage.length - names.length
  const list = more > 0
    ? `${names.join(', ')} and ${more} more`
    : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return `Used in ${usage.length} ${usage.length === 1 ? 'document' : 'documents'}: ${list}.`
}
