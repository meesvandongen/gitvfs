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

export interface MergeOptions {
  /** The branch that receives the merge commit. */
  into: string
  /** The branch merged into it. */
  from: string
  message?: string
}

export interface MergeResult {
  /** The merge commit. */
  sha: string
  date: string
}

/** How a file differs on one branch from where it split off another. */
export type ChangedFileStatus = 'added' | 'modified' | 'removed' | 'renamed'

export interface ChangedFile {
  path: string
  status: ChangedFileStatus
  /** The old path of a renamed file. */
  previousPath?: string
}

export interface BranchComparison {
  /** Commits on the head branch that the base branch does not have. */
  ahead: number
  /** Commits on the base branch that the head branch does not have. */
  behind: number
  /** What the head branch changed since it split off the base branch. */
  files: ChangedFile[]
}

/** A pull request on GitHub, a merge request on GitLab. */
export interface PullRequestInfo {
  /** GitHub's number, GitLab's `iid`: the `#12` / `!12` people refer to. */
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  /** The branch with the changes. */
  head: string
  /** The branch it merges into. */
  base: string
  /** The pull request's page on the host. */
  url: string
  author: string | null
  /** ISO 8601. */
  createdAt: string
  updatedAt: string
  /** Whether it merges without conflicts; `null` when the host has not worked it out (yet). */
  mergeable: boolean | null
}

export interface CreatePullRequestOptions {
  head: string
  base: string
  title: string
  body?: string
  draft?: boolean
}

export interface ListPullRequestsOptions {
  head?: string
  base?: string
  /** Default: `'open'`. Merged pull requests count as closed. */
  state?: 'open' | 'closed' | 'all'
}

export interface MergePullRequestOptions {
  /** Default: `'merge'`. */
  method?: 'merge' | 'squash' | 'rebase'
  /** The merge (or squash) commit's message. */
  message?: string
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
  /**
   * Merge one branch into another on the host. Resolves to `null` when `into` already contains
   * `from`; rejects with a `ConflictError` when the branches changed the same file. Optional:
   * `GitVFS.updateFromBase()` needs it.
   */
  mergeBranch?(options: MergeOptions): Promise<MergeResult | null>

  // Optional: branch and review workflows, e.g. the CMS's changes and pull requests.

  /** Every branch of the repository. */
  listBranches?(): Promise<BranchInfo[]>
  /** What `head` changed since it split off `base`, and how far the two have moved apart. */
  compareBranches?(base: string, head: string): Promise<BranchComparison>
  listPullRequests?(options?: ListPullRequestsOptions): Promise<PullRequestInfo[]>
  getPullRequest?(number: number): Promise<PullRequestInfo>
  createPullRequest?(options: CreatePullRequestOptions): Promise<PullRequestInfo>
  /** Rejects with a `ConflictError` when it cannot be merged, e.g. because of conflicts. */
  mergePullRequest?(number: number, options?: MergePullRequestOptions): Promise<MergeResult>
  closePullRequest?(number: number): Promise<PullRequestInfo>
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
