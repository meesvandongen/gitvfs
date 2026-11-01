const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** UTF-8 text, or null for binary content (GitHub's GraphQL `Blob.text` behaves the same). */
export function toText(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

async function sha1(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Git's object id for a blob: SHA-1 of `blob <size>\0<content>`. */
export async function blobSha(content: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${content.length}\0`)
  const object = new Uint8Array(header.length + content.length)
  object.set(header)
  object.set(content, header.length)
  return sha1(object)
}

export interface CommitRecord {
  tree: string
  parent: string | null
  message: string
  date: string
}

/** Everything the mock knows, as plain JSON so it can be saved to browser storage. */
export interface RepositoryState {
  version: 1
  branches: Record<string, string>
  commits: Record<string, CommitRecord>
  /** Tree id → path → blob id. Trees are flat: one entry per file. */
  trees: Record<string, Record<string, string>>
  /** Blob id → base64 content. */
  blobs: Record<string, string>
}

export interface FileEntry {
  path: string
  sha: string
  size: number
  content: Uint8Array
}

export interface DirectoryEntry {
  path: string
  type: 'file' | 'dir'
  sha: string
  size?: number
}

export interface CommitInput {
  branch: string
  message: string
  /** When set, the commit fails unless the branch still points here (GitHub's `expectedHeadOid`). */
  expectedHeadOid?: string
  additions?: Array<{ path: string; content: Uint8Array }>
  deletions?: string[]
}

export class StaleHeadError extends Error {
  constructor(branch: string, expected: string, actual: string) {
    super(`Expected branch ${branch} to point to "${expected}" but it did not (it points to "${actual}")`)
    this.name = 'StaleHeadError'
  }
}

function normalizePath(path: string): string {
  return path.split('/').filter(Boolean).join('/')
}

/** A tiny Git repository in memory: branches, commits, flat trees and blobs. */
export class MockRepository {
  private constructor(private state: RepositoryState) {}

  /** Start a repository with one commit holding `files` (text or bytes). */
  static async create(options: {
    files: Record<string, string | Uint8Array>
    branch?: string
    message?: string
  }): Promise<MockRepository> {
    const repository = new MockRepository({ version: 1, branches: {}, commits: {}, trees: {}, blobs: {} })
    const branch = options.branch ?? 'main'
    const tree: Record<string, string> = {}
    for (const [path, content] of Object.entries(options.files)) {
      tree[normalizePath(path)] = await repository.storeBlob(typeof content === 'string' ? encoder.encode(content) : content)
    }
    const treeSha = await repository.storeTree(tree)
    repository.state.branches[branch] = await repository.storeCommit({
      tree: treeSha,
      parent: null,
      message: options.message ?? 'Initial commit',
      date: new Date().toISOString(),
    })
    return repository
  }

  /** Restore a repository saved with `toJSON()`. */
  static fromJSON(state: RepositoryState): MockRepository {
    if (state?.version !== 1) throw new Error('Unsupported repository state')
    return new MockRepository(structuredClone(state))
  }

  toJSON(): RepositoryState {
    return structuredClone(this.state)
  }

  /** Replace everything with another state, keeping this object (and handlers using it). */
  replaceWith(state: RepositoryState | MockRepository): void {
    this.state = structuredClone(state instanceof MockRepository ? state.state : state)
  }

  branchHead(branch: string): string | undefined {
    return this.state.branches[branch]
  }

  branchNames(): string[] {
    return Object.keys(this.state.branches)
  }

  /** A branch name or a commit id. */
  resolve(ref: string): string | undefined {
    if (this.state.branches[ref]) return this.state.branches[ref]
    return this.state.commits[ref] ? ref : undefined
  }

  getCommit(sha: string): CommitRecord | undefined {
    return this.state.commits[sha]
  }

  getTree(sha: string): Record<string, string> | undefined {
    return this.state.trees[sha]
  }

  getBlob(sha: string): Uint8Array | undefined {
    const base64 = this.state.blobs[sha]
    return base64 === undefined ? undefined : fromBase64(base64)
  }

  /** The files of a commit, as path → blob id. */
  files(ref: string): Record<string, string> | undefined {
    const commit = this.resolve(ref)
    return commit ? this.state.trees[this.state.commits[commit].tree] : undefined
  }

  readFile(ref: string, path: string): FileEntry | undefined {
    const sha = this.files(ref)?.[normalizePath(path)]
    if (!sha) return undefined
    const content = this.getBlob(sha)!
    return { path: normalizePath(path), sha, size: content.length, content }
  }

  /** A directory's direct children, the file itself for a file path, or undefined. */
  list(ref: string, path: string): DirectoryEntry[] | DirectoryEntry | undefined {
    const files = this.files(ref)
    if (!files) return undefined
    const target = normalizePath(path)
    if (target && files[target]) {
      const size = this.getBlob(files[target])!.length
      return { path: target, type: 'file', sha: files[target], size }
    }

    const prefix = target ? `${target}/` : ''
    const entries = new Map<string, DirectoryEntry>()
    for (const [filePath, sha] of Object.entries(files)) {
      if (!filePath.startsWith(prefix)) continue
      const rest = filePath.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        entries.set(filePath, { path: filePath, type: 'file', sha, size: this.getBlob(sha)!.length })
      } else {
        const dir = prefix + rest.slice(0, slash)
        if (!entries.has(dir)) entries.set(dir, { path: dir, type: 'dir', sha: '' })
      }
    }
    if (target && entries.size === 0) return undefined
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Commit additions and deletions on top of a branch, like GitHub's `createCommitOnBranch`. */
  async commit(input: CommitInput): Promise<{ oid: string; date: string }> {
    const head = this.state.branches[input.branch]
    if (!head) throw new Error(`Branch not found: ${input.branch}`)
    if (input.expectedHeadOid && input.expectedHeadOid !== head) {
      throw new StaleHeadError(input.branch, input.expectedHeadOid, head)
    }

    const tree = { ...this.state.trees[this.state.commits[head].tree] }
    // Duplicate paths are tolerated rather than rejected.
    for (const path of new Set(input.deletions ?? [])) {
      const normalized = normalizePath(path)
      if (!tree[normalized]) throw new Error(`A path was requested for deletion which does not exist: ${normalized}`)
      delete tree[normalized]
    }
    for (const { path, content } of input.additions ?? []) {
      tree[normalizePath(path)] = await this.storeBlob(content)
    }

    const date = new Date().toISOString()
    const oid = await this.storeCommit({ tree: await this.storeTree(tree), parent: head, message: input.message, date })
    this.state.branches[input.branch] = oid
    return { oid, date }
  }

  createBranch(name: string, fromSha: string): void {
    if (this.state.branches[name]) throw new Error('Reference already exists')
    if (!this.state.commits[fromSha]) throw new Error('Object does not exist')
    this.state.branches[name] = fromSha
  }

  deleteBranch(name: string): boolean {
    if (!this.state.branches[name]) return false
    delete this.state.branches[name]
    return true
  }

  /** Newest first. */
  log(ref: string, limit = 50): Array<CommitRecord & { sha: string }> {
    const result: Array<CommitRecord & { sha: string }> = []
    let sha = this.resolve(ref) ?? null
    while (sha && result.length < limit) {
      const commit = this.state.commits[sha]
      result.push({ sha, ...commit })
      sha = commit.parent
    }
    return result
  }

  private async storeBlob(content: Uint8Array): Promise<string> {
    const sha = await blobSha(content)
    this.state.blobs[sha] = toBase64(content)
    return sha
  }

  private async storeTree(tree: Record<string, string>): Promise<string> {
    const sorted = Object.fromEntries(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)))
    const sha = await sha1(encoder.encode(`tree ${JSON.stringify(sorted)}`))
    this.state.trees[sha] = sorted
    return sha
  }

  private async storeCommit(commit: CommitRecord): Promise<string> {
    const nonce = toBase64(crypto.getRandomValues(new Uint8Array(8)))
    const sha = await sha1(encoder.encode(`commit ${JSON.stringify(commit)} ${nonce}`))
    this.state.commits[sha] = commit
    return sha
  }
}
