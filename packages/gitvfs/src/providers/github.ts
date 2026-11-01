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
  MergeOptions,
  MergeResult,
  ReadDirOptions,
} from '../types/provider.js'
import { ConflictError, NotFoundError } from '../types/errors.js'
import { createFetchREST, createPaginate, type TokenProvider } from './shared/http.js'
import { matchesSearch } from './shared/repositories.js'
import { createFetchGraphQL } from './shared/graphql.js'
import { fromBase64, toBase64, encodeText } from '../utils/encoding.js'
import { normalize } from '../utils/path.js'

export interface GitHubProviderOptions {
  /** A token, or a function returning one; called before every request. */
  token: TokenProvider
  /** GitHub Enterprise Server: `https://HOST/api/v3`. Default: `https://api.github.com` */
  apiUrl?: string
}

interface GitHubRepositoryOptions extends GitHubProviderOptions {
  owner: string
  repo: string
}

/** GraphQL lives at `/api/graphql` on GitHub Enterprise Server, next to the REST `/api/v3`. */
function graphqlUrl(apiUrl: string): string {
  return apiUrl.endsWith('/api/v3') ? `${apiUrl.slice(0, -'/v3'.length)}/graphql` : `${apiUrl}/graphql`
}

function apiUrlOf(options: GitHubProviderOptions): string {
  return (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
}

interface GitHubRepoResponse {
  full_name: string
  name: string
  owner: { login: string }
  default_branch: string | null
  private: boolean
  description: string | null
  html_url: string
  pushed_at: string | null
  updated_at: string | null
}

class GitHubProvider implements GitProvider {
  readonly name = 'github'
  private paginate: ReturnType<typeof createPaginate>

  constructor(private options: GitHubProviderOptions) {
    this.paginate = createPaginate({ token: options.token, baseUrl: apiUrlOf(options) })
  }

  async *listRepositories(options: ListRepositoriesOptions = {}): AsyncGenerator<RepositoryInfo> {
    // With a GitHub App user token this lists only repositories the app is installed on.
    const path = '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'
    for await (const page of this.paginate<GitHubRepoResponse>(path, { signal: options.signal })) {
      for (const raw of page) {
        const repo: RepositoryInfo = {
          fullName: raw.full_name,
          name: raw.name,
          owner: raw.owner.login,
          defaultBranch: raw.default_branch,
          private: raw.private,
          description: raw.description,
          webUrl: raw.html_url,
          updatedAt: raw.pushed_at ?? raw.updated_at,
        }
        if (matchesSearch(repo, options.search)) yield repo
      }
    }
  }

  repository(fullName: string): GitRepository {
    const parts = fullName.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new TypeError(`Expected a GitHub repository as "owner/name", got "${fullName}"`)
    }
    return new GitHubRepository({ ...this.options, owner: parts[0], repo: parts[1] })
  }
}

class GitHubRepository implements GitRepository {
  private owner: string
  private repo: string
  private fetchREST: ReturnType<typeof createFetchREST>
  private fetchGraphQL: ReturnType<typeof createFetchGraphQL>

  constructor(options: GitHubRepositoryOptions) {
    this.owner = options.owner
    this.repo = options.repo
    const baseUrl = apiUrlOf(options)
    this.fetchREST = createFetchREST({ token: options.token, baseUrl })
    this.fetchGraphQL = createFetchGraphQL({ token: options.token, url: graphqlUrl(baseUrl) })
  }

  private encodePath(path: string): string {
    return normalize(path).split('/').filter(Boolean).map(encodeURIComponent).join('/')
  }

  private async getRecursiveTree(ref: string): Promise<TreeEntry[]> {
    // First get the commit to find the tree SHA
    const commit = (await this.fetchREST(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${ref}`,
    )) as { object: { sha: string } }

    const treeSha = ((await this.fetchREST(
      `/repos/${this.owner}/${this.repo}/git/commits/${commit.object.sha}`,
    )) as { tree: { sha: string } }).tree.sha

    const result = (await this.fetchREST(
      `/repos/${this.owner}/${this.repo}/git/trees/${treeSha}?recursive=1`,
    )) as {
      tree: Array<{ path: string; type: string; sha: string; size?: number }>
    }

    return result.tree.map((entry) => ({
      path: entry.path,
      type: entry.type as 'blob' | 'tree',
      sha: entry.sha,
      size: entry.size,
    }))
  }

  async readdir(ref: string, path: string, options?: ReadDirOptions): Promise<TreeEntry[]> {
    const normalized = normalize(path)

    if (options?.recursive) {
      const prefix = normalized ? `${normalized}/` : ''
      const entries = await this.getRecursiveTree(ref)
      return entries.filter((entry) => {
        if (normalized && entry.path === normalized) {
          return false
        }
        return entry.path.startsWith(prefix)
      })
    }

    const encodedPath = this.encodePath(normalized)
    const suffix = encodedPath ? `/${encodedPath}` : ''
    const query = `?ref=${encodeURIComponent(ref)}`
    const result = (await this.fetchREST(
      `/repos/${this.owner}/${this.repo}/contents${suffix}${query}`,
    )) as Array<{ path: string; type: string; sha: string; size?: number }> | { path: string; type: string; sha: string; size?: number }

    const entries = Array.isArray(result) ? result : [result]
    return entries
      .filter((entry) => entry.path !== normalized)
      .map((entry) => ({
        path: entry.path,
        type: entry.type === 'dir' ? 'tree' : 'blob',
        sha: entry.sha,
        size: entry.size,
      }))
  }

  async getFiles(ref: string, paths: string[]): Promise<Map<string, FileContent>> {
    const result = new Map<string, FileContent>()
    const chunkSize = 250

    for (let i = 0; i < paths.length; i += chunkSize) {
      const chunk = paths.slice(i, i + chunkSize)
      const fragments = chunk
        .map(
          (p, idx) =>
            `f${i + idx}: object(expression: "${ref}:${p}") { ... on Blob { text oid byteSize } }`,
        )
        .join('\n')

      const query = `query { repository(owner: "${this.owner}", name: "${this.repo}") { ${fragments} } }`
      const data = (await this.fetchGraphQL(query)) as {
        repository: Record<string, { text: string | null; oid: string; byteSize: number } | null>
      }

      for (let j = 0; j < chunk.length; j++) {
        const entry = data.repository[`f${i + j}`]
        if (entry?.text !== undefined && entry.text !== null) {
          const content = encodeText(entry.text)
          result.set(chunk[j], {
            path: chunk[j],
            sha: entry.oid,
            content,
            size: entry.byteSize,
          })
        }
      }
    }

    return result
  }

  async getFile(ref: string, path: string): Promise<FileContent> {
    const files = await this.getFiles(ref, [path])
    const file = files.get(path)
    if (!file) {
      throw new NotFoundError(`File not found: ${path}`)
    }
    return file
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const result = (await this.fetchREST(
      `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`,
    )) as { content: string; encoding: string }

    if (result.encoding === 'base64') {
      return fromBase64(result.content.replace(/\n/g, ''))
    }
    return encodeText(result.content)
  }

  async getBranch(name: string): Promise<BranchInfo> {
    const result = (await this.fetchREST(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${name}`,
    )) as { object: { sha: string } }
    return { name, sha: result.object.sha }
  }

  async getLastCommitSha(branch: string): Promise<string> {
    const info = await this.getBranch(branch)
    return info.sha
  }

  async createBranch(name: string, fromSha: string): Promise<BranchInfo> {
    const result = (await this.fetchREST(
      `/repos/${this.owner}/${this.repo}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha: fromSha }),
      },
    )) as { object: { sha: string } }
    return { name, sha: result.object.sha }
  }

  async deleteBranch(name: string): Promise<void> {
    await this.fetchREST(
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${name}`,
      { method: 'DELETE' },
    )
  }

  async mergeBranch(options: MergeOptions): Promise<MergeResult | null> {
    let result: { sha: string; commit: { committer: { date: string } } } | null
    try {
      result = (await this.fetchREST(`/repos/${this.owner}/${this.repo}/merges`, {
        method: 'POST',
        body: JSON.stringify({ base: options.into, head: options.from, commit_message: options.message }),
      })) as typeof result
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new ConflictError(`Merging ${options.from} into ${options.into} conflicts: both changed the same files`)
      }
      throw error
    }
    // 204 No Content: `into` already contains `from`.
    return result && { sha: result.sha, date: result.commit.committer.date }
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    const additions: Array<{ path: string; contents: string }> = []
    const deletions: Array<{ path: string }> = []

    for (const change of options.changes) {
      if (change.action === 'delete') {
        deletions.push({ path: change.path })
      } else if (change.action === 'move') {
        if (change.previousPath) {
          deletions.push({ path: change.previousPath })
        }
        const content =
          change.content instanceof Uint8Array
            ? toBase64(change.content)
            : toBase64(encodeText(change.content ?? ''))
        additions.push({ path: change.path, contents: content })
      } else {
        const content =
          change.content instanceof Uint8Array
            ? toBase64(change.content)
            : toBase64(encodeText(change.content ?? ''))
        additions.push({ path: change.path, contents: content })
      }
    }

    const mutation = `
      mutation($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) {
          commit {
            oid
            committedDate
          }
        }
      }
    `

    const variables = {
      input: {
        branch: {
          repositoryNameWithOwner: `${this.owner}/${this.repo}`,
          branchName: options.branch,
        },
        expectedHeadOid: options.expectedHeadOid,
        fileChanges: {
          ...(additions.length > 0 ? { additions } : {}),
          ...(deletions.length > 0 ? { deletions } : {}),
        },
        message: { headline: options.message },
      },
    }

    const data = (await this.fetchGraphQL(mutation, variables)) as {
      createCommitOnBranch: {
        commit: { oid: string; committedDate: string }
      }
    }

    const commitData = data.createCommitOnBranch.commit
    const files: Record<string, { sha: string }> = {}

    // GitHub's createCommitOnBranch returns the new commit SHA;
    // to get individual file SHAs, we fetch the new tree
    const changedPaths = options.changes
      .filter((change) => change.action !== 'delete')
      .map((change) => change.path)

    const changedFiles = await this.getFiles(options.branch, changedPaths)
    for (const [path, file] of changedFiles) {
      files[path] = { sha: file.sha }
    }

    return {
      sha: commitData.oid,
      date: commitData.committedDate,
      files,
    }
  }
}

/**
 * GitHub as seen by one account. List repositories with `listRepositories()`, and get one with
 * `repository('owner/name')` to pass to `GitVFS`.
 */
export function github(options: GitHubProviderOptions): GitProvider {
  return new GitHubProvider(options)
}
