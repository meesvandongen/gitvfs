import { GitFS } from 'git-fs'
import { github } from 'git-fs/providers/github'
import { gitlab } from 'git-fs/providers/gitlab'
import type { Provider } from './provider-config'

export interface GitHubRepoSelection {
  kind: 'github'
  owner: string
  repo: string
  branch: string
}

export interface GitLabRepoSelection {
  kind: 'gitlab'
  projectId: string
  name: string
  branch: string
  apiUrl?: string
}

export type RepoSelection = GitHubRepoSelection | GitLabRepoSelection

export type RepoCard = RepoSelection & {
  label: string
  description: string | null
  visibility: 'private' | 'public'
  updatedAt: string | null
}

interface GitHubRepoApiModel {
  full_name: string
  name: string
  owner: { login: string }
  default_branch: string
  private: boolean
  description: string | null
  pushed_at: string | null
}

interface GitLabProjectApiModel {
  id: number
  path_with_namespace: string
  default_branch: string | null
  visibility: string
  description: string | null
  last_activity_at: string | null
}

export async function fetchAvailableRepositories(params: {
  provider: Provider
  token: string
  apiUrl?: string
}): Promise<RepoCard[]> {
  const { provider, token, apiUrl } = params

  const repos = provider === 'github'
    ? await fetchGitHubRepositories(token)
    : await fetchGitLabProjects(token, apiUrl)

  return repos.sort((a, b) => {
    const aUpdated = a.updatedAt ?? ''
    const bUpdated = b.updatedAt ?? ''

    return bUpdated.localeCompare(aUpdated) || a.label.localeCompare(b.label)
  })
}

async function fetchGitHubRepositories(token: string): Promise<RepoCard[]> {
  const repos: GitHubRepoApiModel[] = []
  let nextUrl: string | null =
    'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'

  while (nextUrl !== null) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    })

    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status}`)
    }

    repos.push(...(await response.json() as GitHubRepoApiModel[]))

    const linkHeader = response.headers.get('Link') ?? ''
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
    nextUrl = nextMatch?.[1] ?? null
  }

  return repos.map((repo) => ({
    kind: 'github',
    owner: repo.owner.login,
    repo: repo.name,
    branch: repo.default_branch,
    label: repo.full_name,
    description: repo.description,
    visibility: repo.private ? 'private' : 'public',
    updatedAt: repo.pushed_at,
  }))
}

async function fetchGitLabProjects(token: string, apiUrl?: string): Promise<RepoCard[]> {
  const baseUrl = (apiUrl ?? 'https://gitlab.com').replace(/\/$/, '')
  const projects: GitLabProjectApiModel[] = []
  let page = 1

  while (true) {
    const response = await fetch(
      `${baseUrl}/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )

    if (!response.ok) {
      throw new Error(`GitLab API error ${response.status}`)
    }

    const batch = await response.json() as GitLabProjectApiModel[]
    projects.push(...batch)

    if (batch.length < 100) {
      break
    }

    page += 1
  }

  return projects.map((project) => ({
    kind: 'gitlab',
    projectId: String(project.id),
    name: project.path_with_namespace,
    branch: project.default_branch ?? 'main',
    apiUrl,
    label: project.path_with_namespace,
    description: project.description,
    visibility: project.visibility === 'private' ? 'private' : 'public',
    updatedAt: project.last_activity_at,
  }))
}

export function createGitFs(params: RepoSelection & { token: string }): GitFS {
  if (params.kind === 'github') {
    return new GitFS({
      provider: github({
        token: params.token,
        owner: params.owner,
        repo: params.repo,
      }),
      branch: params.branch,
    })
  }

  return new GitFS({
    provider: gitlab({
      token: params.token,
      projectId: params.projectId,
      apiUrl: params.apiUrl,
    }),
    branch: params.branch,
  })
}

export async function readTextFile(fs: GitFS, path: string): Promise<string> {
  return await fs.readFile(path, { encoding: 'utf-8' }) as string
}

export async function saveFileAndCommit(params: {
  fs: GitFS
  path: string
  content: string
}): Promise<void> {
  const { fs, path, content } = params

  fs.writeFile(path, content)
  await fs.commit(`Update ${path}`)
}
