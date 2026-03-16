import type {
  GitProvider,
  TreeEntry,
  FileContent,
  BranchInfo,
  CommitOptions,
  CommitResult,
  ReadDirOptions,
} from '../../src/types/provider'
import { NotFoundError } from '../../src/types/errors'
import { encodeText } from '../../src/utils/encoding'
import { getGitHash } from '../../src/utils/hash'
import { normalize } from '../../src/utils/path'

interface MockFile {
  path: string
  content: Uint8Array
  sha: string
}

interface MockBranch {
  name: string
  sha: string
  files: MockFile[]
}

export class MockProvider implements GitProvider {
  branches: Map<string, MockBranch> = new Map()
  commitCount = 0
  lastCommitShaCallCount = 0

  constructor() {
    this.branches.set('main', {
      name: 'main',
      sha: 'commit-sha-001',
      files: [],
    })
  }

  /** Helper to add a file to a branch for testing. */
  async addFile(branch: string, path: string, content: string): Promise<void> {
    const b = this.branches.get(branch)
    if (!b) throw new NotFoundError(`Branch not found: ${branch}`)
    const bytes = encodeText(content)
    const sha = await getGitHash(bytes)
    b.files.push({ path, content: bytes, sha })
  }

  async readdir(ref: string, path: string, options?: ReadDirOptions): Promise<TreeEntry[]> {
    const branch = this.branches.get(ref)
    if (!branch) throw new NotFoundError(`Branch not found: ${ref}`)

    const allEntries: TreeEntry[] = []
    const dirs = new Set<string>()
    const normalized = normalize(path)
    const prefix = normalized ? `${normalized}/` : ''

    for (const file of branch.files) {
      allEntries.push({
        path: file.path,
        type: 'blob',
        sha: file.sha,
        size: file.content.length,
      })

      // Add directory entries
      const parts = file.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (!dirs.has(dir)) {
          dirs.add(dir)
          allEntries.push({ path: dir, type: 'tree', sha: `tree-${dir}` })
        }
      }
    }

    if (options?.recursive) {
      return allEntries.filter((entry) => {
        if (normalized && entry.path === normalized) return false
        return entry.path.startsWith(prefix)
      })
    }

    return allEntries.filter((entry) => {
      if (normalized) {
        if (!entry.path.startsWith(prefix)) return false
        return !entry.path.slice(prefix.length).includes('/')
      }

      return !entry.path.includes('/')
    })
  }

  async getFiles(ref: string, paths: string[]): Promise<Map<string, FileContent>> {
    const branch = this.branches.get(ref)
    if (!branch) throw new NotFoundError(`Branch not found: ${ref}`)

    const result = new Map<string, FileContent>()
    for (const path of paths) {
      const file = branch.files.find((f) => f.path === path)
      if (file) {
        result.set(path, {
          path: file.path,
          sha: file.sha,
          content: file.content,
          size: file.content.length,
        })
      }
    }
    return result
  }

  async getFile(ref: string, path: string): Promise<FileContent> {
    const branch = this.branches.get(ref)
    if (!branch) throw new NotFoundError(`Branch not found: ${ref}`)

    const file = branch.files.find((f) => f.path === path)
    if (!file) throw new NotFoundError(`File not found: ${path}`)

    return {
      path: file.path,
      sha: file.sha,
      content: file.content,
      size: file.content.length,
    }
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    for (const branch of this.branches.values()) {
      const file = branch.files.find((f) => f.sha === sha)
      if (file) return file.content
    }
    throw new NotFoundError(`Blob not found: ${sha}`)
  }

  async getBranch(name: string): Promise<BranchInfo> {
    const branch = this.branches.get(name)
    if (!branch) throw new NotFoundError(`Branch not found: ${name}`)
    return { name: branch.name, sha: branch.sha }
  }

  async getLastCommitSha(branchName: string): Promise<string> {
    this.lastCommitShaCallCount += 1
    const branch = this.branches.get(branchName)
    if (!branch) throw new NotFoundError(`Branch not found: ${branchName}`)
    return branch.sha
  }

  async createBranch(name: string, fromSha: string): Promise<BranchInfo> {
    // Find the source branch by SHA
    let sourceFiles: MockFile[] = []
    for (const branch of this.branches.values()) {
      if (branch.sha === fromSha) {
        sourceFiles = [...branch.files]
        break
      }
    }

    const newBranch: MockBranch = {
      name,
      sha: fromSha,
      files: sourceFiles,
    }
    this.branches.set(name, newBranch)
    return { name, sha: fromSha }
  }

  async deleteBranch(name: string): Promise<void> {
    if (!this.branches.has(name)) {
      throw new NotFoundError(`Branch not found: ${name}`)
    }
    this.branches.delete(name)
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    const branch = this.branches.get(options.branch)
    if (!branch) throw new NotFoundError(`Branch not found: ${options.branch}`)

    this.commitCount++
    const newSha = `commit-sha-${String(this.commitCount + 1).padStart(3, '0')}`
    const files: Record<string, { sha: string }> = {}

    for (const change of options.changes) {
      if (change.action === 'delete') {
        branch.files = branch.files.filter((f) => f.path !== change.path)
      } else if (change.action === 'move') {
        branch.files = branch.files.filter((f) => f.path !== change.previousPath)
        const bytes =
          change.content instanceof Uint8Array ? change.content : encodeText(change.content ?? '')
        const sha = await getGitHash(bytes)
        branch.files.push({ path: change.path, content: bytes, sha })
        files[change.path] = { sha }
      } else {
        // create or update
        branch.files = branch.files.filter((f) => f.path !== change.path)
        const bytes =
          change.content instanceof Uint8Array ? change.content : encodeText(change.content ?? '')
        const sha = await getGitHash(bytes)
        branch.files.push({ path: change.path, content: bytes, sha })
        files[change.path] = { sha }
      }
    }

    branch.sha = newSha

    return {
      sha: newSha,
      date: new Date().toISOString(),
      files,
    }
  }
}
