import { ConflictError, NotFoundError } from 'gitvfs'
import type {
  BranchComparison,
  BranchInfo,
  ChangedFile,
  CommitOptions,
  CommitResult,
  CreatePullRequestOptions,
  FileContent,
  GitRepository,
  ListPullRequestsOptions,
  MergeOptions,
  MergeResult,
  PullRequestInfo,
  ReadDirOptions,
  TreeEntry,
} from 'gitvfs'

const encoder = new TextEncoder()

function toBytes(content: Uint8Array | string): Uint8Array {
  return typeof content === 'string' ? encoder.encode(content) : content
}

function fakeSha(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

type Files = Map<string, { sha: string; content: Uint8Array }>

interface Branch {
  sha: string
  files: Files
  /** Every commit the branch contains, oldest first. */
  history: string[]
}

/**
 * A GitRepository backed by memory, for tests and the playground. Merges and compares work on
 * whole files, from the last commit two branches share.
 */
export class MemoryRepository implements GitRepository {
  readonly branches = new Map<string, Branch>()
  readonly commits: CommitOptions[] = []
  readonly pulls: PullRequestInfo[] = []
  /** The files of every commit. */
  private snapshots = new Map<string, Files>()

  constructor(files: Record<string, string> = {}, branch = 'main') {
    const sha = fakeSha()
    const snapshot: Files = new Map(
      Object.entries(files).map(([path, content]) => [path, { sha: fakeSha(), content: toBytes(content) }]),
    )
    this.snapshots.set(sha, snapshot)
    this.branches.set(branch, { sha, files: snapshot, history: [sha] })
  }

  private branch(name: string): Branch {
    const branch = this.branches.get(name)
    if (!branch) throw new NotFoundError(`Branch not found: ${name}`)
    return branch
  }

  /** Current text content of a file, for assertions. */
  text(path: string, branch = 'main'): string | undefined {
    const file = this.branch(branch).files.get(path)
    return file ? new TextDecoder().decode(file.content) : undefined
  }

  async readdir(ref: string, path: string, options?: ReadDirOptions): Promise<TreeEntry[]> {
    const prefix = path ? `${path}/` : ''
    const entries = new Map<string, TreeEntry>()
    for (const [filePath, file] of this.branch(ref).files) {
      if (!filePath.startsWith(prefix)) continue
      const rest = filePath.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (options?.recursive || slash === -1) {
        entries.set(filePath, { path: filePath, type: 'blob', sha: file.sha, size: file.content.length })
      }
      if (slash !== -1) {
        const parts = rest.split('/')
        const depth = options?.recursive ? parts.length - 1 : 1
        for (let i = 1; i <= depth; i++) {
          const dir = prefix + parts.slice(0, i).join('/')
          entries.set(dir, { path: dir, type: 'tree', sha: '' })
        }
      }
    }
    if (prefix && entries.size === 0) throw new NotFoundError(`Not found: ${path}`)
    return [...entries.values()]
  }

  async getFile(ref: string, path: string): Promise<FileContent> {
    const file = this.branch(ref).files.get(path)
    if (!file) throw new NotFoundError(`Not found: ${path}`)
    return { path, sha: file.sha, content: file.content, size: file.content.length }
  }

  async getFiles(ref: string, paths: string[]): Promise<Map<string, FileContent>> {
    const result = new Map<string, FileContent>()
    for (const path of paths) result.set(path, await this.getFile(ref, path))
    return result
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    for (const branch of this.branches.values()) {
      for (const file of branch.files.values()) {
        if (file.sha === sha) return file.content
      }
    }
    throw new NotFoundError(`Blob not found: ${sha}`)
  }

  async getBranch(name: string): Promise<BranchInfo> {
    return { name, sha: this.branch(name).sha }
  }

  async getLastCommitSha(branch: string): Promise<string> {
    return this.branch(branch).sha
  }

  async createBranch(name: string, fromSha: string): Promise<BranchInfo> {
    const source = [...this.branches.values()].find((branch) => branch.history.includes(fromSha))
    if (!source) throw new NotFoundError(`Commit not found: ${fromSha}`)
    const history = source.history.slice(0, source.history.indexOf(fromSha) + 1)
    this.branches.set(name, { sha: fromSha, files: new Map(this.snapshots.get(fromSha)), history })
    return { name, sha: fromSha }
  }

  async listBranches(): Promise<BranchInfo[]> {
    return [...this.branches].map(([name, branch]) => ({ name, sha: branch.sha })).sort((a, b) => a.name.localeCompare(b.name))
  }

  private mergeBase(a: Branch, b: Branch): Files {
    const shared = [...b.history].reverse().find((sha) => a.history.includes(sha))
    return shared ? this.snapshots.get(shared)! : new Map()
  }

  async compareBranches(base: string, head: string): Promise<BranchComparison> {
    const from = this.branch(base)
    const to = this.branch(head)
    const before = this.mergeBase(from, to)
    const files: ChangedFile[] = []
    for (const path of [...new Set([...before.keys(), ...to.files.keys()])].sort()) {
      const [a, b] = [before.get(path)?.sha, to.files.get(path)?.sha]
      if (a !== b) files.push({ path, status: !a ? 'added' : !b ? 'removed' : 'modified' })
    }
    return {
      ahead: to.history.filter((sha) => !from.history.includes(sha)).length,
      behind: from.history.filter((sha) => !to.history.includes(sha)).length,
      files,
    }
  }

  async mergeBranch(options: MergeOptions): Promise<MergeResult | null> {
    const into = this.branch(options.into)
    const from = this.branch(options.from)
    if (into.history.includes(from.sha)) return null
    const original = this.mergeBase(into, from)
    const files: Files = new Map()
    for (const path of new Set([...into.files.keys(), ...from.files.keys()])) {
      const [base, mine, theirs] = [original.get(path), into.files.get(path), from.files.get(path)]
      const pick = mine?.sha === theirs?.sha || theirs?.sha === base?.sha ? mine : mine?.sha === base?.sha ? theirs : null
      if (pick === null) throw new ConflictError(`Merge conflict in ${path}`)
      if (pick) files.set(path, pick)
    }
    const sha = fakeSha()
    this.snapshots.set(sha, files)
    into.history = [...into.history, ...from.history.filter((entry) => !into.history.includes(entry)), sha]
    into.sha = sha
    into.files = files
    return { sha, date: new Date().toISOString() }
  }

  async listPullRequests(options: ListPullRequestsOptions = {}): Promise<PullRequestInfo[]> {
    const state = options.state ?? 'open'
    return this.pulls.filter((pull) =>
      (state === 'all' || (state === 'open' ? pull.state === 'open' : pull.state !== 'open'))
      && (!options.head || pull.head === options.head)
      && (!options.base || pull.base === options.base))
  }

  async getPullRequest(number: number): Promise<PullRequestInfo> {
    const pull = this.pulls.find((entry) => entry.number === number)
    if (!pull) throw new NotFoundError(`Pull request not found: ${number}`)
    return { ...pull }
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequestInfo> {
    const now = new Date().toISOString()
    const pull: PullRequestInfo = {
      number: this.pulls.length + 1,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      draft: options.draft ?? false,
      head: options.head,
      base: options.base,
      url: `https://example.com/pulls/${this.pulls.length + 1}`,
      author: 'tester',
      createdAt: now,
      updatedAt: now,
      mergeable: true,
    }
    this.pulls.push(pull)
    return { ...pull }
  }

  async mergePullRequest(number: number): Promise<MergeResult> {
    const pull = this.pulls.find((entry) => entry.number === number && entry.state === 'open')
    if (!pull) throw new NotFoundError(`Open pull request not found: ${number}`)
    const result = await this.mergeBranch({ into: pull.base, from: pull.head })
    pull.state = 'merged'
    return result ?? { sha: this.branch(pull.base).sha, date: new Date().toISOString() }
  }

  async closePullRequest(number: number): Promise<PullRequestInfo> {
    const pull = this.pulls.find((entry) => entry.number === number)
    if (!pull) throw new NotFoundError(`Pull request not found: ${number}`)
    pull.state = 'closed'
    return { ...pull }
  }

  async deleteBranch(name: string): Promise<void> {
    this.branches.delete(name)
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    const branch = this.branch(options.branch)
    if (options.expectedHeadOid && options.expectedHeadOid !== branch.sha) {
      throw new ConflictError('Branch moved')
    }

    const files = new Map(branch.files)
    const changed: CommitResult['files'] = {}
    for (const change of options.changes) {
      if (change.action === 'delete') {
        files.delete(change.path)
        continue
      }
      const content = change.content !== undefined
        ? toBytes(change.content)
        : files.get(change.previousPath ?? '')?.content
      if (!content) throw new NotFoundError(`Nothing to write at ${change.path}`)
      if (change.previousPath) files.delete(change.previousPath)
      const sha = fakeSha()
      files.set(change.path, { sha, content })
      changed[change.path] = { sha }
    }

    branch.files = files
    branch.sha = fakeSha()
    branch.history = [...branch.history, branch.sha]
    this.snapshots.set(branch.sha, files)
    this.commits.push(options)
    return { sha: branch.sha, date: new Date().toISOString(), files: changed }
  }
}
