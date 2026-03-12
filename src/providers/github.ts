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
import { fromBase64, toBase64, encodeText } from '../utils/encoding.js'

export interface GitHubOptions {
  token: string
  owner: string
  repo: string
  apiUrl?: string
}

class GitHubProvider implements GitProvider {
  private owner: string
  private repo: string
  private fetchREST: ReturnType<typeof createFetchREST>
  private fetchGraphQL: ReturnType<typeof createFetchGraphQL>

  constructor(options: GitHubOptions) {
    this.owner = options.owner
    this.repo = options.repo
    const baseUrl = options.apiUrl ?? 'https://api.github.com'
    this.fetchREST = createFetchREST({ token: options.token, baseUrl })
    this.fetchGraphQL = createFetchGraphQL({
      token: options.token,
      url: `${baseUrl.replace('api.github.com', 'api.github.com')}/graphql`,
    })
  }

  async getTree(ref: string): Promise<TreeEntry[]> {
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
    const newTree = await this.getTree(options.branch)
    for (const change of options.changes) {
      if (change.action !== 'delete') {
        const entry = newTree.find((e) => e.path === change.path)
        if (entry) {
          files[change.path] = { sha: entry.sha }
        }
      }
    }

    return {
      sha: commitData.oid,
      date: commitData.committedDate,
      files,
    }
  }
}

/** Factory function for creating a GitHub provider. */
export function github(options: GitHubOptions): GitProvider {
  return new GitHubProvider(options)
}
