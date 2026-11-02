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
  /** A merge commit's second parent: the commit that was merged in. */
  mergeParent?: string
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
  /** Pull requests, oldest first. Absent in states saved before they existed. */
  pulls?: PullRecord[]
}

export interface PullRecord {
  number: number
  title: string
  body: string
  head: string
  base: string
  draft: boolean
  state: 'open' | 'closed'
  author: string
  createdAt: string
  updatedAt: string
  /** Set when merged. */
  mergedAt?: string
  mergeCommit?: string
}

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'removed'
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

export class MergeConflictError extends Error {
  constructor(paths: string[]) {
    super(`Merge conflict in ${paths.join(', ')}`)
    this.name = 'MergeConflictError'
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

  /**
   * Merge `head` (a branch or commit) into the branch `base`, like GitHub's `POST /merges`: a merge
   * commit with both as parents, or `null` when `base` already contains `head`. Files are merged
   * whole: a file both sides changed differently is a `MergeConflictError`, and nothing changes.
   */
  async merge(input: { base: string; head: string; message?: string }): Promise<{ oid: string; date: string } | null> {
    const plan = this.planMerge(input.base, input.head)
    if (!plan) return null
    if (plan.conflicts.length > 0) throw new MergeConflictError(plan.conflicts)

    const date = new Date().toISOString()
    const oid = await this.storeCommit({
      tree: await this.storeTree(plan.tree),
      parent: plan.ours,
      mergeParent: plan.theirs,
      message: input.message ?? `Merge ${input.head} into ${input.base}`,
      date,
    })
    this.state.branches[input.base] = oid
    return { oid, date }
  }

  /** Whether `head` merges into `base` without conflicts (true when there is nothing to merge). */
  canMerge(base: string, head: string): boolean {
    return (this.planMerge(base, head)?.conflicts.length ?? 0) === 0
  }

  /**
   * How `head` compares to `base`, like GitHub's three-dot compare: commits on either side since
   * they split, and the files `head` changed since then.
   */
  compare(base: string, head: string): { ahead: number; behind: number; files: FileChange[] } | undefined {
    const baseSha = this.resolve(base)
    const headSha = this.resolve(head)
    if (!baseSha || !headSha) return undefined
    const baseAncestors = this.ancestors(baseSha)
    const headAncestors = this.ancestors(headSha)
    const mergeBase = this.mergeBase(baseSha, headSha)
    const before = mergeBase ? this.files(mergeBase)! : {}
    const after = this.files(headSha)!
    const files: FileChange[] = []
    for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (before[path] === after[path]) continue
      files.push({ path, status: !before[path] ? 'added' : !after[path] ? 'removed' : 'modified' })
    }
    return {
      ahead: [...headAncestors].filter((sha) => !baseAncestors.has(sha)).length,
      behind: [...baseAncestors].filter((sha) => !headAncestors.has(sha)).length,
      files,
    }
  }

  private mergeBase(a: string, b: string): string | undefined {
    const ofA = this.ancestors(a)
    return [...this.ancestors(b)].find((sha) => ofA.has(sha))
  }

  /** The merged tree and conflicting paths, or `null` when `base` already contains `head`. */
  private planMerge(base: string, head: string) {
    const ours = this.state.branches[base]
    const theirs = this.resolve(head)
    if (!ours) throw new Error(`Branch not found: ${base}`)
    if (!theirs) throw new Error(`Ref not found: ${head}`)
    if (this.ancestors(ours).has(theirs)) return null

    const mergeBase = this.mergeBase(ours, theirs)
    const ancestorFiles = mergeBase ? this.files(mergeBase)! : {}
    const ourFiles = this.files(ours)!
    const theirFiles = this.files(theirs)!
    const tree: Record<string, string> = {}
    const conflicts: string[] = []
    for (const path of new Set([...Object.keys(ourFiles), ...Object.keys(theirFiles)])) {
      const [original, mine, other] = [ancestorFiles[path], ourFiles[path], theirFiles[path]]
      let merged: string | undefined
      if (mine === other || other === original) merged = mine
      else if (mine === original) merged = other
      else {
        conflicts.push(path)
        continue
      }
      if (merged) tree[path] = merged
    }
    return { ours, theirs, tree, conflicts: conflicts.sort() }
  }

  /** Pull requests, oldest first. */
  pulls(): PullRecord[] {
    return structuredClone(this.state.pulls ?? [])
  }

  getPull(number: number): PullRecord | undefined {
    const pull = this.state.pulls?.find((entry) => entry.number === number)
    return pull && structuredClone(pull)
  }

  /** Open a pull request from `head` into `base`, like GitHub: both must exist and differ, once per pair. */
  createPull(input: { head: string; base: string; title: string; body?: string; draft?: boolean; author?: string }): PullRecord {
    if (!this.state.branches[input.head]) throw new Error(`Branch not found: ${input.head}`)
    if (!this.state.branches[input.base]) throw new Error(`Branch not found: ${input.base}`)
    if (!input.title.trim()) throw new Error('A title is required')
    if (this.ancestors(this.state.branches[input.base]).has(this.state.branches[input.head])) {
      throw new Error(`No commits between ${input.base} and ${input.head}`)
    }
    const pulls = (this.state.pulls ??= [])
    if (pulls.some((pull) => pull.state === 'open' && pull.head === input.head && pull.base === input.base)) {
      throw new Error(`A pull request already exists for ${input.head}`)
    }
    const now = new Date().toISOString()
    const pull: PullRecord = {
      number: pulls.reduce((max, entry) => Math.max(max, entry.number), 0) + 1,
      title: input.title,
      body: input.body ?? '',
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
      state: 'open',
      author: input.author ?? 'demo',
      createdAt: now,
      updatedAt: now,
    }
    pulls.push(pull)
    return structuredClone(pull)
  }

  updatePull(number: number, changes: Partial<Pick<PullRecord, 'title' | 'body' | 'state'>>): PullRecord {
    const pull = this.state.pulls?.find((entry) => entry.number === number)
    if (!pull) throw new Error(`Pull request not found: ${number}`)
    if (pull.mergedAt && changes.state === 'open') throw new Error('A merged pull request cannot be reopened')
    Object.assign(pull, changes, { updatedAt: new Date().toISOString() })
    return structuredClone(pull)
  }

  /** Merge an open pull request's head into its base; conflicts throw a `MergeConflictError`. */
  async mergePull(number: number, message?: string): Promise<PullRecord> {
    const pull = this.state.pulls?.find((entry) => entry.number === number)
    if (!pull) throw new Error(`Pull request not found: ${number}`)
    if (pull.state !== 'open') throw new Error('Pull request is not open')
    const merged = await this.merge({ base: pull.base, head: pull.head, message: message ?? `Merge pull request #${number} from ${pull.head}` })
    const now = new Date().toISOString()
    Object.assign(pull, { state: 'closed', mergedAt: now, updatedAt: now, mergeCommit: merged?.oid ?? this.state.branches[pull.base] })
    return structuredClone(pull)
  }

  /** A commit and everything it descends from, nearest first. */
  private ancestors(sha: string): Set<string> {
    const seen = new Set<string>()
    const queue = [sha]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (seen.has(current)) continue
      seen.add(current)
      const commit = this.state.commits[current]
      if (commit?.parent) queue.push(commit.parent)
      if (commit?.mergeParent) queue.push(commit.mergeParent)
    }
    return seen
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

  /** Newest first, following first parents. */
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
