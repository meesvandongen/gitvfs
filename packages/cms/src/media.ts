import { parseSchema } from '@autoform/zod'
import { z } from 'zod'
import { field, type CmsFieldConfig } from './fields.js'
import { slugify } from './slug.js'

// Media fields upload files into the repository, next to the content, and store the URL the site
// serves them at, like Decap CMS (`media_folder` + `public_folder`) and Keystatic
// (`fields.image({ directory, publicPath })`). The upload is committed together with the entry.

/** Where a field keeps its uploads. */
export interface MediaFolder {
  /** Repository folder uploads are committed to, e.g. `public/images`. */
  folder?: string
  /**
   * URL the site serves `folder` at, which is what the content stores, e.g. `/images`. Default:
   * `folder` from the site root, without a leading `public/` or `static/` (Vite, Next.js, Astro,
   * Hugo and Gatsby serve those folders at the root).
   */
  publicPath?: string
}

export interface UploadOptions extends MediaFolder {
  /** File types the picker offers and accepts, as in `<input accept>`: `image/*`, `.pdf`. */
  accept?: string
  /** Largest accepted file in bytes. Default: 10 MB; Git hosts are not made for big binaries. */
  maxSize?: number
}

export interface ImageOptions extends UploadOptions {
  /** Require alt text. Default: false (alt text is offered, and empty means decorative). */
  requireAlt?: boolean
  /** Let editors pick the focal point, stored as `focus`. Default: true. */
  focalPoint?: boolean
}

export interface GalleryOptions extends ImageOptions {
  min?: number
  max?: number
}

/** A focal point as fractions of the image: `{ x: 0, y: 0 }` is the top left corner. */
export interface FocusPoint {
  x: number
  y: number
}

/** What `image()` and `gallery()` store. */
export interface ImageValue {
  /** URL of the image as the site serves it, e.g. `/images/team.jpg`. */
  src: string
  /** Text alternative; leave empty for decorative images. */
  alt?: string
  /** The part of the image to keep in view when it is cropped, e.g. with `object-position`. */
  focus?: FocusPoint
}

/** Media options as the editor receives them, with defaults applied. */
export interface MediaConfig {
  kind: 'image' | 'file'
  folder: string
  publicPath: string
  accept: string
  maxSize: number
  /** `object` for `image()` and `gallery()`, `path` for `imagePath()`, `file()` and markdown. */
  value: 'object' | 'path'
  requireAlt: boolean
  focalPoint: boolean
  min?: number
  max?: number
}

/** Where media fields keep their options in AutoForm's `customData`. */
export interface MediaCustomData {
  media: MediaConfig
}

/** Where embed fields keep their options in AutoForm's `customData`. */
export interface EmbedCustomData {
  embed: { providers: EmbedProvider[] }
}

/** Default `maxSize`: 10 MB. */
export const DEFAULT_MAX_SIZE = 10 * 1024 * 1024

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, '')

/** `public/images` → `/images`, `static` → `/`, `assets/img` → `/assets/img`. */
export function defaultPublicPath(folder: string): string {
  return `/${trimSlashes(folder).replace(/^(public|static)(\/|$)/, '')}`
}

/** Apply the defaults of a kind of media field: images go to `public/images`, files to `public/files`. */
export function mediaConfig(kind: MediaConfig['kind'], options: GalleryOptions & { value?: MediaConfig['value'] } = {}): MediaConfig {
  const folder = trimSlashes(options.folder ?? (kind === 'image' ? 'public/images' : 'public/files'))
  return {
    kind,
    folder,
    publicPath: options.publicPath ?? defaultPublicPath(folder),
    accept: options.accept ?? (kind === 'image' ? 'image/*' : ''),
    maxSize: options.maxSize ?? DEFAULT_MAX_SIZE,
    value: options.value ?? 'path',
    requireAlt: options.requireAlt ?? false,
    focalPoint: options.focalPoint ?? true,
    ...(options.min === undefined ? {} : { min: options.min }),
    ...(options.max === undefined ? {} : { max: options.max }),
  }
}

/** The URL content stores for a file in the media folder, or undefined for a file elsewhere. */
export function toPublicPath(media: Pick<MediaConfig, 'folder' | 'publicPath'>, repoPath: string): string | undefined {
  const prefix = media.folder ? `${media.folder}/` : ''
  if (!repoPath.startsWith(prefix) || repoPath.length === prefix.length) return undefined
  return `${media.publicPath.replace(/\/+$/, '')}/${encodeURI(repoPath.slice(prefix.length))}`
}

/** The repository path of a stored URL, or undefined when it points elsewhere (another site, folder). */
export function toRepoPath(media: Pick<MediaConfig, 'folder' | 'publicPath'>, src: string): string | undefined {
  const prefix = `${media.publicPath.replace(/\/+$/, '')}/`
  const url = src.split(/[?#]/)[0]
  if (!url.startsWith(prefix)) return undefined
  let rest: string
  try {
    rest = decodeURI(url.slice(prefix.length))
  } catch {
    return undefined
  }
  const segments = rest.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  return media.folder ? `${media.folder}/${rest}` : rest
}

/** Last path segment: `public/images/team.jpg` → `team.jpg`. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function splitExtension(name: string): [string, string] {
  const match = /^(.*?)(\.[a-z0-9]{1,10})?$/i.exec(name)!
  return [match[1], (match[2] ?? '').toLowerCase()]
}

/** A safe file name for an upload: `Team Photo (1).JPG` → `team-photo-1.jpg`. */
export function assetFileName(name: string): string {
  const [base, extension] = splitExtension(fileName(name))
  return `${slugify(base).slice(0, 80).replace(/-+$/, '') || 'file'}${extension}`
}

/**
 * The first free path for an upload in `folder`: `team.jpg`, then `team-2.jpg`, `team-3.jpg`, ...
 * `isTaken` says whether a path is used, in the repository or by another pending upload.
 */
export async function uniqueAssetPath(
  folder: string,
  name: string,
  isTaken: (path: string) => boolean | Promise<boolean>,
): Promise<string> {
  const [base, extension] = splitExtension(assetFileName(name))
  const prefix = trimSlashes(folder) ? `${trimSlashes(folder)}/` : ''
  for (let attempt = 1; ; attempt++) {
    const candidate = `${prefix}${base}${attempt === 1 ? '' : `-${attempt}`}${extension}`
    if (!(await isTaken(candidate))) return candidate
  }
}

/** Whether a repository path is safe to write an upload to: relative, without `.` or `..` parts. */
export function isSafeAssetPath(path: string): boolean {
  const segments = path.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') && segments[0] !== '.git'
}

const MIME_TYPES: Record<string, string> = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  json: 'application/json',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Media type from a file name's extension, `application/octet-stream` when unknown. */
export function mimeType(path: string): string {
  return MIME_TYPES[splitExtension(fileName(path))[1].slice(1)] ?? 'application/octet-stream'
}

/** Whether a file name is an image that browsers show. */
export function isImagePath(path: string): boolean {
  return mimeType(path).startsWith('image/')
}

/** Whether a file matches an `<input accept>` list such as `image/*,.pdf`. An empty list accepts all. */
export function matchesAccept(file: { name: string; type?: string }, accept: string | undefined): boolean {
  const tokens = (accept ?? '').split(',').map((token) => token.trim().toLowerCase()).filter(Boolean)
  if (tokens.length === 0) return true
  const name = file.name.toLowerCase()
  const type = (file.type || mimeType(file.name)).toLowerCase()
  return tokens.some((token) => {
    if (token.startsWith('.')) return name.endsWith(token)
    if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1))
    return type === token
  })
}

/** Why a file cannot be uploaded to a field, or undefined when it can. */
export function uploadError(media: Pick<MediaConfig, 'accept' | 'maxSize'>, file: { name: string; type?: string; size: number }): string | undefined {
  if (!matchesAccept(file, media.accept)) return `${file.name} is not an accepted type of file (${media.accept})`
  if (file.size > media.maxSize) return `${file.name} is ${formatBytes(file.size)}; files can be up to ${formatBytes(media.maxSize)}`
  return undefined
}

/** `512 B`, `1.5 KB`, `12 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`
}

/** Round a focal point to whole percents, inside the image. */
export function roundFocus(point: FocusPoint): FocusPoint {
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
  return { x: round(point.x), y: round(point.y) }
}

/** CSS `object-position` / `background-position` for a focal point: `{ x: 0.5, y: 0.3 }` → `50% 30%`. */
export function focusToObjectPosition(focus: FocusPoint | undefined): string {
  if (!focus) return '50% 50%'
  return `${Math.round(focus.x * 100)}% ${Math.round(focus.y * 100)}%`
}

/** Base64 data URL of some bytes, for places that cannot load `blob:` URLs. */
export function toDataUrl(bytes: Uint8Array, type: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return `data:${type};base64,${btoa(binary)}`
}

// --- Schemas -------------------------------------------------------------------------------------

/** Editor options of a media field, without `fieldType` (set by the helper). */
export type MediaFieldConfig<O extends UploadOptions = UploadOptions> = Omit<CmsFieldConfig, 'fieldType' | 'customData'> & O

const MEDIA_OPTION_KEYS = ['folder', 'publicPath', 'accept', 'maxSize', 'requireAlt', 'focalPoint', 'min', 'max'] as const

function splitConfig(config: MediaFieldConfig<GalleryOptions>, fieldType: string, media: MediaConfig) {
  const fieldConfig: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!(MEDIA_OPTION_KEYS as readonly string[]).includes(key)) fieldConfig[key] = value
  }
  return field({ ...(fieldConfig as CmsFieldConfig), fieldType, customData: { media } satisfies MediaCustomData })
}

const fraction = () => z.number().min(0, 'Use a value from 0 to 1').max(1, 'Use a value from 0 to 1')

function imageShape(options: ImageOptions) {
  const choose = 'Choose an image'
  // Loose: keys added by hand, such as a caption, survive saves.
  return z.looseObject({
    src: z.string({ error: choose }).min(1, choose),
    alt: options.requireAlt
      ? z.string({ error: 'Describe the image' }).trim().min(1, 'Describe the image')
      : z.string().optional(),
    focus: z.object({ x: fraction(), y: fraction() }).optional(),
  })
}

/**
 * An image uploaded to the repository, with alt text and an optional focal point:
 * `{ src: '/images/team.jpg', alt: 'The team', focus: { x: 0.5, y: 0.3 } }`.
 *
 * ```ts
 * cover: image({ label: 'Cover', folder: 'public/images/posts', publicPath: '/images/posts' }).optional()
 * ```
 */
export function image(config: MediaFieldConfig<ImageOptions> = {}) {
  return imageShape(config).check(splitConfig(config, 'image', mediaConfig('image', { ...config, value: 'object' })))
}

/** An image uploaded to the repository, stored as its URL only: `/images/team.jpg`. */
export function imagePath(config: MediaFieldConfig<UploadOptions> = {}) {
  const media = mediaConfig('image', { ...config, value: 'path', focalPoint: false })
  return z.string({ error: 'Choose an image' }).min(1, 'Choose an image').check(splitConfig(config, 'image', media))
}

/** An ordered list of images, each stored like `image()`. */
export function gallery(config: MediaFieldConfig<GalleryOptions> = {}) {
  let list = z.array(imageShape(config))
  if (config.min !== undefined) list = list.min(config.min, `Add at least ${config.min} image${config.min === 1 ? '' : 's'}`)
  if (config.max !== undefined) list = list.max(config.max, `Use at most ${config.max} images`)
  return list.check(splitConfig(config, 'gallery', mediaConfig('image', { ...config, value: 'object' })))
}

/** Any file uploaded to the repository, such as a PDF, stored as its URL: `/files/menu.pdf`. */
export function file(config: MediaFieldConfig<UploadOptions> = {}) {
  const media = mediaConfig('file', { ...config, value: 'path' })
  return z.string({ error: 'Choose a file' }).min(1, 'Choose a file').check(splitConfig(config, 'file', media))
}

/** Media folders a schema's fields upload to, so the editor can show their files. */
export function mediaFolders(schema: z.ZodObject): MediaConfig[] {
  const found = new Map<string, MediaConfig>()
  const visit = (fields: ReturnType<typeof parseSchema>['fields']) => {
    for (const parsed of fields) {
      const customData = parsed.fieldConfig?.customData as Partial<MediaCustomData> | undefined
      const media = customData?.media
        ? parsed.fieldConfig?.fieldType === 'markdown'
          ? mediaConfig('image', customData.media)
          : customData.media
        : undefined
      if (media) found.set(`${media.folder}\n${media.publicPath}`, media)
      visit(parsed.schema ?? [])
    }
  }
  visit(parseSchema(schema as never).fields)
  return [...found.values()]
}

// --- Embeds --------------------------------------------------------------------------------------

export type EmbedProvider = 'youtube' | 'vimeo' | 'url'

export interface EmbedInfo {
  provider: EmbedProvider
  /** The URL as given, trimmed. */
  url: string
  /** Video id on YouTube or Vimeo. */
  id?: string
  /** Player URL for an iframe: youtube-nocookie.com, or Vimeo with `dnt=1`. */
  embedUrl?: string
  /** Start time in seconds, from `t=1m30s` and the like. */
  start?: number
}

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds. */
function parseTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value) || undefined
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value)
  if (!match || !match[0]) return undefined
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) || undefined
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/

function youtubeId(url: URL, host: string): string | undefined {
  const segments = url.pathname.split('/').filter(Boolean)
  if (host === 'youtu.be') return segments[0]
  if (url.pathname === '/watch') return url.searchParams.get('v') ?? undefined
  if (['embed', 'shorts', 'live', 'v'].includes(segments[0])) return segments[1]
  return undefined
}

/**
 * Recognize a video link: YouTube (`watch?v=`, `youtu.be`, shorts, live, embed) and Vimeo (including
 * unlisted links with a hash). Other http(s) URLs come back as `provider: 'url'`, anything else as
 * undefined.
 */
export function parseEmbedUrl(input: string): EmbedInfo | undefined {
  const text = input.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return undefined
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '')

  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    const id = youtubeId(url, host)
    if (id && YOUTUBE_ID.test(id)) {
      const start = parseTime(url.searchParams.get('t') ?? url.searchParams.get('start'))
      return {
        provider: 'youtube',
        url: text,
        id,
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`,
        ...(start ? { start } : {}),
      }
    }
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const segments = url.pathname.split('/').filter(Boolean)
    const index = segments.findIndex((segment) => /^\d+$/.test(segment))
    if (index !== -1) {
      const id = segments[index]
      const hash = url.searchParams.get('h') ?? (/^[0-9a-f]{6,}$/i.test(segments[index + 1] ?? '') ? segments[index + 1] : undefined)
      const start = parseTime(/(?:^|&)t=([^&]+)/.exec(url.hash.slice(1))?.[1])
      return {
        provider: 'vimeo',
        url: text,
        id,
        embedUrl: `https://player.vimeo.com/video/${id}?dnt=1${hash ? `&h=${hash}` : ''}${start ? `#t=${start}s` : ''}`,
        ...(start ? { start } : {}),
      }
    }
  }

  return { provider: 'url', url: text }
}

const PROVIDER_NAMES: Record<EmbedProvider, string> = { youtube: 'YouTube', vimeo: 'Vimeo', url: 'web' }

/** Editor options of an embed field. */
export type EmbedFieldConfig = Omit<CmsFieldConfig, 'fieldType' | 'customData'> & {
  /** Accepted kinds of links. Default: all; `['youtube', 'vimeo']` accepts only videos. */
  providers?: EmbedProvider[]
}

/**
 * A video or other embeddable link, stored as the URL string. The editor recognizes YouTube and
 * Vimeo and loads a privacy-friendly player only when asked.
 */
export function embed(config: EmbedFieldConfig = {}) {
  const { providers = ['youtube', 'vimeo', 'url'], ...rest } = config
  const message = providers.includes('url')
    ? 'Enter a link starting with https://'
    : `Enter a ${providers.map((provider) => PROVIDER_NAMES[provider]).join(' or ')} link`
  return z
    .string({ error: message })
    .refine((value) => {
      const info = parseEmbedUrl(value)
      return info !== undefined && providers.includes(info.provider)
    }, message)
    .check(field({ ...rest, fieldType: 'embed', customData: { embed: { providers } } satisfies EmbedCustomData }))
}
