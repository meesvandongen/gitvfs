import { ConflictError, NotFoundError } from 'gitvfs'
import type {
  BranchInfo,
  CommitOptions,
  CommitResult,
  FileContent,
  GitProvider,
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

interface Branch {
  sha: string
  files: Map<string, { sha: string; content: Uint8Array }>
}

/** A GitProvider backed by memory, for tests and the playground. */
export class MemoryProvider implements GitProvider {
  readonly branches = new Map<string, Branch>()
  readonly commits: CommitOptions[] = []

  constructor(files: Record<string, string> = {}, branch = 'main') {
    this.branches.set(branch, {
      sha: fakeSha(),
      files: new Map(
        Object.entries(files).map(([path, content]) => [path, { sha: fakeSha(), content: toBytes(content) }]),
      ),
    })
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
    const source = [...this.branches.values()].find((branch) => branch.sha === fromSha)
    if (!source) throw new NotFoundError(`Commit not found: ${fromSha}`)
    this.branches.set(name, { sha: fromSha, files: new Map(source.files) })
    return { name, sha: fromSha }
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
    this.commits.push(options)
    return { sha: branch.sha, date: new Date().toISOString(), files: changed }
  }
}
