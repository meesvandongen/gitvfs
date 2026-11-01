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
} from '../types/provider.js'
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

/** @deprecated Use `gitlab({ token }).repository('group/project')`. */
export interface GitLabOptions extends GitLabProviderOptions {
  /** A numeric id or the full path (`group/subgroup/project`). */
  projectId: string | number
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
    return new GitLabRepository({ ...this.options, projectId: fullName })
  }
}

class GitLabRepository implements GitRepository {
  private projectId: string
  private fetchREST: ReturnType<typeof createFetchREST>
  private fetchGraphQL: ReturnType<typeof createFetchGraphQL>
  private fullPath: string | undefined

  constructor(options: GitLabOptions) {
    this.projectId = String(options.projectId)
    // A full path is already what GraphQL needs; a numeric id is looked up once.
    if (this.projectId.includes('/')) this.fullPath = this.projectId
    const baseUrl = instanceUrl(options)
    this.fetchREST = createFetchREST({
      token: options.token,
      baseUrl: `${baseUrl}/api/v4`,
    })
    this.fetchGraphQL = createFetchGraphQL({
      token: options.token,
      url: `${baseUrl}/api/graphql`,
    })
  }

  private async getFullPath(): Promise<string> {
    if (this.fullPath) return this.fullPath
    const project = (await this.fetchREST(`/projects/${encodeURIComponent(this.projectId)}`)) as {
      path_with_namespace: string
    }
    this.fullPath = project.path_with_namespace
    return this.fullPath
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
    const fullPath = await this.getFullPath()
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

/** @deprecated Use `gitlab({ token }).repository('group/project')`. */
export function gitlab(options: GitLabOptions): GitRepository
/**
 * GitLab as seen by one account. List projects with `listRepositories()`, and get one with
 * `repository('group/project')` to pass to `GitFS`.
 */
export function gitlab(options: GitLabProviderOptions): GitProvider
export function gitlab(options: GitLabProviderOptions | GitLabOptions): GitProvider | GitRepository {
  if ('projectId' in options) return new GitLabRepository(options as GitLabOptions)
  return new GitLabProvider(options)
}
