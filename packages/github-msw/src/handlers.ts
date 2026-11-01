import { http, HttpResponse, type HttpHandler } from 'msw/http'
import { fromBase64, StaleHeadError, toBase64, toText, type MockRepository } from './repository.js'

export interface GitHubHandlerOptions {
  repository: MockRepository
  owner: string
  repo: string
  /** Default: https://api.github.com */
  apiUrl?: string
  /** How `GET /user/repos` describes the repository. */
  details?: { description?: string; private?: boolean; defaultBranch?: string }
  /** The profile `GET /user` returns. */
  user?: { login: string; name?: string; avatar_url?: string; html_url?: string }
  /** Called after every change (commits, branches), e.g. to save the repository. */
  onChange?: (repository: MockRepository) => void | Promise<void>
}

function notFound() {
  return HttpResponse.json({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, { status: 404 })
}

function unauthorized() {
  return HttpResponse.json({ message: 'Requires authentication' }, { status: 401 })
}

function graphqlErrors(message: string, type?: string) {
  return HttpResponse.json({ data: null, errors: [{ type, message }] })
}

/** Like GitHub, the mock requires a token, but any token is accepted. */
function isAuthenticated(request: Request): boolean {
  return /^(Bearer|token) \S+/.test(request.headers.get('Authorization') ?? '')
}

interface CreateCommitInput {
  branch: { repositoryNameWithOwner: string; branchName: string }
  expectedHeadOid?: string
  message: { headline: string; body?: string }
  fileChanges?: {
    additions?: Array<{ path: string; contents: string }>
    deletions?: Array<{ path: string }>
  }
}

/**
 * MSW request handlers for the parts of the GitHub API that gitvfs uses: the account's repository
 * list, refs, commits, trees, blobs, contents, the GraphQL file query and `createCommitOnBranch`.
 * Requests for other repositories fall through to the network.
 */
export function createGitHubHandlers(options: GitHubHandlerOptions): HttpHandler[] {
  const { repository, owner, repo } = options
  const api = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const base = `${api}/repos/${owner}/${repo}`
  const changed = async () => options.onChange?.(repository)

  return [
    http.get(`${api}/user`, ({ request }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const user = options.user ?? { login: 'demo' }
      return HttpResponse.json({ name: null, avatar_url: '', html_url: `https://github.com/${user.login}`, ...user })
    }),

    // `github({ token }).listRepositories()`: the mocked repository is the account's only one.
    http.get(`${api}/user/repos`, ({ request }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const login = options.user?.login ?? 'demo'
      const defaultBranch = options.details?.defaultBranch
        ?? (repository.branchHead('main') ? 'main' : repository.branchNames()[0] ?? null)
      const head = defaultBranch ? repository.branchHead(defaultBranch) : undefined
      const pushedAt = head ? repository.getCommit(head)!.date : null
      return HttpResponse.json([
        {
          name: repo,
          full_name: `${owner}/${repo}`,
          owner: { login: owner, type: owner === login ? 'User' : 'Organization' },
          private: options.details?.private ?? false,
          description: options.details?.description ?? null,
          html_url: `https://github.com/${owner}/${repo}`,
          default_branch: defaultBranch,
          pushed_at: pushedAt,
          updated_at: pushedAt,
          permissions: { admin: true, push: true, pull: true },
        },
      ])
    }),

    http.get(`${base}/git/ref/heads/*`, ({ request, params }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const branch = decodeURIComponent(String(params[0]))
      const sha = repository.branchHead(branch)
      if (!sha) return notFound()
      return HttpResponse.json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } })
    }),

    http.post(`${base}/git/refs`, async ({ request }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const body = (await request.json()) as { ref?: string; sha?: string }
      const name = body.ref?.replace(/^refs\/heads\//, '')
      if (!name || !body.sha) return HttpResponse.json({ message: 'Invalid request' }, { status: 422 })
      try {
        repository.createBranch(name, body.sha)
      } catch (error) {
        return HttpResponse.json({ message: (error as Error).message }, { status: 422 })
      }
      await changed()
      return HttpResponse.json({ ref: `refs/heads/${name}`, object: { sha: body.sha, type: 'commit' } }, { status: 201 })
    }),

    http.delete(`${base}/git/refs/heads/*`, async ({ request, params }) => {
      if (!isAuthenticated(request)) return unauthorized()
      if (!repository.deleteBranch(decodeURIComponent(String(params[0])))) return notFound()
      await changed()
      return new HttpResponse(null, { status: 204 })
    }),

    http.get(`${base}/git/commits/:sha`, ({ request, params }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const commit = repository.getCommit(String(params.sha))
      if (!commit) return notFound()
      return HttpResponse.json({
        sha: params.sha,
        message: commit.message,
        tree: { sha: commit.tree },
        parents: commit.parent ? [{ sha: commit.parent }] : [],
        committer: { date: commit.date },
      })
    }),

    http.get(`${base}/git/trees/:sha`, ({ request, params }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const tree = repository.getTree(String(params.sha))
      if (!tree) return notFound()
      const recursive = new URL(request.url).searchParams.has('recursive')
      const entries: Array<{ path: string; type: 'blob' | 'tree'; sha: string; size?: number }> = []
      const dirs = new Set<string>()
      for (const [path, sha] of Object.entries(tree)) {
        const parts = path.split('/')
        if (!recursive && parts.length > 1) {
          dirs.add(parts[0])
          continue
        }
        for (let i = 1; recursive && i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
        entries.push({ path, type: 'blob', sha, size: repository.getBlob(sha)!.length })
      }
      for (const dir of dirs) entries.push({ path: dir, type: 'tree', sha: '' })
      return HttpResponse.json({ sha: params.sha, tree: entries, truncated: false })
    }),

    http.get(`${base}/git/blobs/:sha`, ({ request, params }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const content = repository.getBlob(String(params.sha))
      if (!content) return notFound()
      return HttpResponse.json({ sha: params.sha, size: content.length, encoding: 'base64', content: toBase64(content) })
    }),

    http.get(`${base}/contents/*`, ({ request, params }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const ref = new URL(request.url).searchParams.get('ref') ?? 'main'
      const path = String(params[0] ?? '').split('/').map(decodeURIComponent).join('/')
      const result = repository.list(ref, path)
      if (!result) return notFound()
      if (Array.isArray(result)) return HttpResponse.json(result)
      const file = repository.readFile(ref, result.path)!
      return HttpResponse.json({ ...result, encoding: 'base64', content: toBase64(file.content) })
    }),

    // The repository root has no trailing segment for the wildcard above.
    http.get(`${base}/contents`, ({ request }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const ref = new URL(request.url).searchParams.get('ref') ?? 'main'
      const result = repository.list(ref, '')
      return result ? HttpResponse.json(result) : notFound()
    }),

    http.post(`${api}/graphql`, async ({ request }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const { query, variables } = (await request.json()) as { query: string; variables?: Record<string, unknown> }

      if (/createCommitOnBranch/.test(query)) {
        const input = variables?.input as CreateCommitInput | undefined
        if (!input || input.branch.repositoryNameWithOwner !== `${owner}/${repo}`) {
          return graphqlErrors(`Could not resolve to a Repository`, 'NOT_FOUND')
        }
        try {
          const commit = await repository.commit({
            branch: input.branch.branchName,
            message: input.message.headline,
            expectedHeadOid: input.expectedHeadOid,
            additions: input.fileChanges?.additions?.map((file) => ({ path: file.path, content: fromBase64(file.contents) })),
            deletions: input.fileChanges?.deletions?.map((file) => file.path),
          })
          await changed()
          return HttpResponse.json({
            data: { createCommitOnBranch: { commit: { oid: commit.oid, committedDate: commit.date } } },
          })
        } catch (error) {
          return graphqlErrors((error as Error).message, error instanceof StaleHeadError ? 'STALE_DATA' : 'UNPROCESSABLE')
        }
      }

      const target = /repository\(owner:\s*"([^"]+)",\s*name:\s*"([^"]+)"\)/.exec(query)
      if (!target || target[1] !== owner || target[2] !== repo) {
        return graphqlErrors(`Could not resolve to a Repository`, 'NOT_FOUND')
      }
      const result: Record<string, { text: string | null; oid: string; byteSize: number } | null> = {}
      for (const [, alias, expression] of query.matchAll(/(\w+):\s*object\(expression:\s*"([^"]+)"\)/g)) {
        const separator = expression.indexOf(':')
        const file = repository.readFile(expression.slice(0, separator), expression.slice(separator + 1))
        result[alias] = file ? { text: toText(file.content), oid: file.sha, byteSize: file.size } : null
      }
      return HttpResponse.json({ data: { repository: result } })
    }),
  ]
}
