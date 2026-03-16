export type Provider = 'github' | 'gitlab'

export interface ProviderConfig {
  provider: Provider
  apiUrl?: string
  createTokenUrl: string
  tokenScopesHint: string
}

const PROVIDERS: Provider[] = ['github', 'gitlab']
const PROVIDER_KEY = 'gitvfs-provider'
const TOKEN_KEY_PREFIX = 'gitvfs-token:'
const sessionListeners = new Set<() => void>()
let storageListenerAttached = false
let cachedSessionSnapshot: ProviderSessionSnapshot | null = null

function notifySessionListeners(): void {
  sessionListeners.forEach((listener) => listener())
}

function ensureStorageListener(): void {
  if (storageListenerAttached || typeof window === 'undefined') {
    return
  }

  storageListenerAttached = true

  window.addEventListener('storage', (event) => {
    if (event.key === PROVIDER_KEY || event.key?.startsWith(TOKEN_KEY_PREFIX)) {
      notifySessionListeners()
    }
  })
}

export function getAvailableProviderConfigs(): Record<Provider, ProviderConfig> {
  const gitlabUrl = (import.meta.env.VITE_GITLAB_URL ?? 'https://gitlab.com').replace(/\/$/, '')

  return {
    github: {
      provider: 'github',
      createTokenUrl: 'https://github.com/settings/personal-access-tokens/new',
      tokenScopesHint:
        'Use a token that can list repositories, read files, and commit changes. Classic tokens usually need repo access; fine-grained tokens need repository contents access plus metadata read access.',
    },
    gitlab: {
      provider: 'gitlab',
      createTokenUrl: `${gitlabUrl}/-/user_settings/personal_access_tokens`,
      tokenScopesHint:
        'Use a token with the api scope so the sample can list projects, read files, and commit updates.',
      apiUrl: gitlabUrl !== 'https://gitlab.com' ? gitlabUrl : undefined,
    },
  }
}

export function getProviderConfig(provider: Provider): ProviderConfig {
  return getAvailableProviderConfigs()[provider]
}

export function getConfiguredProviders(): Provider[] {
  return PROVIDERS
}

export function hasAnyProviderConfigured(): boolean {
  return true
}

export function hasMultipleProvidersConfigured(): boolean {
  return getConfiguredProviders().length > 1
}

export function getStoredProvider(): Provider | null {
  if (typeof window === 'undefined') {
    return null
  }

  const provider = window.localStorage.getItem(PROVIDER_KEY)

  return provider === 'github' || provider === 'gitlab' ? provider : null
}

export function getActiveProviderConfig(): ProviderConfig {
  const storedProvider = getStoredProvider()

  return getProviderConfig(storedProvider ?? 'github')
}

export function persistSelectedProvider(provider: Provider): void {
  window.localStorage.setItem(PROVIDER_KEY, provider)
  notifySessionListeners()
}

export function clearSelectedProvider(): void {
  window.localStorage.removeItem(PROVIDER_KEY)
  notifySessionListeners()
}

export function getStoredProviderToken(provider: Provider): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  const token = window.localStorage.getItem(`${TOKEN_KEY_PREFIX}${provider}`)?.trim() ?? ''

  return token.length > 0 ? token : null
}

export function getActiveProviderToken(): string | null {
  return getStoredProviderToken(getActiveProviderConfig().provider)
}

export function persistProviderToken(provider: Provider, token: string): void {
  const normalizedToken = token.trim()

  if (normalizedToken.length === 0) {
    window.localStorage.removeItem(`${TOKEN_KEY_PREFIX}${provider}`)
  } else {
    window.localStorage.setItem(`${TOKEN_KEY_PREFIX}${provider}`, normalizedToken)
  }

  notifySessionListeners()
}

export function clearStoredProviderToken(provider: Provider): void {
  window.localStorage.removeItem(`${TOKEN_KEY_PREFIX}${provider}`)
  notifySessionListeners()
}

export interface ProviderSessionSnapshot {
  activeProvider: Provider
  tokens: Record<Provider, string | null>
}

export function getProviderSessionSnapshot(): ProviderSessionSnapshot {
  const nextSnapshot: ProviderSessionSnapshot = {
    activeProvider: getActiveProviderConfig().provider,
    tokens: {
      github: getStoredProviderToken('github'),
      gitlab: getStoredProviderToken('gitlab'),
    },
  }

  if (
    cachedSessionSnapshot !== null
    && cachedSessionSnapshot.activeProvider === nextSnapshot.activeProvider
    && cachedSessionSnapshot.tokens.github === nextSnapshot.tokens.github
    && cachedSessionSnapshot.tokens.gitlab === nextSnapshot.tokens.gitlab
  ) {
    return cachedSessionSnapshot
  }

  cachedSessionSnapshot = nextSnapshot

  return nextSnapshot
}

export function subscribeToProviderSession(listener: () => void): () => void {
  ensureStorageListener()
  sessionListeners.add(listener)

  return () => {
    sessionListeners.delete(listener)
  }
}

export function getProviderDisplayName(provider: Provider): string {
  return provider === 'github' ? 'GitHub' : 'GitLab'
}
