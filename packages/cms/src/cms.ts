import {
  NotFoundError,
  type ChangedFileStatus,
  type CommitResult,
  type GitVFS,
  type MergeResult,
  type PullRequestInfo,
} from 'gitvfs'
import { changeBranchName, changeTitle } from './changes.js'
import type {
  Collection,
  CommitMessageContext,
  ContentType,
  EntrySummary,
  Singleton,
} from './config.js'
import { parseDocument, serializeDocument } from './document.js'
import { isValidSlug } from './slug.js'

export interface CmsOptions {
  /** The repository to manage. The CMS commits through it, so give it a GitVFS of its own. */
  fs: GitVFS
  collections?: Collection<any>[]
  singletons?: Singleton<any>[]
  /**
   * Edit in changes: branches off the `fs`'s branch that collect edits until they are published,
   * usually through a pull request. `true` uses the defaults.
   */
  changes?: boolean | ChangesOptions
}

export interface ChangesOptions {
  /** Prefix of the branches that hold changes. Default: `cms/` */
  branchPrefix?: string
  /** Only allow edits inside a change, so the base branch changes only by publishing. Default: false */
  required?: boolean
}

/** Where the CMS reads and commits; see `GitCms.getState()`. */
export interface CmsState {
  /** The branch changes start from and are published to. */
  base: string
  /** The branch edits are committed to: `base`, or the change's branch. */
  branch: string
  /** True while editing a change rather than the base branch. */
  inChange: boolean
  /** Counts up on every commit and branch switch, so views know to reload. */
  version: number
}

/** A change: a branch with edits, and its pull request when there is one. */
export interface ChangeSummary {
  branch: string
  title: string
  /** Its open pull request, if any. */
  pullRequest?: PullRequestInfo
}

export interface ChangeComparison {
  /** Commits in the change. */
  ahead: number
  /** Commits on the base branch since the change started (or was last updated). */
  behind: number
  changes: ContentChange[]
}

/** A file that differs in the current change from the base branch. */
export interface ContentChange {
  path: string
  status: ChangedFileStatus
  previousPath?: string
  /** The collection or singleton the file belongs to; absent for other files. */
  contentType?: ContentType
  /** The entry's slug, for collection entries. */
  slug?: string
  /** The entry's label, the singleton's label, or the path. */
  label: string
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

export interface SaveEntryOptions {
  slug: string
  data: Record<string, unknown>
  /** Slug the entry had before; renames the file when it differs. Omit for new entries. */
  previousSlug?: string
  message?: string
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
  /** The change workflow's settings, or `null` when edits go straight to the branch. */
  readonly changes: Required<ChangesOptions> | null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly baseBranch: string
  private state: CmsState
  private listeners = new Set<() => void>()

  constructor(options: CmsOptions) {
    this.fs = options.fs
    this.collections = options.collections ?? []
    this.singletons = options.singletons ?? []
    this.changes = options.changes
      ? {
        branchPrefix: 'cms/',
        required: false,
        ...(options.changes === true ? {} : options.changes),
      }
      : null
    const { base, write } = this.fs.branches()
    this.baseBranch = base
    this.state = { base, branch: write, inChange: write !== base, version: 0 }

    const names = new Set<string>()
    for (const contentType of [...this.collections, ...this.singletons]) {
      if (names.has(contentType.name)) {
        throw new Error(`Duplicate content type name: ${contentType.name}`)
      }
      names.add(contentType.name)
    }
  }

  /** The current branches. A new object after every change, for `useSyncExternalStore`. */
  getState = (): CmsState => this.state

  /** Call `listener` after every commit and branch switch. Returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const { write } = this.fs.branches()
    this.state = { base: this.baseBranch, branch: write, inChange: write !== this.baseBranch, version: this.state.version + 1 }
    for (const listener of this.listeners) listener()
  }

  /** False when changes are required and the base branch is checked out: it can only be read. */
  canEdit(): boolean {
    return !(this.changes?.required && !this.state.inChange)
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

      if (renamed) this.fs.rm(previousPath)
      this.fs.writeFile(path, this.serialize(collection, data, original))

      const commit = await this.commit(
        options.message ?? this.commitMessage(collection, { action, name, path, previousPath }),
      )
      return { path, commit }
    })
  }

  async deleteEntry(name: string, slug: string, options: { message?: string } = {}): Promise<SaveResult> {
    const collection = this.getCollection(name)
    const path = this.entryPath(collection, slug)

    return this.exclusive(async () => {
      this.fs.rm(path)
      const commit = await this.commit(
        options.message ?? this.commitMessage(collection, { action: 'delete', name, path }),
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
    options: { message?: string } = {},
  ): Promise<SaveResult> {
    const singleton = this.getSingleton(name)
    const path = singleton.path

    return this.exclusive(async () => {
      const data = this.validate(singleton, values)
      const exists = await this.fs.exists(path)
      const original = exists ? await this.readText(path) : undefined

      this.fs.writeFile(path, this.serialize(singleton, data, original))
      const commit = await this.commit(
        options.message
          ?? this.commitMessage(singleton, { action: exists ? 'update' : 'create', name, path }),
      )
      return { path, commit }
    })
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

  private async commit(message: string): Promise<CommitResult> {
    let result: CommitResult
    try {
      if (!this.canEdit()) throw new Error('Start a change to edit content')
      result = await this.fs.commit(message)
    } catch (error) {
      // Leave nothing staged, so a failed save does not leak into the next commit.
      this.fs.discard()
      throw error
    }
    this.emit()
    return result
  }

  // Changes -------------------------------------------------------------------------------------

  private requireChanges(): Required<ChangesOptions> {
    if (!this.changes) throw new Error('Changes are not enabled: pass `changes` to createCms')
    return this.changes
  }

  private requireChange(): string {
    if (!this.state.inChange) throw new Error('No change is open')
    return this.state.branch
  }

  /** The open changes: branches with the change prefix, newest pull request info included. */
  async listChanges(): Promise<ChangeSummary[]> {
    const { branchPrefix } = this.requireChanges()
    const repository = this.fs.repository
    if (!repository.listBranches) return this.state.inChange ? [{ branch: this.state.branch, title: changeTitle(branchPrefix, this.state.branch) }] : []
    const [branches, pulls] = await Promise.all([
      repository.listBranches(),
      repository.listPullRequests?.({ base: this.baseBranch }).catch(() => []) ?? Promise.resolve([]),
    ])
    return branches
      .filter((branch) => branch.name.startsWith(branchPrefix) && branch.name !== this.baseBranch)
      .map((branch) => {
        const pullRequest = pulls.find((pull) => pull.head === branch.name)
        return {
          branch: branch.name,
          title: pullRequest?.title ?? changeTitle(branchPrefix, branch.name),
          ...(pullRequest ? { pullRequest } : {}),
        }
      })
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  /** Start a change: create its branch from the base branch, and switch to it. Returns the branch. */
  async startChange(title: string): Promise<string> {
    const { branchPrefix } = this.requireChanges()
    return this.exclusive(async () => {
      const repository = this.fs.repository
      const head = await repository.getLastCommitSha(this.baseBranch)
      const wanted = changeBranchName(branchPrefix, title)
      const taken = repository.listBranches
        ? new Set((await repository.listBranches()).map((entry) => entry.name))
        : undefined
      const exists = async (name: string) => {
        if (taken) return taken.has(name)
        try {
          await repository.getBranch(name)
          return true
        } catch (error) {
          if (error instanceof NotFoundError) return false
          throw error
        }
      }
      let branch = wanted
      for (let attempt = 2; await exists(branch); attempt++) branch = `${wanted}-${attempt}`
      await repository.createBranch(branch, head)
      this.fs.checkout(branch, { base: this.baseBranch })
      this.emit()
      return branch
    })
  }

  /** Edit the change on `branch`, or the base branch itself with `null`. */
  async switchTo(branch: string | null): Promise<void> {
    await this.exclusive(async () => {
      if (branch === null || branch === this.baseBranch) this.fs.checkout(this.baseBranch)
      else this.fs.checkout(branch, { base: this.baseBranch })
      this.emit()
    })
  }

  /** What the current change changed, as content: entries and singletons first, other files after. */
  async changedContent(): Promise<ContentChange[]> {
    return (await this.compareChange()).changes
  }

  /**
   * The current change compared to the base branch: what it changed (see `changedContent()`), its
   * commits (`ahead`) and the base branch's commits it does not include yet (`behind`).
   */
  async compareChange(): Promise<ChangeComparison> {
    if (!this.state.inChange) return { ahead: 0, behind: 0, changes: [] }
    const repository = this.fs.repository
    if (!repository.compareBranches) throw new Error('This repository cannot compare branches')
    const comparison = await repository.compareBranches(this.baseBranch, this.state.branch)
    const changes = await mapLimit(comparison.files, LIST_CONCURRENCY, async (file): Promise<ContentChange> => {
      const owner = this.contentAt(file.path)
      const change: ContentChange = {
        path: file.path,
        status: file.status,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        label: file.path,
      }
      if (!owner) return change
      change.contentType = owner.contentType
      if (owner.contentType.kind === 'singleton') return { ...change, label: owner.contentType.label }
      const slug = owner.slug ?? file.path
      change.slug = slug
      try {
        const source = file.status === 'removed'
          ? await this.readBaseText(file.path)
          : await this.readText(file.path)
        const label = source === null ? undefined : this.toFormData(owner.contentType, source)[owner.contentType.labelField]
        change.label = typeof label === 'string' && label.trim() ? label : slug
      } catch {
        change.label = slug
      }
      return change
    })
    const rank = (change: ContentChange) => (change.contentType ? 0 : 1)
    return {
      ahead: comparison.ahead,
      behind: comparison.behind,
      changes: changes.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)),
    }
  }

  /** The collection or singleton a path belongs to. */
  contentAt(path: string): { contentType: ContentType; slug?: string } | undefined {
    const singleton = this.singletons.find((entry) => entry.path === path)
    if (singleton) return { contentType: singleton }
    for (const collection of this.collections) {
      const prefix = collection.folder ? `${collection.folder}/` : ''
      const suffix = `.${collection.extension}`
      if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue
      const slug = path.slice(prefix.length, -suffix.length)
      if (isValidSlug(slug)) return { contentType: collection, slug }
    }
    return undefined
  }

  /** An entry as it is on the base branch, or `null` when it does not exist there. */
  async readBaseEntry(name: string, slug: string): Promise<LoadedDocument | null> {
    const collection = this.getCollection(name)
    const path = this.entryPath(collection, slug)
    const source = await this.readBaseText(path)
    return source === null ? null : this.load(collection, path, source)
  }

  /** A singleton as it is on the base branch, or `null` when it does not exist there. */
  async readBaseSingleton(name: string): Promise<LoadedDocument | null> {
    const singleton = this.getSingleton(name)
    const source = await this.readBaseText(singleton.path)
    return source === null ? null : this.load(singleton, singleton.path, source)
  }

  private async readBaseText(path: string): Promise<string | null> {
    try {
      return new TextDecoder().decode((await this.fs.repository.getFile(this.baseBranch, path)).content)
    } catch (error) {
      if (error instanceof NotFoundError) return null
      throw error
    }
  }

  /** The current change's pull request: the open one, else the most recent. `null` when it has none. */
  async pullRequest(): Promise<PullRequestInfo | null> {
    const branch = this.requireChange()
    const repository = this.fs.repository
    if (!repository.listPullRequests) return null
    const pulls = await repository.listPullRequests({ head: branch, base: this.baseBranch, state: 'all' })
    const latest = pulls.find((pull) => pull.state === 'open')
      ?? pulls.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    if (!latest) return null
    // Lists leave out whether it merges cleanly; a single pull request has it.
    return repository.getPullRequest ? repository.getPullRequest(latest.number) : latest
  }

  /** Ask for review: open a pull request from the current change into the base branch. */
  async openPullRequest(options: { title?: string; body?: string; draft?: boolean } = {}): Promise<PullRequestInfo> {
    const { branchPrefix } = this.requireChanges()
    const branch = this.requireChange()
    const repository = this.fs.repository
    if (!repository.createPullRequest) throw new Error('This repository cannot open pull requests')
    const pull = await repository.createPullRequest({
      head: branch,
      base: this.baseBranch,
      title: options.title?.trim() || changeTitle(branchPrefix, branch),
      body: options.body,
      draft: options.draft,
    })
    this.emit()
    return pull
  }

  /**
   * Merge `base` into the current change, so it includes what was published since it started.
   * `null` when it already did. Throws a `ConflictError` when both changed the same file.
   */
  async updateChange(): Promise<MergeResult | null> {
    this.requireChange()
    return this.exclusive(async () => {
      const result = await this.fs.updateFromBase(`Update from ${this.baseBranch}`)
      if (result) this.emit()
      return result
    })
  }

  /**
   * Publish the current change: merge its open pull request (or, on hosts without pull requests,
   * the branch itself) into the base branch, delete the branch, and switch back to the base.
   */
  async publishChange(options: { message?: string } = {}): Promise<MergeResult> {
    const branch = this.requireChange()
    const repository = this.fs.repository
    return this.exclusive(async () => {
      let result: MergeResult | null
      const pull = repository.listPullRequests
        ? (await repository.listPullRequests({ head: branch, base: this.baseBranch }))[0]
        : undefined
      if (pull && repository.mergePullRequest) {
        result = await repository.mergePullRequest(pull.number, { message: options.message })
      } else if (repository.mergeBranch) {
        result = await repository.mergeBranch({ into: this.baseBranch, from: branch, message: options.message })
      } else {
        throw new Error('This repository can neither merge pull requests nor branches')
      }
      await this.deleteBranch(branch)
      this.fs.checkout(this.baseBranch)
      this.emit()
      return result ?? { sha: await repository.getLastCommitSha(this.baseBranch), date: new Date().toISOString() }
    })
  }

  /** Throw the current change away: close its pull request, delete its branch, and switch back. */
  async discardChange(): Promise<void> {
    const branch = this.requireChange()
    const repository = this.fs.repository
    await this.exclusive(async () => {
      if (repository.listPullRequests && repository.closePullRequest) {
        for (const pull of await repository.listPullRequests({ head: branch, base: this.baseBranch })) {
          await repository.closePullRequest(pull.number)
        }
      }
      await this.deleteBranch(branch)
      this.fs.checkout(this.baseBranch)
      this.emit()
    })
  }

  private async deleteBranch(branch: string): Promise<void> {
    try {
      await this.fs.repository.deleteBranch(branch)
    } catch (error) {
      // Hosts can delete merged branches themselves.
      if (!(error instanceof NotFoundError)) throw error
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
