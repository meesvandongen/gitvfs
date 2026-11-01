import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { GitFS, type DirEntry, type GitProvider } from 'gitvfs'
import { github } from 'gitvfs/providers/github'
import { gitlab } from 'gitvfs/providers/gitlab'
import type { Provider } from './provider-config'

/** A repository plus branch, as kept in the editor's URL. */
export interface RepoSelection {
  kind: Provider
  /** The full name: `owner/name` on GitHub, `group/project` on GitLab. */
  repository: string
  branch: string
  apiUrl?: string
}

export type RepoCard = RepoSelection & {
  description: string | null
  visibility: 'private' | 'public'
  updatedAt: string | null
}

export type RepoSession = RepoSelection & { token: string }

/** The same code works for both hosts from here on. */
export function createProvider(params: { kind: Provider; token: string; apiUrl?: string }): GitProvider {
  return params.kind === 'github'
    ? github({ token: params.token })
    : gitlab({ token: params.token, apiUrl: params.apiUrl })
}

const gitFsRegistry = new Map<string, GitFS>()

function getRepoSessionKey(params: RepoSession): string {
  return [params.kind, params.apiUrl ?? '', params.repository, params.branch, params.token].join(':')
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'tree' ? -1 : 1
    }

    return a.name.localeCompare(b.name)
  })
}

export function getRepoQueryKey(params: RepoSession) {
  return ['gitvfs', getRepoSessionKey(params)] as const
}

export async function fetchAvailableRepositories(params: {
  provider: Provider
  token: string
  apiUrl?: string
}): Promise<RepoCard[]> {
  const repos: RepoCard[] = []
  for await (const repo of createProvider({ kind: params.provider, token: params.token, apiUrl: params.apiUrl }).listRepositories()) {
    repos.push({
      kind: params.provider,
      repository: repo.fullName,
      branch: repo.defaultBranch ?? 'main',
      apiUrl: params.apiUrl,
      description: repo.description,
      visibility: repo.private ? 'private' : 'public',
      updatedAt: repo.updatedAt,
    })
  }
  return repos
}

export function createGitFs(params: RepoSession): GitFS {
  return new GitFS({
    repository: createProvider(params).repository(params.repository),
    branch: params.branch,
    headValidationIntervalMs: 30_000,
  })
}

export function getGitFs(params: RepoSession): GitFS {
  const key = getRepoSessionKey(params)
  const existing = gitFsRegistry.get(key)

  if (existing) {
    return existing
  }

  const fs = createGitFs(params)
  gitFsRegistry.set(key, fs)
  return fs
}

export function getRepositoriesQueryOptions(params: {
  provider: Provider
  token: string
  apiUrl?: string
}) {
  return queryOptions({
    queryKey: ['repositories', params.provider, params.apiUrl ?? '', params.token],
    queryFn: () => fetchAvailableRepositories(params),
    staleTime: 60_000,
  })
}

export function getDirectoryQueryOptions(params: RepoSession, path: string) {
  return queryOptions({
    queryKey: [...getRepoQueryKey(params), 'dir', path],
    queryFn: async () => sortEntries(await getGitFs(params).readdir(path) as DirEntry[]),
    staleTime: 60_000,
  })
}

export function getFileTextQueryOptions(params: RepoSession, path: string) {
  return queryOptions({
    queryKey: [...getRepoQueryKey(params), 'file', path],
    queryFn: async () => readTextFile(getGitFs(params), path),
    staleTime: 60_000,
  })
}

export function updateCachedFileText(
  queryClient: QueryClient,
  params: RepoSession,
  path: string,
  content: string,
): void {
  queryClient.setQueryData(getFileTextQueryOptions(params, path).queryKey, content)
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
