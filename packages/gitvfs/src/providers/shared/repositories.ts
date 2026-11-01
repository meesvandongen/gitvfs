import type { RepositoryInfo } from '../../types/provider.js'

/** Case-insensitive match on the full name and description, the same for every host. */
export function matchesSearch(repo: RepositoryInfo, search: string | undefined): boolean {
  const needle = search?.trim().toLowerCase()
  if (!needle) return true
  return repo.fullName.toLowerCase().includes(needle) || (repo.description ?? '').toLowerCase().includes(needle)
}

/** `owner` and `name` of a full name; the owner may itself contain slashes (GitLab subgroups). */
export function splitFullName(fullName: string): { owner: string; name: string } {
  const slash = fullName.lastIndexOf('/')
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) }
}
