import { createFetchREST, type TokenProvider } from '../providers/shared/http.js'

export interface GitHubDiscoveryOptions {
  token: TokenProvider
  apiUrl?: string
}

export interface GitHubRepo {
  id: number
  name: string
  fullName: string
  owner: string
  private: boolean
  defaultBranch: string
  description: string | null
  url: string
  cloneUrl: string
  pushedAt: string | null
  updatedAt: string | null
}

export interface GitHubListOptions {
  /** Filter repositories by type. Defaults to 'all'. */
  type?: 'all' | 'owner' | 'public' | 'private' | 'member'
  /** Sort field. Defaults to 'updated'. */
  sort?: 'created' | 'updated' | 'pushed' | 'full_name'
  /** Sort direction. Defaults to 'desc'. */
  direction?: 'asc' | 'desc'
  /** Page size (max 100). Defaults to 100. */
  perPage?: number
}

function mapRepo(raw: Record<string, unknown>): GitHubRepo {
  const owner = raw.owner as { login: string }
  return {
    id: raw.id as number,
    name: raw.name as string,
    fullName: raw.full_name as string,
    owner: owner.login,
    private: raw.private as boolean,
    defaultBranch: raw.default_branch as string,
    description: (raw.description as string | null) ?? null,
    url: raw.html_url as string,
    cloneUrl: raw.clone_url as string,
    pushedAt: (raw.pushed_at as string | null) ?? null,
    updatedAt: (raw.updated_at as string | null) ?? null,
  }
}

/**
 * Lists all repositories accessible to the authenticated user, paginating
 * through all pages automatically.
 */
export async function listUserRepos(
  options: GitHubDiscoveryOptions,
  listOptions: GitHubListOptions = {},
): Promise<GitHubRepo[]> {
  const baseUrl = options.apiUrl ?? 'https://api.github.com'
  const fetchREST = createFetchREST({ token: options.token, baseUrl })
  const { type = 'all', sort = 'updated', direction = 'desc', perPage = 100 } = listOptions

  const repos: GitHubRepo[] = []
  let page = 1

  while (true) {
    const params = new URLSearchParams({
      type,
      sort,
      direction,
      per_page: String(perPage),
      page: String(page),
    })
    const batch = (await fetchREST(`/user/repos?${params}`)) as Array<Record<string, unknown>>
    for (const raw of batch) {
      repos.push(mapRepo(raw))
    }
    if (batch.length < perPage) break
    page++
  }

  return repos
}

/**
 * Lists all repositories for a specific GitHub user (public repos).
 */
export async function listReposForUser(
  username: string,
  options: GitHubDiscoveryOptions,
  listOptions: GitHubListOptions = {},
): Promise<GitHubRepo[]> {
  const baseUrl = options.apiUrl ?? 'https://api.github.com'
  const fetchREST = createFetchREST({ token: options.token, baseUrl })
  const { sort = 'updated', direction = 'desc', perPage = 100 } = listOptions

  const repos: GitHubRepo[] = []
  let page = 1

  while (true) {
    const params = new URLSearchParams({
      sort,
      direction,
      per_page: String(perPage),
      page: String(page),
    })
    const batch = (await fetchREST(
      `/users/${encodeURIComponent(username)}/repos?${params}`,
    )) as Array<Record<string, unknown>>
    for (const raw of batch) {
      repos.push(mapRepo(raw))
    }
    if (batch.length < perPage) break
    page++
  }

  return repos
}

/**
 * Lists all repositories for a GitHub organization.
 */
export async function listReposForOrg(
  org: string,
  options: GitHubDiscoveryOptions,
  listOptions: GitHubListOptions & { type?: 'all' | 'public' | 'private' | 'forks' | 'sources' | 'member' } = {},
): Promise<GitHubRepo[]> {
  const baseUrl = options.apiUrl ?? 'https://api.github.com'
  const fetchREST = createFetchREST({ token: options.token, baseUrl })
  const { type = 'all', sort = 'updated', direction = 'desc', perPage = 100 } = listOptions

  const repos: GitHubRepo[] = []
  let page = 1

  while (true) {
    const params = new URLSearchParams({
      type,
      sort,
      direction,
      per_page: String(perPage),
      page: String(page),
    })
    const batch = (await fetchREST(
      `/orgs/${encodeURIComponent(org)}/repos?${params}`,
    )) as Array<Record<string, unknown>>
    for (const raw of batch) {
      repos.push(mapRepo(raw))
    }
    if (batch.length < perPage) break
    page++
  }

  return repos
}
