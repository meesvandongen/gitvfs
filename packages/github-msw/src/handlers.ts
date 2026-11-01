import { http, HttpResponse, type HttpHandler } from 'msw/http'
import { fromBase64, MergeConflictError, StaleHeadError, toBase64, toText, type MockRepository } from './repository.js'

export interface RepositoryDetails {
  description?: string
  private?: boolean
  /** Default: `main` when it exists, else the first branch. */
  defaultBranch?: string
}

/** One repository the mock serves, at `owner/repo`. */
export interface MockedRepository {
  owner: string
  repo: string
  repository: MockRepository
  /** How `GET /user/repos` describes the repository. */
  details?: RepositoryDetails
}

export interface GitHubHandlerOptions {
  /** The repositories to serve, at least one. */
  repositories: MockedRepository[]
  /** Default: https://api.github.com */
  apiUrl?: string
  /** The profile `GET /user` returns. */
  user?: { login: string; name?: string; avatar_url?: string; html_url?: string }
  /** Called after every change (commits, branches) with the repository that changed, e.g. to save it. */
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

function describeRepository(entry: MockedRepository, login: string) {
  const { owner, repo, repository, details } = entry
  const defaultBranch = details?.defaultBranch
    ?? (repository.branchHead('main') ? 'main' : repository.branchNames()[0] ?? null)
  const head = defaultBranch ? repository.branchHead(defaultBranch) : undefined
  const pushedAt = head ? repository.getCommit(head)!.date : null
  return {
    name: repo,
    full_name: `${owner}/${repo}`,
    owner: { login: owner, type: owner === login ? 'User' : 'Organization' },
    private: details?.private ?? false,
    description: details?.description ?? null,
    html_url: `https://github.com/${owner}/${repo}`,
    default_branch: defaultBranch,
    pushed_at: pushedAt,
    updated_at: pushedAt,
    permissions: { admin: true, push: true, pull: true },
  }
}

/**
 * MSW request handlers for the parts of the GitHub API that gitvfs uses: the account's repository
 * list, refs, merges, commits, trees, blobs, contents, the GraphQL file query and `createCommitOnBranch`.
 * Requests for other repositories fall through to the network.
 */
export function createGitHubHandlers(options: GitHubHandlerOptions): HttpHandler[] {
  const entries = options.repositories
  if (entries.length === 0) throw new TypeError('Pass at least one repository')
  const api = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const login = options.user?.login ?? 'demo'
  const find = (owner: string, repo: string) => entries.find((entry) => entry.owner === owner && entry.repo === repo)

  return [
    http.get(`${api}/user`, ({ request }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const user = options.user ?? { login: 'demo' }
      return HttpResponse.json({ name: null, avatar_url: '', html_url: `https://github.com/${user.login}`, ...user })
    }),

    // `github({ token }).listRepositories()`: every mocked repository, most recently pushed first.
    http.get(`${api}/user/repos`, ({ request }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const repos = entries.map((entry) => describeRepository(entry, login))
      repos.sort((a, b) => String(b.pushed_at ?? '').localeCompare(String(a.pushed_at ?? '')))
      return HttpResponse.json(repos)
    }),

    ...entries.flatMap((entry) => repositoryHandlers(entry, api, async () => options.onChange?.(entry.repository))),

    http.post(`${api}/graphql`, async ({ request }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const { query, variables } = (await request.json()) as { query: string; variables?: Record<string, unknown> }

      if (/createCommitOnBranch/.test(query)) {
        const input = variables?.input as CreateCommitInput | undefined
        const [owner = '', repo = ''] = input?.branch.repositoryNameWithOwner.split('/') ?? []
        const entry = find(owner, repo)
        if (!input || !entry) return graphqlErrors(`Could not resolve to a Repository`, 'NOT_FOUND')
        try {
          const commit = await entry.repository.commit({
            branch: input.branch.branchName,
            message: input.message.headline,
            expectedHeadOid: input.expectedHeadOid,
            additions: input.fileChanges?.additions?.map((file) => ({ path: file.path, content: fromBase64(file.contents) })),
            deletions: input.fileChanges?.deletions?.map((file) => file.path),
          })
          await options.onChange?.(entry.repository)
          return HttpResponse.json({
            data: { createCommitOnBranch: { commit: { oid: commit.oid, committedDate: commit.date } } },
          })
        } catch (error) {
          return graphqlErrors((error as Error).message, error instanceof StaleHeadError ? 'STALE_DATA' : 'UNPROCESSABLE')
        }
      }

      const target = /repository\(owner:\s*"([^"]+)",\s*name:\s*"([^"]+)"\)/.exec(query)
      const entry = target ? find(target[1], target[2]) : undefined
      if (!entry) return graphqlErrors(`Could not resolve to a Repository`, 'NOT_FOUND')
      const result: Record<string, { text: string | null; oid: string; byteSize: number } | null> = {}
      for (const [, alias, expression] of query.matchAll(/(\w+):\s*object\(expression:\s*"([^"]+)"\)/g)) {
        const separator = expression.indexOf(':')
        const file = entry.repository.readFile(expression.slice(0, separator), expression.slice(separator + 1))
        result[alias] = file ? { text: toText(file.content), oid: file.sha, byteSize: file.size } : null
      }
      return HttpResponse.json({ data: { repository: result } })
    }),
  ]
}

/** The REST endpoints under `/repos/:owner/:repo` for one repository. */
function repositoryHandlers(entry: MockedRepository, api: string, changed: () => Promise<void>): HttpHandler[] {
  const { repository, owner, repo } = entry
  const base = `${api}/repos/${owner}/${repo}`

  return [
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

    http.post(`${base}/merges`, async ({ request }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const body = (await request.json()) as { base?: string; head?: string; commit_message?: string }
      if (!body.base || !body.head) return HttpResponse.json({ message: 'Invalid request' }, { status: 422 })
      if (!repository.branchHead(body.base) || !repository.resolve(body.head)) return notFound()
      let commit: { oid: string; date: string } | null
      try {
        commit = await repository.merge({ base: body.base, head: body.head, message: body.commit_message })
      } catch (error) {
        if (error instanceof MergeConflictError) return HttpResponse.json({ message: 'Merge conflict' }, { status: 409 })
        throw error
      }
      if (!commit) return new HttpResponse(null, { status: 204 })
      await changed()
      const record = repository.getCommit(commit.oid)!
      return HttpResponse.json(
        {
          sha: commit.oid,
          commit: { message: record.message, tree: { sha: record.tree }, committer: { date: commit.date } },
          parents: [{ sha: record.parent }, { sha: record.mergeParent }],
        },
        { status: 201 },
      )
    }),

    http.get(`${base}/git/commits/:sha`, ({ request, params }) => {
      if (!isAuthenticated(request)) return unauthorized()
      const commit = repository.getCommit(String(params.sha))
      if (!commit) return notFound()
      return HttpResponse.json({
        sha: params.sha,
        message: commit.message,
        tree: { sha: commit.tree },
        parents: [commit.parent, commit.mergeParent].filter(Boolean).map((sha) => ({ sha })),
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
  ]
}
