import type { z } from 'zod'

export type ContentFormat = 'markdown' | 'json' | 'yaml'

/** Any zod object schema. Collections describe frontmatter / data fields with one. */
export type ContentSchema = z.ZodObject

export interface CommitMessageContext {
  action: 'create' | 'update' | 'delete' | 'rename'
  /** Collection or singleton name. */
  name: string
  path: string
  previousPath?: string
}

interface ContentTypeBase<S extends ContentSchema> {
  /** Unique identifier, used in the UI and the API. */
  name: string
  /** Human-readable name. Defaults to `name`. */
  label?: string
  /** Fields of the document. For markdown, the body is the `bodyField` key. */
  schema: S
  /** Key in `schema` that holds the markdown body. Default: `body`. */
  bodyField?: string
  /** Stylesheet URLs loaded into the preview frame, e.g. your site's CSS. */
  previewStylesheets?: string[]
  /** Base URL for relative links and images in the preview, e.g. your site's URL. */
  previewBaseUrl?: string
  commitMessage?: (context: CommitMessageContext) => string
}

export interface CollectionConfig<S extends ContentSchema = ContentSchema>
  extends ContentTypeBase<S> {
  /** Directory holding one file per entry, e.g. `content/posts`. */
  folder: string
  /** Default: `markdown`. */
  format?: ContentFormat
  /** File extension without the dot. Defaults to `md`, `json` or `yml` based on `format`. */
  extension?: string
  /** Field used to derive the slug (file name) of new entries. Default: `title`. */
  slugField?: string
  /** Field shown in entry lists. Default: `title`, falling back to the slug. */
  labelField?: string
  /** Order of entries in lists. Default: by label. */
  sort?: (a: EntrySummary<z.output<S>>, b: EntrySummary<z.output<S>>) => number
}

export interface SingletonConfig<S extends ContentSchema = ContentSchema>
  extends ContentTypeBase<S> {
  /** Path of the file, e.g. `data/site.json`. The format follows from the extension. */
  path: string
  format?: ContentFormat
}

export interface Collection<S extends ContentSchema = ContentSchema>
  extends Required<
    Omit<CollectionConfig<S>, 'sort' | 'commitMessage' | 'previewStylesheets' | 'previewBaseUrl'>
  > {
  kind: 'collection'
  previewBaseUrl?: string
  sort?: CollectionConfig<S>['sort']
  commitMessage?: CollectionConfig<S>['commitMessage']
  previewStylesheets: string[]
}

export interface Singleton<S extends ContentSchema = ContentSchema>
  extends Required<
    Omit<SingletonConfig<S>, 'commitMessage' | 'previewStylesheets' | 'previewBaseUrl'>
  > {
  kind: 'singleton'
  previewBaseUrl?: string
  commitMessage?: SingletonConfig<S>['commitMessage']
  previewStylesheets: string[]
}

export type ContentType = Collection | Singleton

export interface EntrySummary<T = Record<string, unknown>> {
  slug: string
  path: string
  label: string
  /** Parsed (not validated) document data. */
  data: Partial<T>
}

const DEFAULT_EXTENSIONS: Record<ContentFormat, string> = {
  markdown: 'md',
  json: 'json',
  yaml: 'yml',
}

export function formatFromPath(path: string): ContentFormat {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'json') return 'json'
  if (extension === 'yml' || extension === 'yaml') return 'yaml'
  if (extension === 'md' || extension === 'mdx' || extension === 'markdown') return 'markdown'
  throw new Error(`Cannot infer a content format from "${path}"; set \`format\` explicitly`)
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}

/** Describe a folder of documents, such as blog posts or pages. */
export function defineCollection<S extends ContentSchema>(config: CollectionConfig<S>): Collection<S> {
  const format = config.format ?? 'markdown'
  return {
    ...config,
    kind: 'collection',
    label: config.label ?? config.name,
    folder: trimSlashes(config.folder),
    format,
    extension: config.extension ?? DEFAULT_EXTENSIONS[format],
    bodyField: config.bodyField ?? 'body',
    slugField: config.slugField ?? 'title',
    labelField: config.labelField ?? 'title',
    previewStylesheets: config.previewStylesheets ?? [],
  }
}

/** Describe a single document, such as site settings or a navigation menu. */
export function defineSingleton<S extends ContentSchema>(config: SingletonConfig<S>): Singleton<S> {
  return {
    ...config,
    kind: 'singleton',
    label: config.label ?? config.name,
    path: trimSlashes(config.path),
    format: config.format ?? formatFromPath(config.path),
    bodyField: config.bodyField ?? 'body',
    previewStylesheets: config.previewStylesheets ?? [],
  }
}
