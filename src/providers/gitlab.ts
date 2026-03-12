import type {
  GitProvider,
  TreeEntry,
  FileContent,
  BranchInfo,
  CommitOptions,
  CommitResult,
} from '../types/provider.js'
import { NotFoundError } from '../types/errors.js'
import { createFetchREST } from './shared/http.js'
import { createFetchGraphQL } from './shared/graphql.js'
import { encodeText, toBase64, fromBase64, decodeText } from '../utils/encoding.js'
import { getGitHash } from '../utils/hash.js'

export interface GitLabOptions {
  token: string
  projectId: string | number
  apiUrl?: string
}

class GitLabProvider implements GitProvider {
  private projectId: string
  private fetchREST: ReturnType<typeof createFetchREST>
  private fetchGraphQL: ReturnType<typeof createFetchGraphQL>
  private fullPath: string | undefined

  constructor(options: GitLabOptions) {
    this.projectId = String(options.projectId)
    const baseUrl = options.apiUrl ?? 'https://gitlab.com'
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

  async getTree(ref: string): Promise<TreeEntry[]> {
    const fullPath = await this.getFullPath()
    const entries: TreeEntry[] = []
    let endCursor: string | null = null
    let hasNextPage = true

    while (hasNextPage) {
      const afterClause = endCursor ? `, after: "${endCursor}"` : ''
      const query = `
        query {
          project(fullPath: "${fullPath}") {
            repository {
              tree(ref: "${ref}", recursive: true) {
                blobs(first: 100${afterClause}) {
                  pageInfo { hasNextPage endCursor }
                  nodes { path sha flatPath }
                }
                trees(first: 100${afterClause}) {
                  nodes { path sha }
                }
              }
            }
          }
        }
      `

      const data = (await this.fetchGraphQL(query)) as {
        project: {
          repository: {
            tree: {
              blobs: {
                pageInfo: { hasNextPage: boolean; endCursor: string }
                nodes: Array<{ path: string; sha: string; flatPath: string }>
              }
              trees: { nodes: Array<{ path: string; sha: string }> }
            }
          }
        }
      }

      const tree = data.project.repository.tree

      for (const blob of tree.blobs.nodes) {
        entries.push({ path: blob.path, type: 'blob', sha: blob.sha })
      }

      for (const t of tree.trees.nodes) {
        entries.push({ path: t.path, type: 'tree', sha: t.sha })
      }

      hasNextPage = tree.blobs.pageInfo.hasNextPage
      endCursor = tree.blobs.pageInfo.endCursor
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

/** Factory function for creating a GitLab provider. */
export function gitlab(options: GitLabOptions): GitProvider {
  return new GitLabProvider(options)
}
