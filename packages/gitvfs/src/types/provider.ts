export interface TreeEntry {
  path: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
}

export interface FileContent {
  path: string
  sha: string
  content: Uint8Array
  size: number
}

export interface BranchInfo {
  name: string
  sha: string
}

export interface CommitFileChange {
  action: 'create' | 'update' | 'delete' | 'move'
  path: string
  content?: Uint8Array | string
  previousPath?: string
}

export interface CommitOptions {
  branch: string
  message: string
  changes: CommitFileChange[]
  expectedHeadOid?: string
}

export interface CommitResult {
  sha: string
  date: string
  files: Record<string, { sha: string }>
}

export interface ReadDirOptions {
  recursive?: boolean
}

/**
 * One repository on a Git host: reads files and branches, and commits. `GitVFS` works on top of it.
 * Get one from a provider with `provider.repository('owner/name')`, or implement it for another
 * host.
 */
export interface GitRepository {
  readdir(ref: string, path: string, options?: ReadDirOptions): Promise<TreeEntry[]>
  getFiles(ref: string, paths: string[]): Promise<Map<string, FileContent>>
  getFile(ref: string, path: string): Promise<FileContent>
  getBlob(sha: string): Promise<Uint8Array>
  getBranch(name: string): Promise<BranchInfo>
  getLastCommitSha(branch: string): Promise<string>
  createBranch(name: string, fromSha: string): Promise<BranchInfo>
  deleteBranch(name: string): Promise<void>
  commit(options: CommitOptions): Promise<CommitResult>
}

/** A repository the signed-in account can reach, as listed by `GitProvider.listRepositories()`. */
export interface RepositoryInfo {
  /** `owner/name` on GitHub, the full path (`group/subgroup/project`) on GitLab. Pass it to `provider.repository()`. */
  fullName: string
  /** The last segment of `fullName`. */
  name: string
  /** Everything before the last segment: the user, organization or (sub)group. */
  owner: string
  /** Null for an empty repository. */
  defaultBranch: string | null
  private: boolean
  description: string | null
  /** The repository's page on the host. */
  webUrl: string
  /** ISO 8601. When the repository last changed, as far as the host reports it. */
  updatedAt: string | null
}

export interface ListRepositoriesOptions {
  /** Keep repositories whose full name or description contains this text (case-insensitive). */
  search?: string
  signal?: AbortSignal
}

/**
 * A Git host (GitHub, GitLab, ...) as seen by one account: the level above a single repository.
 *
 * ```ts
 * const gh = github({ token })
 * for await (const repo of gh.listRepositories()) console.log(repo.fullName)
 * const fs = new GitVFS({ repository: gh.repository('acme/site'), branch: 'main' })
 * ```
 */
export interface GitProvider {
  /** Which host this is, e.g. `'github'` or `'gitlab'`. */
  readonly name: string
  /** Repositories the account can reach, most recently updated first, fetched page by page as you iterate. */
  listRepositories(options?: ListRepositoriesOptions): AsyncIterable<RepositoryInfo>
  /** One repository by its full name (see `RepositoryInfo.fullName`). Makes no request. */
  repository(fullName: string): GitRepository
}
