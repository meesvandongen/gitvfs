import type {
  GitProvider,
  GitRepository,
  ListRepositoriesOptions,
  RepositoryInfo,
  TreeEntry,
  FileContent,
  BranchInfo,
  CommitOptions,
  CommitResult,
  ReadDirOptions,
  BranchComparison,
  ChangedFile,
  CreatePullRequestOptions,
  ListPullRequestsOptions,
  MergePullRequestOptions,
  MergeResult,
  PullRequestInfo,
} from '../types/provider.js'
import { ConflictError, GitVFSError } from '../types/errors.js'
import { createFetchREST, createPaginate, type TokenProvider } from './shared/http.js'
import { matchesSearch, splitFullName } from './shared/repositories.js'
import { createFetchGraphQL } from './shared/graphql.js'
import { encodeText, toBase64, fromBase64 } from '../utils/encoding.js'
import { normalize } from '../utils/path.js'
import { getGitHash } from '../utils/hash.js'

export interface GitLabProviderOptions {
  /** A token, or a function returning one; called before every request. */
  token: TokenProvider
  /** Self-managed GitLab: the instance URL. Default: `https://gitlab.com` */
  apiUrl?: string
}

interface GitLabRepositoryOptions extends GitLabProviderOptions {
  /** The full path, `group/subgroup/project`. */
  fullPath: string
}

function instanceUrl(options: GitLabProviderOptions): string {
  return (options.apiUrl ?? 'https://gitlab.com').replace(/\/$/, '')
}

interface GitLabProjectResponse {
  path_with_namespace: string
  path: string
  namespace: { full_path: string }
  default_branch: string | null
  visibility: 'private' | 'internal' | 'public'
  description: string | null
  web_url: string
  last_activity_at: string | null
}

interface GitLabMergeRequestResponse {
  iid: number
  title: string
  description: string | null
  state: 'opened' | 'closed' | 'merged' | 'locked'
  draft?: boolean
  source_branch: string
  target_branch: string
  web_url: string
  author: { username: string } | null
  created_at: string
  updated_at: string
  merge_commit_sha?: string | null
  squash_commit_sha?: string | null
  merged_at?: string | null
  detailed_merge_status?: string
  has_conflicts?: boolean
}

function toPullRequest(raw: GitLabMergeRequestResponse): PullRequestInfo {
  const pending = raw.detailed_merge_status === undefined
    || ['unchecked', 'checking', 'preparing', 'approvals_syncing'].includes(raw.detailed_merge_status)
  return {
    number: raw.iid,
    title: raw.title,
    body: raw.description ?? '',
    state: raw.state === 'opened' || raw.state === 'locked' ? 'open' : raw.state,
    draft: raw.draft ?? false,
    head: raw.source_branch,
    base: raw.target_branch,
    url: raw.web_url,
    author: raw.author?.username ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    mergeable: raw.has_conflicts ? false : pending ? null : raw.detailed_merge_status === 'mergeable',
  }
}

const MERGE_REQUEST_STATE = { open: 'opened', closed: 'closed', all: 'all' } as const

class GitLabProvider implements GitProvider {
  readonly name = 'gitlab'
  private paginate: ReturnType<typeof createPaginate>

  constructor(private options: GitLabProviderOptions) {
    this.paginate = createPaginate({ token: options.token, baseUrl: `${instanceUrl(options)}/api/v4` })
  }

  async *listRepositories(options: ListRepositoriesOptions = {}): AsyncGenerator<RepositoryInfo> {
    const path = '/projects?membership=true&per_page=100&order_by=last_activity_at&sort=desc'
    for await (const page of this.paginate<GitLabProjectResponse>(path, { signal: options.signal })) {
      for (const raw of page) {
        const repo: RepositoryInfo = {
          fullName: raw.path_with_namespace,
          name: raw.path,
          owner: raw.namespace?.full_path ?? splitFullName(raw.path_with_namespace).owner,
          defaultBranch: raw.default_branch,
          private: raw.visibility !== 'public',
          description: raw.description,
          webUrl: raw.web_url,
          updatedAt: raw.last_activity_at,
        }
        if (matchesSearch(repo, options.search)) yield repo
      }
    }
  }

  repository(fullName: string): GitRepository {
    if (!fullName.includes('/') || fullName.startsWith('/') || fullName.endsWith('/')) {
      throw new TypeError(`Expected a GitLab project as "group/project", got "${fullName}"`)
    }
    return new GitLabRepository({ ...this.options, fullPath: fullName })
  }
}

class GitLabRepository implements GitRepository {
  /** GitLab's REST API takes the URL-encoded full path wherever it takes a project id. */
  private projectId: string
  private fetchREST: ReturnType<typeof createFetchREST>
  private fetchGraphQL: ReturnType<typeof createFetchGraphQL>

  private paginate: ReturnType<typeof createPaginate>

  constructor(options: GitLabRepositoryOptions) {
    this.projectId = options.fullPath
    const baseUrl = instanceUrl(options)
    this.fetchREST = createFetchREST({
      token: options.token,
      baseUrl: `${baseUrl}/api/v4`,
    })
    this.paginate = createPaginate({ token: options.token, baseUrl: `${baseUrl}/api/v4` })
    this.fetchGraphQL = createFetchGraphQL({
      token: options.token,
      url: `${baseUrl}/api/graphql`,
    })
  }

  async readdir(ref: string, path: string, options?: ReadDirOptions): Promise<TreeEntry[]> {
    const normalized = normalize(path)
    const entries: TreeEntry[] = []
    let page = 1
    let hasNextPage = true

    while (hasNextPage) {
      const params = new URLSearchParams({
        ref,
        recursive: options?.recursive ? 'true' : 'false',
        per_page: '100',
        page: String(page),
      })

      if (normalized) {
        params.set('path', normalized)
      }

      const batch = (await this.fetchREST(
        `/projects/${encodeURIComponent(this.projectId)}/repository/tree?${params.toString()}`,
      )) as Array<{ path: string; type: 'blob' | 'tree'; id: string; name: string; mode: string }>

      for (const entry of batch) {
        entries.push({ path: entry.path, type: entry.type, sha: entry.id })
      }

      hasNextPage = batch.length === 100
      page += 1
    }

    return entries
  }

  async getFiles(ref: string, paths: string[]): Promise<Map<string, FileContent>> {
    const fullPath = this.projectId
    const result = new Map<string, FileContent>()
    const chunkSize = 100

    for (let i = 0; i < paths.length; i += chunkSize) {
      const chunk = paths.slice(i, i + chunkSize)
      const pathsArg = chunk.map((p) => `"${p}"`).join(', ')

      const query = `
        query {
          project(fullPath: "${fullPath}") {
            repository {
              blobs(ref: "${ref}", paths: [${pathsArg}]) {
                nodes {
                  path
                  rawBlob
                  oid
                  size
                }
              }
            }
          }
        }
      `

      const data = (await this.fetchGraphQL(query)) as {
        project: {
          repository: {
            blobs: {
              nodes: Array<{ path: string; rawBlob: string; oid: string; size: number }>
            }
          }
        }
      }

      for (const blob of data.project.repository.blobs.nodes) {
        if (blob.rawBlob !== null) {
          const content = encodeText(blob.rawBlob)
          result.set(blob.path, {
            path: blob.path,
            sha: blob.oid,
            content,
            size: blob.size,
          })
        }
      }
    }

    return result
  }

  async getFile(ref: string, path: string): Promise<FileContent> {
    const encoded = encodeURIComponent(path)
    const result = (await this.fetchREST(
      `/projects/${encodeURIComponent(this.projectId)}/repository/files/${encoded}?ref=${ref}`,
    )) as { content: string; blob_id: string; size: number; encoding: string }

    const content =
      result.encoding === 'base64' ? fromBase64(result.content) : encodeText(result.content)

    return {
      path,
      sha: result.blob_id,
      content,
      size: result.size,
    }
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const result = (await this.fetchREST(
      `/projects/${encodeURIComponent(this.projectId)}/repository/blobs/${sha}`,
    )) as { content: string; encoding: string }

    if (result.encoding === 'base64') {
      return fromBase64(result.content)
    }
    return encodeText(result.content)
  }

  async getBranch(name: string): Promise<BranchInfo> {
    const result = (await this.fetchREST(
      `/projects/${encodeURIComponent(this.projectId)}/repository/branches/${encodeURIComponent(name)}`,
    )) as { name: string; commit: { id: string } }
    return { name: result.name, sha: result.commit.id }
  }

  async getLastCommitSha(branch: string): Promise<string> {
    const info = await this.getBranch(branch)
    return info.sha
  }

  async createBranch(name: string, fromSha: string): Promise<BranchInfo> {
    const result = (await this.fetchREST(
      `/projects/${encodeURIComponent(this.projectId)}/repository/branches`,
      {
        method: 'POST',
        body: JSON.stringify({ branch: name, ref: fromSha }),
      },
    )) as { name: string; commit: { id: string } }
    return { name: result.name, sha: result.commit.id }
  }

  async deleteBranch(name: string): Promise<void> {
    await this.fetchREST(
      `/projects/${encodeURIComponent(this.projectId)}/repository/branches/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    )
  }

  private get projectPath(): string {
    return `/projects/${encodeURIComponent(this.projectId)}`
  }

  async listBranches(): Promise<BranchInfo[]> {
    const branches: BranchInfo[] = []
    const path = `${this.projectPath}/repository/branches?per_page=100`
    for await (const page of this.paginate<{ name: string; commit: { id: string } }>(path)) {
      for (const raw of page) branches.push({ name: raw.name, sha: raw.commit.id })
    }
    return branches
  }

  async compareBranches(base: string, head: string): Promise<BranchComparison> {
    type Comparison = {
      commits: unknown[]
      diffs: Array<{ old_path: string; new_path: string; new_file: boolean; renamed_file: boolean; deleted_file: boolean }>
    }
    // `straight=false` compares from the merge base, like GitHub's three-dot compare.
    const compare = (from: string, to: string) =>
      this.fetchREST(
        `${this.projectPath}/repository/compare?${new URLSearchParams({ from, to, straight: 'false' }).toString()}`,
      ) as Promise<Comparison>
    const [ahead, behind] = await Promise.all([compare(base, head), compare(head, base)])
    return {
      ahead: ahead.commits.length,
      behind: behind.commits.length,
      files: ahead.diffs.map((diff): ChangedFile => {
        if (diff.new_file) return { path: diff.new_path, status: 'added' }
        if (diff.deleted_file) return { path: diff.old_path, status: 'removed' }
        if (diff.renamed_file) return { path: diff.new_path, status: 'renamed', previousPath: diff.old_path }
        return { path: diff.new_path, status: 'modified' }
      }),
    }
  }

  async listPullRequests(options: ListPullRequestsOptions = {}): Promise<PullRequestInfo[]> {
    const params = new URLSearchParams({ per_page: '100' })
    if (options.head) params.set('source_branch', options.head)
    if (options.base) params.set('target_branch', options.base)
    // GitLab's `closed` leaves out merged ones; GitHub's (and ours) includes them.
    const states = options.state === 'closed' ? ['closed', 'merged'] : [MERGE_REQUEST_STATE[options.state ?? 'open']]
    const requests: PullRequestInfo[] = []
    for (const state of states) {
      params.set('state', state)
      for await (const page of this.paginate<GitLabMergeRequestResponse>(`${this.projectPath}/merge_requests?${params.toString()}`)) {
        requests.push(...page.map(toPullRequest))
      }
    }
    return requests
  }

  async getPullRequest(number: number): Promise<PullRequestInfo> {
    return toPullRequest((await this.fetchREST(`${this.projectPath}/merge_requests/${number}`)) as GitLabMergeRequestResponse)
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequestInfo> {
    const raw = (await this.fetchREST(`${this.projectPath}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify({
        source_branch: options.head,
        target_branch: options.base,
        title: options.draft ? `Draft: ${options.title}` : options.title,
        description: options.body,
      }),
    })) as GitLabMergeRequestResponse
    return toPullRequest(raw)
  }

  async mergePullRequest(number: number, options: MergePullRequestOptions = {}): Promise<MergeResult> {
    const body: Record<string, unknown> = { squash: options.method === 'squash' }
    if (options.message) body[options.method === 'squash' ? 'squash_commit_message' : 'merge_commit_message'] = options.message
    let raw: GitLabMergeRequestResponse
    try {
      raw = (await this.fetchREST(`${this.projectPath}/merge_requests/${number}/merge`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })) as GitLabMergeRequestResponse
    } catch (error) {
      // 405/406/422: not mergeable (conflicts, pipeline, draft); 409: the source branch moved.
      const status = error instanceof ConflictError ? 409 : error instanceof GitVFSError ? error.status : undefined
      if (status !== undefined && [405, 406, 409, 422].includes(status)) {
        throw new ConflictError(`Merge request !${number} cannot be merged: ${(error as Error).message}`)
      }
      throw error
    }
    return {
      sha: raw.merge_commit_sha ?? raw.squash_commit_sha ?? '',
      date: raw.merged_at ?? new Date().toISOString(),
    }
  }

  async closePullRequest(number: number): Promise<PullRequestInfo> {
    const raw = (await this.fetchREST(`${this.projectPath}/merge_requests/${number}`, {
      method: 'PUT',
      body: JSON.stringify({ state_event: 'close' }),
    })) as GitLabMergeRequestResponse
    return toPullRequest(raw)
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    const actions = options.changes.map((change) => {
      const base: Record<string, string> = { file_path: change.path }

      if (change.action === 'delete') {
        return { action: 'delete', ...base }
      }

      if (change.action === 'move') {
        base.previous_path = change.previousPath ?? ''
        const content =
          change.content instanceof Uint8Array
            ? toBase64(change.content)
            : toBase64(encodeText(change.content ?? ''))
        return { action: 'move', ...base, content, encoding: 'base64' }
      }

      const content =
        change.content instanceof Uint8Array
          ? toBase64(change.content)
          : toBase64(encodeText(change.content ?? ''))
      return { action: change.action, ...base, content, encoding: 'base64' }
    })

    const result = (await this.fetchREST(
      `/projects/${encodeURIComponent(this.projectId)}/repository/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          branch: options.branch,
          commit_message: options.message,
          actions,
        }),
      },
    )) as { id: string; created_at: string }

    // GitLab doesn't return file SHAs — calculate locally
    const files: Record<string, { sha: string }> = {}
    for (const change of options.changes) {
      if (change.action !== 'delete' && change.content !== undefined) {
        const bytes =
          change.content instanceof Uint8Array ? change.content : encodeText(change.content)
        files[change.path] = { sha: await getGitHash(bytes) }
      }
    }

    return {
      sha: result.id,
      date: result.created_at,
      files,
    }
  }
}

/**
 * GitLab as seen by one account. List projects with `listRepositories()`, and get one with
 * `repository('group/project')` to pass to `GitVFS`.
 */
export function gitlab(options: GitLabProviderOptions): GitProvider {
  return new GitLabProvider(options)
}
