import type { Provider } from './provider-config'

export interface UserProfile {
  name: string
  avatar: string | null
  email: string | null
}

let cached: UserProfile | null = null

export function getCachedUserProfile(): UserProfile | null {
  return cached
}

export function clearCachedUserProfile(): void {
  cached = null
}

export async function fetchUserProfile(
  provider: Provider,
  token: string,
  apiUrl?: string,
): Promise<UserProfile> {
  if (cached !== null) {
    return cached
  }

  const profile = provider === 'github'
    ? await fetchGitHubProfile(token)
    : await fetchGitLabProfile(token, apiUrl)

  cached = profile

  return profile
}

interface GitHubUserResponse {
  login: string
  name: string | null
  email: string | null
  avatar_url: string
}

async function fetchGitHubProfile(token: string): Promise<UserProfile> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub user API error ${response.status}`)
  }

  const data = await response.json() as GitHubUserResponse

  return {
    name: data.name ?? data.login,
    avatar: data.avatar_url,
    email: data.email,
  }
}

interface GitLabUserResponse {
  username: string
  name: string
  email: string | null
  avatar_url: string | null
}

async function fetchGitLabProfile(token: string, apiUrl?: string): Promise<UserProfile> {
  const baseUrl = (apiUrl ?? 'https://gitlab.com').replace(/\/$/, '')

  const response = await fetch(`${baseUrl}/api/v4/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(`GitLab user API error ${response.status}`)
  }

  const data = await response.json() as GitLabUserResponse

  return {
    name: data.name ?? data.username,
    avatar: data.avatar_url,
    email: data.email,
  }
}
