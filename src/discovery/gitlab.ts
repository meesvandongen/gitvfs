import { createFetchREST, type TokenProvider } from '../providers/shared/http.js'

export interface GitLabDiscoveryOptions {
  token: TokenProvider
  apiUrl?: string
}

export interface GitLabProject {
  id: number
  name: string
  nameWithNamespace: string
  path: string
  pathWithNamespace: string
  namespace: string
  private: boolean
  defaultBranch: string | null
  description: string | null
  url: string
  httpUrlToRepo: string
  lastActivityAt: string | null
}

export interface GitLabListOptions {
  /**
   * Filter projects by visibility. Omit for all visible projects.
   */
  visibility?: 'public' | 'internal' | 'private'
  /**
   * Include projects the user is a member of (in addition to owned). Defaults to true.
   */
  membership?: boolean
  /**
   * Include archived projects. Defaults to false.
   */
  archived?: boolean
  /** Sort field. Defaults to 'last_activity_at'. */
  orderBy?: 'id' | 'name' | 'path' | 'created_at' | 'updated_at' | 'last_activity_at'
  /** Sort direction. Defaults to 'desc'. */
  sort?: 'asc' | 'desc'
  /** Page size (max 100). Defaults to 100. */
  perPage?: number
}

function mapProject(raw: Record<string, unknown>): GitLabProject {
  const ns = raw.namespace as { name: string } | undefined
  return {
    id: raw.id as number,
    name: raw.name as string,
    nameWithNamespace: raw.name_with_namespace as string,
    path: raw.path as string,
    pathWithNamespace: raw.path_with_namespace as string,
    namespace: ns?.name ?? '',
    private: (raw.visibility as string) === 'private',
    defaultBranch: (raw.default_branch as string | null) ?? null,
    description: (raw.description as string | null) ?? null,
    url: raw.web_url as string,
    httpUrlToRepo: raw.http_url_to_repo as string,
    lastActivityAt: (raw.last_activity_at as string | null) ?? null,
  }
}

/**
 * Lists all projects accessible to the authenticated user, paginating through
 * all pages automatically.
 */
export async function listUserProjects(
  options: GitLabDiscoveryOptions,
  listOptions: GitLabListOptions = {},
): Promise<GitLabProject[]> {
  const baseUrl = (options.apiUrl ?? 'https://gitlab.com') + '/api/v4'
  const fetchREST = createFetchREST({ token: options.token, baseUrl })
  const {
    visibility,
    membership = true,
    archived = false,
    orderBy = 'last_activity_at',
    sort = 'desc',
    perPage = 100,
  } = listOptions

  const projects: GitLabProject[] = []
  let page = 1

  while (true) {
    const params = new URLSearchParams({
      membership: String(membership),
      archived: String(archived),
      order_by: orderBy,
      sort,
      per_page: String(perPage),
      page: String(page),
    })
    if (visibility) params.set('visibility', visibility)

    const batch = (await fetchREST(`/projects?${params}`)) as Array<Record<string, unknown>>
    for (const raw of batch) {
      projects.push(mapProject(raw))
    }
    if (batch.length < perPage) break
    page++
  }

  return projects
}

/**
 * Lists all projects owned by or belonging to a specific GitLab user.
 */
export async function listProjectsForUser(
  username: string,
  options: GitLabDiscoveryOptions,
  listOptions: GitLabListOptions = {},
): Promise<GitLabProject[]> {
  const baseUrl = (options.apiUrl ?? 'https://gitlab.com') + '/api/v4'
  const fetchREST = createFetchREST({ token: options.token, baseUrl })
  const {
    visibility,
    archived = false,
    orderBy = 'last_activity_at',
    sort = 'desc',
    perPage = 100,
  } = listOptions

  const projects: GitLabProject[] = []
  let page = 1

  while (true) {
    const params = new URLSearchParams({
      archived: String(archived),
      order_by: orderBy,
      sort,
      per_page: String(perPage),
      page: String(page),
    })
    if (visibility) params.set('visibility', visibility)

    const batch = (await fetchREST(
      `/users/${encodeURIComponent(username)}/projects?${params}`,
    )) as Array<Record<string, unknown>>
    for (const raw of batch) {
      projects.push(mapProject(raw))
    }
    if (batch.length < perPage) break
    page++
  }

  return projects
}

/**
 * Lists all projects within a GitLab group (including subgroups if requested).
 */
export async function listProjectsForGroup(
  groupPath: string,
  options: GitLabDiscoveryOptions,
  listOptions: GitLabListOptions & { includeSubgroups?: boolean } = {},
): Promise<GitLabProject[]> {
  const baseUrl = (options.apiUrl ?? 'https://gitlab.com') + '/api/v4'
  const fetchREST = createFetchREST({ token: options.token, baseUrl })
  const {
    visibility,
    archived = false,
    orderBy = 'last_activity_at',
    sort = 'desc',
    perPage = 100,
    includeSubgroups = false,
  } = listOptions

  const projects: GitLabProject[] = []
  let page = 1

  while (true) {
    const params = new URLSearchParams({
      archived: String(archived),
      order_by: orderBy,
      sort,
      per_page: String(perPage),
      page: String(page),
      include_subgroups: String(includeSubgroups),
    })
    if (visibility) params.set('visibility', visibility)

    const batch = (await fetchREST(
      `/groups/${encodeURIComponent(groupPath)}/projects?${params}`,
    )) as Array<Record<string, unknown>>
    for (const raw of batch) {
      projects.push(mapProject(raw))
    }
    if (batch.length < perPage) break
    page++
  }

  return projects
}
