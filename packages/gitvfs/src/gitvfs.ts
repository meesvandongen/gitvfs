import type {
  GitRepository,
  TreeEntry,
  FileContent,
  CommitResult,
  MergeResult,
  ReadDirOptions,
} from './types/provider.js'
import type { GitVFSOptions, CacheConfig } from './types/options.js'
import type { CacheAdapter } from './cache/types.js'
import { ChangeBuffer, type Change } from './change-buffer.js'
import { CacheManager } from './cache/manager.js'
import { MemoryCacheAdapter } from './cache/memory.js'
import { NoneCacheAdapter } from './cache/none.js'
import { GitVFSError, NotFoundError } from './types/errors.js'
import { basename, dirname, normalize } from './utils/path.js'
import { encodeText, decodeText } from './utils/encoding.js'

export interface DirEntry {
  name: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
}

export interface StatResult {
  type: 'blob' | 'tree'
  size?: number
  sha: string
}

/** Which branches a `GitVFS` works with; see `GitVFS.branches()`. */
export interface BranchState {
  /** The `branch` option: where the write branch starts, and what `updateFromBase()` merges in. */
  base: string
  /** Where commits go. Equal to `base` unless there is a separate write branch. */
  write: string
  /** Where reads come from right now: `write` once it exists, else `base`. */
  read: string
}

export interface ReadDirResultOptions {
  recursive?: boolean
}

function createCacheAdapter(
  cache: GitVFSOptions['cache'],
): CacheAdapter {
  if (!cache || cache === 'memory') return new MemoryCacheAdapter()
  if (cache === 'none') return new NoneCacheAdapter()
  if (cache === 'indexeddb') {
    // Dynamic import handled at the caller level; fall back to memory
    return new MemoryCacheAdapter()
  }
  if (typeof cache === 'object' && 'get' in cache) {
    return cache as CacheAdapter
  }
  const config = cache as CacheConfig
  if (config.backend === 'none') return new NoneCacheAdapter()
  return new MemoryCacheAdapter()
}

export class GitVFS {
  /** The repository this works on, for what `GitVFS` does not wrap (branches, pull requests). */
  readonly repository: GitRepository
  /** The `branch` option: where the write branch starts, and what `updateFromBase()` merges in. */
  private baseBranch: string
  private writeBranch: string
  /** Where reads come from: the write branch once it exists, else the base branch. */
  private readBranch: string
  private buffer = new ChangeBuffer()
  private cache: CacheManager
  private knownEntries = new Map<string, TreeEntry>()
  private headSha: string | null = null
  private lastHeadValidationAt = 0
  private headValidationIntervalMs: number

  private autoCommit: boolean
  private autoCommitDelay: number
  private commitMessageFn?: (changes: Change[]) => string
  private autoCommitTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: GitVFSOptions) {
    this.repository = options.repository
    this.baseBranch = options.branch
    this.writeBranch = options.writeBranch ?? options.branch
    this.readBranch = options.branch
    this.headValidationIntervalMs = options.headValidationIntervalMs ?? 30_000
    this.autoCommit = options.autoCommit ?? false
    this.autoCommitDelay = options.autoCommitDelay ?? 2000
    this.commitMessageFn = options.commitMessage

    const adapter = createCacheAdapter(options.cache)
    this.cache = new CacheManager(adapter, `${options.branch}`)
  }

  /**
   * The branch to read from and its head: the write branch once it exists, so commits made there
   * stay visible, else the base branch it will be created from.
   */
  private async resolveReadHead(): Promise<{ branch: string; sha: string }> {
    if (this.writeBranch !== this.baseBranch) {
      try {
        return { branch: this.writeBranch, sha: await this.repository.getLastCommitSha(this.writeBranch) }
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error
      }
    }
    return { branch: this.baseBranch, sha: await this.repository.getLastCommitSha(this.baseBranch) }
  }

  private async ensureCacheFresh(): Promise<string> {
    const now = Date.now()

    if (
      this.headSha !== null
      && now - this.lastHeadValidationAt < this.headValidationIntervalMs
    ) {
      return this.headSha
    }

    const { branch, sha: currentHead } = await this.resolveReadHead()
    const switched = branch !== this.readBranch
    this.readBranch = branch
    // Known entries are not tracked per branch: forget the old branch's.
    if (switched) this.knownEntries.clear()
    const cachedHead = (switched ? null : this.headSha) ?? await this.cache.getHeadSha(branch)

    if (cachedHead !== currentHead) {
      await this.cache.clear()
      this.knownEntries.clear()
    }

    this.headSha = currentHead
    this.lastHeadValidationAt = now
    await this.cache.setHeadSha(branch, currentHead)
    return currentHead
  }

  private rememberEntries(entries: TreeEntry[]): void {
    for (const entry of entries) {
      this.knownEntries.set(normalize(entry.path), {
        ...entry,
        path: normalize(entry.path),
      })
    }
  }

  private rememberFile(file: FileContent): void {
    this.knownEntries.set(normalize(file.path), {
      path: normalize(file.path),
      type: 'blob',
      sha: file.sha,
      size: file.size,
    })
  }

  private rememberSyntheticDirectories(path: string): void {
    const normalized = normalize(path)
    if (!normalized) return

    const parts = normalized.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/')
      if (!this.knownEntries.has(dirPath)) {
        this.knownEntries.set(dirPath, { path: dirPath, type: 'tree', sha: '', size: undefined })
      }
    }
  }

  private async ensureDir(path: string, options?: ReadDirOptions): Promise<TreeEntry[]> {
    const normalized = normalize(path)
    const recursive = options?.recursive ?? false

    await this.ensureCacheFresh()

    const cachedEntries = await this.cache.getDirEntries(this.readBranch, normalized, recursive)
    if (cachedEntries) {
      this.rememberEntries(cachedEntries)
      return cachedEntries
    }

    const entries = await this.repository.readdir(this.readBranch, normalized, options)
    this.rememberEntries(entries)
    this.rememberSyntheticDirectories(normalized)
    await this.cache.setDirEntries(this.readBranch, normalized, entries, recursive)
    return entries
  }

  private async findEntry(path: string): Promise<TreeEntry | undefined> {
    const normalized = normalize(path)
    if (!normalized) {
      return { path: '', type: 'tree', sha: '', size: undefined }
    }

    await this.ensureCacheFresh()

    const known = this.knownEntries.get(normalized)
    if (known) {
      return known
    }

    const parentPath = dirname(normalized)
    const childName = basename(normalized)

    try {
      const entries = await this.ensureDir(parentPath)
      return entries.find((entry) => basename(entry.path) === childName)
    } catch {
      return undefined
    }
  }

  /** Read a file. Pending writes overlay remote content. */
  async readFile(path: string, options?: { encoding: 'utf-8' }): Promise<Uint8Array | string> {
    const normalized = normalize(path)

    // Check buffer first (overlay)
    const change = this.buffer.get(normalized)
    if (change) {
      if (change.action === 'delete') {
        throw new NotFoundError(`File not found: ${normalized}`)
      }
      if (change.content !== undefined) {
        if (options?.encoding === 'utf-8') {
          return change.content instanceof Uint8Array
            ? decodeText(change.content)
            : change.content
        }
        return change.content instanceof Uint8Array
          ? change.content
          : encodeText(change.content)
      }
      if (change.action === 'move' && change.previousPath) {
        // A pending rename: the content still lives at the old path remotely.
        const content = await this.readRemote(change.previousPath)
        return options?.encoding === 'utf-8' ? decodeText(content) : content
      }
    }

    const content = await this.readRemote(normalized)
    return options?.encoding === 'utf-8' ? decodeText(content) : content
  }

  /** Read a file from the read branch, ignoring pending changes. */
  private async readRemote(normalized: string): Promise<Uint8Array> {
    const entry = await this.findEntry(normalized)
    if (!entry || entry.type !== 'blob') {
      throw new NotFoundError(`File not found: ${normalized}`)
    }

    // Check file cache
    const cached = await this.cache.getFileContent(this.readBranch, normalized)
    if (cached) {
      this.rememberFile(cached)
      return cached.content
    }

    // Fetch from the repository
    const file = await this.repository.getFile(this.readBranch, normalized)
    this.rememberFile(file)
    this.rememberSyntheticDirectories(normalized)
    await this.cache.setFileContent(this.readBranch, normalized, file)
    return file.content
  }

  /** List directory entries. */
  async readdir(path: string, options?: ReadDirResultOptions): Promise<DirEntry[]> {
    const normalized = normalize(path)
    const recursive = options?.recursive ?? false
    const treeEntries = await this.ensureDir(normalized, options)

    const prefix = normalized ? `${normalized}/` : ''
    const entries = new Map<string, DirEntry>()

    // Add entries from the repository's directory listing
    for (const entry of treeEntries) {
      if (!entry.path.startsWith(prefix)) continue
      const rest = entry.path.slice(prefix.length)
      if (!rest) continue

      if (recursive) {
        if (!this.buffer.isDeleted(entry.path)) {
          entries.set(rest, {
            name: rest,
            type: entry.type,
            sha: entry.sha,
            size: entry.size,
          })
        }
        continue
      }

      const slashIdx = rest.indexOf('/')
      if (slashIdx === -1 && rest) {
        // Direct child
        if (!this.buffer.isDeleted(entry.path)) {
          entries.set(rest, {
            name: rest,
            type: entry.type,
            sha: entry.sha,
            size: entry.size,
          })
        }
      } else if (slashIdx > 0) {
        // Directory child
        const dirName = rest.slice(0, slashIdx)
        if (!entries.has(dirName)) {
          entries.set(dirName, { name: dirName, type: 'tree', sha: '', size: undefined })
        }
      }
    }

    // Overlay buffer additions
    for (const change of this.buffer.all()) {
      if (change.action === 'delete') continue
      if (!change.path.startsWith(prefix)) continue
      const rest = change.path.slice(prefix.length)
      if (!rest) continue

      if (recursive) {
        entries.set(rest, { name: rest, type: 'blob', sha: '', size: undefined })
        this.rememberSyntheticDirectories(change.path)
        continue
      }

      const slashIdx = rest.indexOf('/')
      if (slashIdx === -1 && rest) {
        entries.set(rest, { name: rest, type: 'blob', sha: '', size: undefined })
      } else if (slashIdx > 0) {
        const dirName = rest.slice(0, slashIdx)
        if (!entries.has(dirName)) {
          entries.set(dirName, { name: dirName, type: 'tree', sha: '', size: undefined })
        }
      }
    }

    return Array.from(entries.values())
  }

  /** Check if a file or directory exists. */
  async exists(path: string): Promise<boolean> {
    const normalized = normalize(path)

    // Check buffer
    const change = this.buffer.get(normalized)
    if (change) {
      return change.action !== 'delete'
    }

    return (await this.findEntry(normalized)) !== undefined
  }

  /** Get file/directory metadata. */
  async stat(path: string): Promise<StatResult> {
    const normalized = normalize(path)

    // Check buffer
    const change = this.buffer.get(normalized)
    if (change) {
      if (change.action === 'delete') {
        throw new NotFoundError(`Not found: ${normalized}`)
      }
      return { type: 'blob', sha: '', size: undefined }
    }

    const entry = await this.findEntry(normalized)
    if (!entry) {
      throw new NotFoundError(`Not found: ${normalized}`)
    }
    return { type: entry.type, sha: entry.sha, size: entry.size }
  }

  /** Prefetch the tree and optionally file contents into cache. */
  async prefetch(): Promise<void> {
    const tree = await this.ensureDir('', { recursive: true })
    const blobPaths = tree.filter((e) => e.type === 'blob').map((e) => e.path)

    if (blobPaths.length === 0) return

    const files = await this.repository.getFiles(this.readBranch, blobPaths)
    for (const [path, file] of files) {
      this.rememberFile(file)
      await this.cache.setFileContent(this.readBranch, path, file)
    }
  }

  /** Stage a file write (no API call yet). */
  writeFile(path: string, content: string | Uint8Array): void {
    const normalized = normalize(path)
    const existing = this.knownEntries.get(normalized)
    this.buffer.add({
      action: existing ? 'update' : 'create',
      path: normalized,
      content,
    })
    this.rememberSyntheticDirectories(normalized)
    this.scheduleAutoCommit()
  }

  /** Stage a file deletion. */
  rm(path: string): void {
    this.buffer.add({ action: 'delete', path: normalize(path) })
    this.scheduleAutoCommit()
  }

  /** Stage a rename (move). Pending edits to the file move along with it. */
  rename(oldPath: string, newPath: string): void {
    const normOld = normalize(oldPath)
    const normNew = normalize(newPath)
    if (normOld === normNew) return

    const existing = this.buffer.get(normOld)
    if (existing?.action === 'move') {
      // Renamed again: keep moving from the original path, whose deletion is already staged.
      this.buffer.remove(normOld)
      this.buffer.add({ ...existing, path: normNew })
    } else {
      this.buffer.add({ action: 'move', path: normNew, previousPath: normOld, content: existing?.content })
      // Mark the old path as deleted for overlay reads; the move implies it at commit time.
      this.buffer.add({ action: 'delete', path: normOld })
    }
    this.rememberSyntheticDirectories(normNew)
    this.scheduleAutoCommit()
  }

  /** Get pending changes (synchronous). */
  status(): Array<{ path: string; action: string }> {
    return this.buffer.all().map((c) => ({ path: c.path, action: c.action }))
  }

  /** Discard all pending changes. */
  discard(): void {
    this.buffer.clear()
  }

  /** Commit pending changes to the remote. */
  async commit(message: string): Promise<CommitResult> {
    if (this.buffer.size === 0) {
      throw new Error('No changes to commit')
    }
    const changes = await this.resolveChanges()

    let headSha: string
    try {
      headSha = await this.repository.getLastCommitSha(this.writeBranch)
    } catch (error) {
      if (!(error instanceof NotFoundError) || this.writeBranch === this.baseBranch) throw error
      // The write branch doesn't exist yet: create it from the base branch.
      headSha = await this.repository.getLastCommitSha(this.baseBranch)
      await this.repository.createBranch(this.writeBranch, headSha)
    }

    const result = await this.repository.commit({
      branch: this.writeBranch,
      message,
      changes: changes.map((c) => ({
        action: c.action,
        path: c.path,
        content: c.content,
        previousPath: c.previousPath,
      })),
      expectedHeadOid: headSha,
    })

    await this.cache.clear()
    this.buffer.clear()
    this.knownEntries.clear()
    // From now on reads come from the write branch, which now points at this commit.
    this.readBranch = this.writeBranch
    this.headSha = result.sha
    this.lastHeadValidationAt = Date.now()
    await this.cache.setHeadSha(this.writeBranch, result.sha)

    // Cache what was just written, so it need not be fetched again.
    for (const [path, info] of Object.entries(result.files)) {
      const change = changes.find((c) => c.path === path)
      if (change?.content !== undefined) {
        const bytes =
          change.content instanceof Uint8Array ? change.content : encodeText(change.content)
        const file = {
          path,
          sha: info.sha,
          content: bytes,
          size: bytes.length,
        }
        this.rememberFile(file)
        await this.cache.setFileContent(this.writeBranch, path, file)
      }
    }

    return result
  }

  /**
   * The pending changes as repositories need them. Moves carry the file's content, since not every
   * host can move a file without it (GitHub's API cannot), and imply the deletion that
   * `rename` stages for overlay reads. A move from a path that never existed remotely, such as a
   * file created in this batch, is a plain create.
   */
  private async resolveChanges(): Promise<Change[]> {
    const pending = this.buffer.all()
    const movedFrom = new Set(
      pending.filter((c) => c.action === 'move' && c.previousPath).map((c) => c.previousPath),
    )
    const changes: Change[] = []
    for (const change of pending) {
      if (change.action === 'delete' && movedFrom.has(change.path)) continue
      if (change.action !== 'move' || !change.previousPath) {
        changes.push(change)
        continue
      }
      const sourceExists = (await this.findEntry(change.previousPath))?.type === 'blob'
      if (!sourceExists) {
        if (change.content === undefined) throw new NotFoundError(`File not found: ${change.previousPath}`)
        changes.push({ action: 'create', path: change.path, content: change.content })
      } else if (change.content === undefined) {
        changes.push({ ...change, content: await this.readRemote(change.previousPath) })
      } else {
        changes.push(change)
      }
    }
    return changes
  }

  /** Create a new branch from the current read branch. */
  async createBranch(name: string): Promise<void> {
    const { sha } = await this.resolveReadHead()
    await this.repository.createBranch(name, sha)
  }

  /** The base, write and read branch. */
  branches(): BranchState {
    return { base: this.baseBranch, write: this.writeBranch, read: this.readBranch }
  }

  /**
   * Switch to `branch`: it becomes the base, read and write branch. With `base`, `branch` becomes
   * the write branch on top of `base` instead, as if passed as `writeBranch`.
   */
  checkout(branch: string, options: { base?: string } = {}): void {
    this.baseBranch = options.base ?? branch
    this.readBranch = this.baseBranch
    this.writeBranch = branch
    this.knownEntries.clear()
    this.headSha = null
    this.lastHeadValidationAt = 0
  }

  /**
   * Merge the latest `branch` into `writeBranch` on the host, so the write branch picks up what
   * changed there since it was created. Returns the merge commit, or `null` when there was nothing
   * to merge (or the write branch does not exist yet, so reads already come from `branch`).
   * Staged changes stay staged. Throws a `ConflictError` when both branches changed the same file;
   * resolve that on the host, for example in the pull request.
   */
  async updateFromBase(message?: string): Promise<MergeResult | null> {
    if (this.writeBranch === this.baseBranch) {
      throw new GitVFSError('updateFromBase() needs a writeBranch different from branch', 'NOT_SUPPORTED')
    }
    if (!this.repository.mergeBranch) {
      throw new GitVFSError('This repository cannot merge branches', 'NOT_SUPPORTED')
    }

    let result: MergeResult | null
    try {
      result = await this.repository.mergeBranch({ into: this.writeBranch, from: this.baseBranch, message })
    } catch (error) {
      // No write branch yet: reads already come from the base branch.
      if (error instanceof NotFoundError && !(await this.writeBranchExists())) return null
      throw error
    }

    if (result) {
      // The write branch moved: revalidate (and drop the cache) on the next read.
      this.knownEntries.clear()
      this.headSha = null
      this.lastHeadValidationAt = 0
    }
    return result
  }

  private async writeBranchExists(): Promise<boolean> {
    try {
      await this.repository.getBranch(this.writeBranch)
      return true
    } catch (error) {
      if (error instanceof NotFoundError) return false
      throw error
    }
  }

  private scheduleAutoCommit(): void {
    if (!this.autoCommit) return

    if (this.autoCommitTimer) {
      clearTimeout(this.autoCommitTimer)
    }

    this.autoCommitTimer = setTimeout(async () => {
      this.autoCommitTimer = null
      const changes = this.buffer.all()
      if (changes.length === 0) return

      const message = this.commitMessageFn
        ? this.commitMessageFn(changes)
        : `Update ${changes.length} file(s)`
      await this.commit(message)
    }, this.autoCommitDelay)
  }
}

