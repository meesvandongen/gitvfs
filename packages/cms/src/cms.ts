import { NotFoundError, type CommitResult, type GitVFS } from 'gitvfs'
import type {
  Collection,
  CommitMessageContext,
  ContentType,
  EntrySummary,
  Singleton,
} from './config.js'
import { parseDocument, serializeDocument } from './document.js'
import { isSafeAssetPath, uniqueAssetPath } from './media.js'
import { isValidSlug } from './slug.js'

export interface CmsOptions {
  /** The repository to manage. The CMS commits through it, so give it a GitVFS of its own. */
  fs: GitVFS
  collections?: Collection<any>[]
  singletons?: Singleton<any>[]
}

export interface ValidationIssue {
  path: PropertyKey[]
  message: string
}

export class ContentValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Invalid content: ${issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`)
    this.name = 'ContentValidationError'
  }
}

export interface LoadedDocument {
  path: string
  /** False when the file does not exist yet (only possible for singletons). */
  exists: boolean
  /** Parsed, unvalidated data. For markdown, the body sits under `bodyField`. */
  data: Record<string, unknown>
  /** Schema issues of the stored content, so editors can show what needs fixing. */
  issues: ValidationIssue[]
}

/** A file to commit along with a document, such as an uploaded image. */
export interface PendingAsset {
  /** Repository path, e.g. `public/images/team.jpg`. Saving fails when a file already exists there. */
  path: string
  content: Uint8Array
}

export interface SaveSingletonOptions {
  message?: string
  /** Files committed in the same commit as the document, such as uploads its fields refer to. */
  assets?: PendingAsset[]
}

export interface SaveEntryOptions extends SaveSingletonOptions {
  slug: string
  data: Record<string, unknown>
  /** Slug the entry had before; renames the file when it differs. Omit for new entries. */
  previousSlug?: string
}

export interface SaveResult {
  path: string
  commit: CommitResult
}

const LIST_CONCURRENCY = 6

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function schemaKeys(contentType: ContentType): Set<string> {
  return new Set(Object.keys(contentType.schema.shape))
}

function defaultCommitMessage({ action, path, previousPath }: CommitMessageContext): string {
  switch (action) {
    case 'create':
      return `Create ${path}`
    case 'update':
      return `Update ${path}`
    case 'delete':
      return `Delete ${path}`
    case 'rename':
      return `Rename ${previousPath} to ${path}`
  }
}

export class GitCms {
  readonly fs: GitVFS
  readonly collections: Collection[]
  readonly singletons: Singleton[]
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: CmsOptions) {
    this.fs = options.fs
    this.collections = options.collections ?? []
    this.singletons = options.singletons ?? []

    const names = new Set<string>()
    for (const contentType of [...this.collections, ...this.singletons]) {
      if (names.has(contentType.name)) {
        throw new Error(`Duplicate content type name: ${contentType.name}`)
      }
      names.add(contentType.name)
    }
  }

  getCollection(name: string): Collection {
    const collection = this.collections.find((c) => c.name === name)
    if (!collection) throw new Error(`Unknown collection: ${name}`)
    return collection
  }

  getSingleton(name: string): Singleton {
    const singleton = this.singletons.find((s) => s.name === name)
    if (!singleton) throw new Error(`Unknown singleton: ${name}`)
    return singleton
  }

  entryPath(collection: string | Collection, slug: string): string {
    const c = typeof collection === 'string' ? this.getCollection(collection) : collection
    if (!isValidSlug(slug)) throw new Error(`Invalid slug: "${slug}"`)
    return `${c.folder ? `${c.folder}/` : ''}${slug}.${c.extension}`
  }

  /** List the entries of a collection with their parsed data. */
  async listEntries(name: string): Promise<EntrySummary[]> {
    const collection = this.getCollection(name)
    const suffix = `.${collection.extension}`

    let names: string[]
    try {
      const entries = await this.fs.readdir(collection.folder)
      names = entries
        .filter((entry) => entry.type === 'blob' && entry.name.endsWith(suffix))
        .map((entry) => entry.name)
    } catch (error) {
      if (error instanceof NotFoundError) return []
      throw error
    }

    const summaries = await mapLimit(names, LIST_CONCURRENCY, async (fileName) => {
      const slug = fileName.slice(0, -suffix.length)
      const path = this.entryPath(collection, slug)
      let data: Record<string, unknown> = {}
      try {
        data = this.toFormData(collection, await this.readText(path))
      } catch {
        // Unparseable files still show up so they can be opened and fixed.
      }
      const label = data[collection.labelField]
      return {
        slug,
        path,
        label: typeof label === 'string' && label.trim() ? label : slug,
        data,
      }
    })

    return summaries.sort(collection.sort ?? ((a, b) => a.label.localeCompare(b.label)))
  }

  async readEntry(name: string, slug: string): Promise<LoadedDocument> {
    const collection = this.getCollection(name)
    const path = this.entryPath(collection, slug)
    return this.load(collection, path, await this.readText(path))
  }

  async saveEntry(name: string, options: SaveEntryOptions): Promise<SaveResult> {
    const collection = this.getCollection(name)
    const path = this.entryPath(collection, options.slug)
    const previousPath =
      options.previousSlug === undefined ? undefined : this.entryPath(collection, options.previousSlug)

    return this.exclusive(async () => {
      const data = this.validate(collection, options.data)
      const renamed = previousPath !== undefined && previousPath !== path

      if ((previousPath === undefined || renamed) && (await this.fs.exists(path))) {
        throw new Error(`An entry already exists at ${path}`)
      }

      const original = previousPath === undefined ? undefined : await this.readText(previousPath)
      const action = previousPath === undefined ? 'create' : renamed ? 'rename' : 'update'
      const source = this.serialize(collection, data, original)
      const assets = await this.checkAssets(options.assets, [path, previousPath])

      const commit = await this.commit(
        options.message ?? this.commitMessage(collection, { action, name, path, previousPath }),
        () => {
          this.stageAssets(assets)
          if (renamed) this.fs.rm(previousPath)
          this.fs.writeFile(path, source)
        },
      )
      return { path, commit }
    })
  }

  async deleteEntry(name: string, slug: string, options: { message?: string } = {}): Promise<SaveResult> {
    const collection = this.getCollection(name)
    const path = this.entryPath(collection, slug)

    return this.exclusive(async () => {
      const commit = await this.commit(
        options.message ?? this.commitMessage(collection, { action: 'delete', name, path }),
        () => this.fs.rm(path),
      )
      return { path, commit }
    })
  }

  /** Read a singleton. A missing file yields `exists: false` and empty data. */
  async readSingleton(name: string): Promise<LoadedDocument> {
    const singleton = this.getSingleton(name)
    let source: string
    try {
      source = await this.readText(singleton.path)
    } catch (error) {
      if (error instanceof NotFoundError) {
        return { path: singleton.path, exists: false, data: {}, issues: [] }
      }
      throw error
    }
    return this.load(singleton, singleton.path, source)
  }

  async saveSingleton(
    name: string,
    values: Record<string, unknown>,
    options: SaveSingletonOptions = {},
  ): Promise<SaveResult> {
    const singleton = this.getSingleton(name)
    const path = singleton.path

    return this.exclusive(async () => {
      const data = this.validate(singleton, values)
      const exists = await this.fs.exists(path)
      const original = exists ? await this.readText(path) : undefined
      const source = this.serialize(singleton, data, original)
      const assets = await this.checkAssets(options.assets, [path])

      const commit = await this.commit(
        options.message
          ?? this.commitMessage(singleton, { action: exists ? 'update' : 'create', name, path }),
        () => {
          this.stageAssets(assets)
          this.fs.writeFile(path, source)
        },
      )
      return { path, commit }
    })
  }

  /** Read a file of the repository as bytes, such as an image a field refers to. */
  async readAsset(path: string): Promise<Uint8Array> {
    const content = await this.fs.readFile(path)
    return typeof content === 'string' ? new TextEncoder().encode(content) : content
  }

  /**
   * A free path for an upload named `name` in `folder`: the name made safe (`Team Photo.JPG` →
   * `team-photo.jpg`), with `-2`, `-3`, ... added while the repository or `reserved` (other pending
   * uploads) already has it.
   */
  async availableAssetPath(folder: string, name: string, reserved: Iterable<string> = []): Promise<string> {
    const taken = new Set(reserved)
    return uniqueAssetPath(folder, name, async (path) => taken.has(path) || (await this.fs.exists(path)))
  }

  /** Validate uploads before anything is staged; uploads never overwrite files. */
  private async checkAssets(assets: PendingAsset[] = [], documentPaths: Array<string | undefined>): Promise<PendingAsset[]> {
    const seen = new Set(documentPaths.filter((path) => path !== undefined))
    for (const asset of assets) {
      if (!isSafeAssetPath(asset.path)) throw new Error(`Invalid file path: "${asset.path}"`)
      if (seen.has(asset.path)) throw new Error(`Two files would be written to ${asset.path}`)
      seen.add(asset.path)
      if (await this.fs.exists(asset.path)) {
        throw new Error(`A file already exists at ${asset.path}; remove the upload and add it again`)
      }
    }
    return assets
  }

  private stageAssets(assets: PendingAsset[]): void {
    for (const asset of assets) this.fs.writeFile(asset.path, asset.content)
  }

  private async readText(path: string): Promise<string> {
    return (await this.fs.readFile(path, { encoding: 'utf-8' })) as string
  }

  private toFormData(contentType: ContentType, source: string): Record<string, unknown> {
    const { data, body } = parseDocument(contentType.format, source)
    return contentType.format === 'markdown' ? { ...data, [contentType.bodyField]: body } : data
  }

  private load(contentType: ContentType, path: string, source: string): LoadedDocument {
    const data = this.toFormData(contentType, source)
    const result = contentType.schema.safeParse(data)
    const issues = result.success
      ? []
      : result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
    return { path, exists: true, data, issues }
  }

  private validate(contentType: ContentType, values: Record<string, unknown>): Record<string, unknown> {
    const result = contentType.schema.safeParse(values)
    if (!result.success) {
      throw new ContentValidationError(
        result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      )
    }
    return result.data as Record<string, unknown>
  }

  /**
   * Serialize validated data. Keys the schema does not know about are carried over from the
   * original file, so editing with a partial schema never drops content, and existing keys keep
   * their position, so diffs only show what changed.
   */
  private serialize(contentType: ContentType, data: Record<string, unknown>, original?: string): string {
    const known = schemaKeys(contentType)
    const previous = original === undefined
      ? { data: {}, body: '' }
      : parseDocument(contentType.format, original)

    const { [contentType.bodyField]: bodyValue, ...fields } = data
    const values = contentType.format === 'markdown' ? fields : data
    const merged: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(previous.data)) {
      if (!known.has(key)) merged[key] = value
      else if (key in values) merged[key] = values[key]
    }
    Object.assign(merged, values)

    if (contentType.format !== 'markdown') {
      return serializeDocument(contentType.format, { data: merged, body: '' })
    }
    const body = known.has(contentType.bodyField)
      ? (typeof bodyValue === 'string' ? bodyValue : '')
      : previous.body
    return serializeDocument('markdown', { data: merged, body })
  }

  private commitMessage(contentType: ContentType, context: CommitMessageContext): string {
    return (contentType.commitMessage ?? defaultCommitMessage)(context)
  }

  /** Stage changes and commit them as one commit. */
  private async commit(message: string, stage: () => void): Promise<CommitResult> {
    try {
      stage()
      return await this.fs.commit(message)
    } catch (error) {
      // Leave nothing staged, uploads included, so a failed save does not leak into the next commit.
      this.fs.discard()
      throw error
    }
  }

  /** Run write operations one at a time; they share the GitVFS change buffer. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }
}

export function createCms(options: CmsOptions): GitCms {
  return new GitCms(options)
}
