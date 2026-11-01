import { createPkcePair, randomString } from './pkce.js'
import type { SignOutRequest, TokenRequest, TokenResponse } from './protocol.js'

/** Same shape as gitvfs's `TokenProvider`, so `auth.token` can be passed to a provider directly. */
export type TokenProvider = () => Promise<string>

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface GitHubAuthOptions {
  /** Client ID of your GitHub App (recommended) or OAuth App. */
  clientId: string
  /** URL of your token exchange endpoint, served by `createTokenHandler` from `gitvfs-github-auth/server`. */
  tokenUrl: string
  /** Where GitHub sends the user back. Must match a callback URL of the app. Default: the current page. */
  redirectUri?: string
  /** OAuth Apps only, e.g. `repo` or `public_repo`. GitHub Apps get their permissions from the app. */
  scope?: string
  /** GitHub Enterprise Server: the web URL, e.g. `https://github.example.com`. Default: https://github.com */
  githubUrl?: string
  /** REST API URL used by `fetchUser`. Default: https://api.github.com */
  apiUrl?: string
  /**
   * `storage` (default): tokens, including the refresh token, are kept in `storage`.
   * `cookie`: the token handler keeps the refresh token in an encrypted `HttpOnly` cookie (its
   * `session` option). JavaScript only holds the short-lived access token, in `storage`, and
   * gets a new one through the cookie when it expires or is missing (`restoreSession()`).
   */
  session?: 'storage' | 'cookie'
  /**
   * Where tokens are kept in `storage` mode. `session` (default) survives reloads but not closing
   * the tab, `local` survives restarts, `memory` lasts until reload. Or pass any Storage-like object.
   */
  storage?: 'session' | 'local' | 'memory' | StorageLike
  /** Prefix for storage keys. Default: `gitvfs-github-auth` */
  storageKey?: string
}

export interface GitHubTokens {
  accessToken: string
  tokenType: string
  scope: string
  /** Epoch milliseconds. Absent for tokens that do not expire (OAuth Apps without expiry). */
  expiresAt?: number
  refreshToken?: string
  refreshTokenExpiresAt?: number
  /** Cookie sessions: epoch milliseconds when the session cookie expires. */
  sessionExpiresAt?: number
}

export interface GitHubUser {
  login: string
  name: string | null
  avatar_url: string
  html_url: string
}

export type GitHubAuthErrorCode =
  | 'not_signed_in'
  | 'session_expired'
  | 'state_mismatch'
  | 'token_exchange_failed'
  | (string & {})

export class GitHubAuthError extends Error {
  constructor(
    public readonly code: GitHubAuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GitHubAuthError'
  }
}

interface PendingLogin {
  state: string
  verifier: string
  redirectUri: string
  returnTo?: string
}

// Refresh a little early so a request never leaves with a token that expires in flight.
const EXPIRY_SKEW_MS = 60_000

function memoryStorage(): StorageLike {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}

function browserStorage(kind: 'session' | 'local'): StorageLike {
  try {
    const storage = kind === 'session' ? window.sessionStorage : window.localStorage
    const probe = '__gitvfs_github_auth__'
    storage.setItem(probe, probe)
    storage.removeItem(probe)
    return storage
  } catch {
    // Blocked storage (private mode, sandboxed frames): fall back to memory.
    return memoryStorage()
  }
}

function resolveStorage(storage: GitHubAuthOptions['storage']): StorageLike {
  if (storage === undefined || storage === 'session') return browserStorage('session')
  if (storage === 'local') return browserStorage('local')
  if (storage === 'memory') return memoryStorage()
  return storage
}

function readJson<T>(storage: StorageLike, key: string): T | null {
  try {
    const value = storage.getItem(key)
    return value ? (JSON.parse(value) as T) : null
  } catch {
    return null
  }
}

export function toTokens(response: TokenResponse, now = Date.now()): GitHubTokens {
  return {
    accessToken: response.access_token,
    tokenType: response.token_type ?? 'bearer',
    scope: response.scope ?? '',
    expiresAt: response.expires_in ? now + response.expires_in * 1000 : undefined,
    refreshToken: response.refresh_token,
    refreshTokenExpiresAt: response.refresh_token_expires_in
      ? now + response.refresh_token_expires_in * 1000
      : undefined,
    sessionExpiresAt: response.session_expires_in ? now + response.session_expires_in * 1000 : undefined,
  }
}

/**
 * Sign users in with GitHub from the browser using the authorization code flow with PKCE.
 * GitHub still requires the client secret to exchange the code and sends no CORS headers, so the
 * exchange goes through `tokenUrl`, a small handler you host (see `gitvfs-github-auth/server`).
 */
export class GitHubAuth {
  private readonly storage: StorageLike
  // The PKCE verifier must survive the redirect even when tokens are kept in memory.
  private readonly pendingStorage: StorageLike
  private readonly tokensKey: string
  private readonly pendingKey: string
  private readonly cookieSession: boolean
  private refreshing: Promise<GitHubTokens> | null = null

  constructor(private readonly options: GitHubAuthOptions) {
    this.cookieSession = options.session === 'cookie'
    const prefix = options.storageKey ?? 'gitvfs-github-auth'
    this.tokensKey = `${prefix}:tokens`
    this.pendingKey = `${prefix}:pending`
    this.storage = resolveStorage(options.storage)
    this.pendingStorage = options.storage === 'memory' ? browserStorage('session') : this.storage
    // A refresh token left behind by an earlier storage-mode session must not linger in cookie mode.
    if (this.cookieSession && this.getTokens()?.refreshToken) this.forget()
  }

  /** A gitvfs `TokenProvider`: returns a valid access token, refreshing it when needed. */
  readonly token: TokenProvider = () => this.getAccessToken()

  private get githubUrl(): string {
    return (this.options.githubUrl ?? 'https://github.com').replace(/\/$/, '')
  }

  /** The URL GitHub's authorize page is opened with. */
  async createAuthorizeUrl(options: { returnTo?: string } = {}): Promise<string> {
    const { verifier, challenge } = await createPkcePair()
    const state = randomString(16)
    const redirectUri = this.options.redirectUri ?? `${location.origin}${location.pathname}`
    const pending: PendingLogin = { state, verifier, redirectUri, returnTo: options.returnTo }
    this.pendingStorage.setItem(this.pendingKey, JSON.stringify(pending))

    const url = new URL(`${this.githubUrl}/login/oauth/authorize`)
    url.searchParams.set('client_id', this.options.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (this.options.scope) url.searchParams.set('scope', this.options.scope)
    return url.toString()
  }

  /** Redirect to GitHub to sign in. `returnTo` is handed back by `handleRedirect`. */
  async login(options: { returnTo?: string } = {}): Promise<void> {
    location.assign(await this.createAuthorizeUrl(options))
  }

  /**
   * Finish a sign-in when the current URL is GitHub's redirect back to the app. Returns `null`
   * when there is nothing to finish. Removes `code` and `state` from the address bar.
   */
  async handleRedirect(url: string = location.href): Promise<{ returnTo?: string } | null> {
    const current = new URL(url)
    const code = current.searchParams.get('code')
    const error = current.searchParams.get('error')
    const state = current.searchParams.get('state')
    const errorDescription = current.searchParams.get('error_description')
    if (!code && !error) return null

    const pending = readJson<PendingLogin>(this.pendingStorage, this.pendingKey)
    this.pendingStorage.removeItem(this.pendingKey)
    this.cleanUrl(current)

    if (error) {
      throw new GitHubAuthError(error, errorDescription ?? error)
    }
    if (!pending || pending.state !== state) {
      throw new GitHubAuthError('state_mismatch', 'The sign-in response does not match a sign-in started here')
    }

    const tokens = await this.requestTokens({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
    })
    this.storeTokens(tokens)
    return { returnTo: pending.returnTo }
  }

  getTokens(): GitHubTokens | null {
    return readJson<GitHubTokens>(this.storage, this.tokensKey)
  }

  /**
   * Whether tokens are at hand. With cookie sessions this only knows about the current page load;
   * call `restoreSession()` after a reload.
   */
  isSignedIn(): boolean {
    const tokens = this.getTokens()
    if (!tokens) return false
    return !this.isExpired(tokens) || this.canRefresh(tokens)
  }

  /**
   * Pick up an existing session: with cookie sessions, ask the token handler for a fresh access
   * token using the session cookie. Resolves to whether the user is signed in.
   */
  async restoreSession(): Promise<boolean> {
    if (this.isSignedIn()) return true
    if (!this.cookieSession) return false
    try {
      await this.getAccessToken()
      return true
    } catch {
      return false
    }
  }

  /** A valid access token. Refreshes expired tokens; throws `GitHubAuthError` when signed out. */
  async getAccessToken(): Promise<string> {
    const tokens = this.getTokens()
    if (tokens && !this.isExpired(tokens)) return tokens.accessToken
    if (this.cookieSession) return (await this.refresh({ grant_type: 'refresh_token' })).accessToken
    if (!tokens) throw new GitHubAuthError('not_signed_in', 'Sign in with GitHub first')
    if (!this.canRefresh(tokens)) {
      this.forget()
      throw new GitHubAuthError('session_expired', 'Your GitHub session expired; sign in again')
    }
    return (await this.refresh({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken! })).accessToken
  }

  private refresh(request: TokenRequest): Promise<GitHubTokens> {
    this.refreshing ??= this.requestTokens(request)
      .then((next) => {
        this.storeTokens(next)
        return next
      })
      .catch((error: unknown) => {
        this.forget()
        if (error instanceof GitHubAuthError && error.code === 'no_session') {
          throw new GitHubAuthError('not_signed_in', 'Sign in with GitHub first')
        }
        throw error
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  /** The signed-in user's GitHub profile. */
  async fetchUser(): Promise<GitHubUser> {
    const apiUrl = (this.options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
    const response = await fetch(`${apiUrl}/user`, {
      headers: {
        Authorization: `Bearer ${await this.getAccessToken()}`,
        Accept: 'application/vnd.github+json',
      },
    })
    if (!response.ok) throw new GitHubAuthError('user_request_failed', `GitHub API error ${response.status}`)
    return (await response.json()) as GitHubUser
  }

  /**
   * Forget the tokens in this browser, and with cookie sessions have the handler clear the session
   * cookie. GitHub keeps the app authorized for the user.
   */
  async signOut(): Promise<void> {
    this.forget()
    if (!this.cookieSession) return
    const request: SignOutRequest = { action: 'sign_out' }
    await fetch(this.options.tokenUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }).catch(() => undefined)
  }

  private forget(): void {
    this.storage.removeItem(this.tokensKey)
  }

  private isExpired(tokens: GitHubTokens): boolean {
    return tokens.expiresAt !== undefined && Date.now() >= tokens.expiresAt - EXPIRY_SKEW_MS
  }

  private canRefresh(tokens: GitHubTokens): boolean {
    if (this.cookieSession) return tokens.sessionExpiresAt === undefined || Date.now() < tokens.sessionExpiresAt
    return Boolean(tokens.refreshToken)
      && (tokens.refreshTokenExpiresAt === undefined || Date.now() < tokens.refreshTokenExpiresAt)
  }

  private storeTokens(tokens: GitHubTokens): void {
    this.storage.setItem(this.tokensKey, JSON.stringify(tokens))
  }

  private async requestTokens(body: TokenRequest): Promise<GitHubTokens> {
    let response: Response
    try {
      response = await fetch(this.options.tokenUrl, {
        method: 'POST',
        // The session cookie must travel with the request, also when tokenUrl is on another origin.
        credentials: this.cookieSession ? 'include' : 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw new GitHubAuthError('token_exchange_failed', `Token endpoint unreachable: ${(error as Error).message}`)
    }

    const data = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & {
      error?: string
      error_description?: string
    }
    if (!response.ok || !data.access_token) {
      throw new GitHubAuthError(
        data.error ?? 'token_exchange_failed',
        data.error_description ?? `Token exchange failed (${response.status})`,
      )
    }
    return toTokens(data as TokenResponse)
  }

  private cleanUrl(url: URL): void {
    for (const key of ['code', 'state', 'error', 'error_description', 'error_uri']) {
      url.searchParams.delete(key)
    }
    try {
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
    } catch {
      // Not in a browser (tests, workers): nothing to clean.
    }
  }
}

export function createGitHubAuth(options: GitHubAuthOptions): GitHubAuth {
  return new GitHubAuth(options)
}
