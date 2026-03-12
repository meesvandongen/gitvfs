import type { GitProvider, TreeEntry, FileContent, CommitResult } from './types/provider.js'
import type { GitFSOptions, CacheConfig } from './types/options.js'
import type { CacheAdapter } from './cache/types.js'
import { ChangeBuffer, type Change } from './change-buffer.js'
import { CacheManager } from './cache/manager.js'
import { MemoryCacheAdapter } from './cache/memory.js'
import { NoneCacheAdapter } from './cache/none.js'
import { NotFoundError } from './types/errors.js'
import { normalize } from './utils/path.js'
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

function createCacheAdapter(
  cache: GitFSOptions['cache'],
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

export class GitFS {
  private provider: GitProvider
  private readBranch: string
  private writeBranch: string
  private buffer = new ChangeBuffer()
  private cache: CacheManager
  private tree: TreeEntry[] | null = null
  private headSha: string | null = null

  private autoCommit: boolean
  private autoCommitDelay: number
  private commitMessageFn?: (changes: Change[]) => string
  private autoCommitTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: GitFSOptions) {
    this.provider = options.provider
    this.readBranch = options.branch
    this.writeBranch = options.writeBranch ?? options.branch
    this.autoCommit = options.autoCommit ?? false
    this.autoCommitDelay = options.autoCommitDelay ?? 2000
    this.commitMessageFn = options.commitMessage

    const adapter = createCacheAdapter(options.cache)
    this.cache = new CacheManager(adapter, `${options.branch}`)
  }

  /** Ensure the tree is loaded for reads. */
  private async ensureTree(): Promise<TreeEntry[]> {
    if (this.tree) return this.tree

    // Check cache first
    const cachedHead = await this.cache.getHeadSha(this.readBranch)
    const currentHead = await this.provider.getLastCommitSha(this.readBranch)

    if (cachedHead === currentHead) {
      const cachedTree = await this.cache.getTree(this.readBranch)
      if (cachedTree) {
        this.tree = cachedTree
        this.headSha = currentHead
        return this.tree
      }
    }

    this.tree = await this.provider.getTree(this.readBranch)
    this.headSha = currentHead
    await this.cache.setHeadSha(this.readBranch, currentHead)
    await this.cache.setTree(this.readBranch, this.tree)
    return this.tree
  }

  private findTreeEntry(path: string): TreeEntry | undefined {
    return this.tree?.find((e) => e.path === normalize(path))
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
    }

    await this.ensureTree()
    const entry = this.findTreeEntry(normalized)
    if (!entry || entry.type !== 'blob') {
      throw new NotFoundError(`File not found: ${normalized}`)
    }

    // Check file cache
    const cached = await this.cache.getFileContent(entry.sha, normalized)
    if (cached) {
      return options?.encoding === 'utf-8' ? decodeText(cached.content) : cached.content
    }

    // Fetch from provider
    const file = await this.provider.getFile(this.readBranch, normalized)
    await this.cache.setFileContent(file.sha, normalized, file)

    return options?.encoding === 'utf-8' ? decodeText(file.content) : file.content
  }

  /** List directory entries. */
  async readdir(path: string): Promise<DirEntry[]> {
    const normalized = normalize(path)
    await this.ensureTree()

    const prefix = normalized ? `${normalized}/` : ''
    const entries = new Map<string, DirEntry>()

    // Add entries from tree
    for (const entry of this.tree!) {
      if (!entry.path.startsWith(prefix)) continue
      const rest = entry.path.slice(prefix.length)
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

    await this.ensureTree()
    return this.findTreeEntry(normalized) !== undefined
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

    await this.ensureTree()
    const entry = this.findTreeEntry(normalized)
    if (!entry) {
      throw new NotFoundError(`Not found: ${normalized}`)
    }
    return { type: entry.type, sha: entry.sha, size: entry.size }
  }

  /** Prefetch the tree and optionally file contents into cache. */
  async prefetch(): Promise<void> {
    const tree = await this.ensureTree()
    const blobPaths = tree.filter((e) => e.type === 'blob').map((e) => e.path)

    if (blobPaths.length === 0) return

    const files = await this.provider.getFiles(this.readBranch, blobPaths)
    for (const [path, file] of files) {
      await this.cache.setFileContent(file.sha, path, file)
    }
  }

  /** Stage a file write (no API call yet). */
  writeFile(path: string, content: string | Uint8Array): void {
    const normalized = normalize(path)
    const existing = this.tree?.find((e) => e.path === normalized)
    this.buffer.add({
      action: existing ? 'update' : 'create',
      path: normalized,
      content,
    })
    this.scheduleAutoCommit()
  }

  /** Stage a file deletion. */
  rm(path: string): void {
    this.buffer.add({ action: 'delete', path: normalize(path) })
    this.scheduleAutoCommit()
  }

  /** Stage a rename (move). */
  rename(oldPath: string, newPath: string): void {
    const normOld = normalize(oldPath)
    const normNew = normalize(newPath)

    // If the file has pending content in the buffer, use that
    const existing = this.buffer.get(normOld)
    if (existing && existing.content !== undefined) {
      this.buffer.add({ action: 'delete', path: normOld })
      this.buffer.add({ action: 'create', path: normNew, content: existing.content })
    } else {
      this.buffer.add({
        action: 'move',
        path: normNew,
        previousPath: normOld,
      })
      // Also mark old path as deleted for overlay
      this.buffer.add({ action: 'delete', path: normOld })
    }
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
    const changes = this.buffer.all()
    if (changes.length === 0) {
      throw new Error('No changes to commit')
    }

    // Ensure we have the head SHA for the write branch
    let headSha: string
    try {
      headSha = await this.provider.getLastCommitSha(this.writeBranch)
    } catch {
      // Write branch doesn't exist yet — create it from read branch
      const readHead = await this.provider.getLastCommitSha(this.readBranch)
      await this.provider.createBranch(this.writeBranch, readHead)
      headSha = readHead
    }

    const result = await this.provider.commit({
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

    // Update cache with new file SHAs
    for (const [path, info] of Object.entries(result.files)) {
      const change = changes.find((c) => c.path === path)
      if (change?.content !== undefined) {
        const bytes =
          change.content instanceof Uint8Array ? change.content : encodeText(change.content)
        await this.cache.setFileContent(info.sha, path, {
          path,
          sha: info.sha,
          content: bytes,
          size: bytes.length,
        })
      }
    }

    // Invalidate tree cache for the write branch
    await this.cache.setHeadSha(this.writeBranch, result.sha)
    this.buffer.clear()
    this.tree = null // Force re-fetch on next read

    return result
  }

  /** Create a new branch from the current read branch. */
  async createBranch(name: string): Promise<void> {
    const headSha = await this.provider.getLastCommitSha(this.readBranch)
    await this.provider.createBranch(name, headSha)
  }

  /** Switch the read branch (and optionally the write branch). */
  checkout(branch: string): void {
    this.readBranch = branch
    this.writeBranch = branch
    this.tree = null
    this.headSha = null
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
