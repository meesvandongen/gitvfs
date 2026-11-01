import { deleteCookie, getSealedCookie, setSealedCookie } from 'kukkii'
import type { SignOutRequest, TokenRequest, TokenResponse } from './protocol.js'

export type { SignOutRequest, TokenRequest, TokenResponse }

/**
 * Match origins against patterns such as `https://docs.example.com` or `https://*.docs.example.com`.
 * `*` stands for exactly one subdomain label, so `https://*.example.com` matches
 * `https://preview.example.com` but neither `https://example.com` nor `https://a.b.example.com`.
 * Scheme and port must match exactly.
 */
export function originMatcher(patterns: string[]): (origin: string) => boolean {
  const regexes = patterns
    .map((pattern) => pattern.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .map((pattern) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')
      return new RegExp(`^${escaped}$`, 'i')
    })
  return (origin) => regexes.some((regex) => regex.test(origin))
}

export interface SessionOptions {
  /**
   * Password that seals the session cookie (iron: AES-256-CBC plus HMAC-SHA256, via kukkii). At
   * least 32 characters of randomness, e.g. `openssl rand -base64 32`. Keep it in a secret store.
   */
  secret: string
  /** Default: `gitvfs_github_session` */
  cookieName?: string
  /** Path the cookie is sent to; use the path the handler is served under. Default: `/` */
  path?: string
  /** Default: true. Browsers accept secure cookies on http://localhost too. */
  secure?: boolean
  /**
   * Session lifetime in seconds when GitHub does not say how long the refresh token lives, e.g. for
   * OAuth Apps without expiring tokens. Default: 30 days.
   */
  maxAge?: number
}

export interface TokenHandlerOptions {
  clientId: string
  /** The app's client secret. Keep it in a secret store (e.g. `wrangler secret put`), never in code. */
  clientSecret: string
  /**
   * Origins allowed to call the handler, e.g. `['https://docs.example.com', 'https://*.docs.example.com']`
   * (see `originMatcher`). Requests from any other origin, or without an `Origin` header, are
   * rejected. A function gets the last word.
   */
  allowedOrigins: string[] | ((origin: string) => boolean)
  /**
   * Keep the refresh token out of the browser: it lives in an encrypted, `HttpOnly`,
   * `SameSite=Strict` cookie, and only short-lived access tokens reach JavaScript. Pair with
   * `session: 'cookie'` in `createGitHubAuth`.
   */
  session?: SessionOptions
  /** GitHub Enterprise Server: the web URL. Default: https://github.com */
  githubUrl?: string
  /** For tests. Default: the global `fetch`. */
  fetch?: typeof fetch
}

/** What the sealed cookie holds. `rt` for expiring tokens; `at` when GitHub issues no refresh token. */
interface SessionPayload {
  v: 1
  rt?: string
  at?: string
  scope?: string
  /** Epoch milliseconds. Checked on every read: sealing alone has no expiry. */
  exp: number
}

const DEFAULT_SESSION_MAX_AGE = 30 * 24 * 60 * 60
const MIN_SECRET_LENGTH = 32

const RESPONSE_FIELDS = [
  'access_token',
  'token_type',
  'scope',
  'expires_in',
  'refresh_token',
  'refresh_token_expires_in',
] as const

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Content-Type', 'application/json')
  responseHeaders.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < 2048
}

/** Validate the browser's request; only the fields GitHub needs are passed on. */
export function parseTokenRequest(body: unknown): TokenRequest | SignOutRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const value = body as Record<string, unknown>
  if (value.action === 'sign_out') return { action: 'sign_out' }
  if (value.grant_type === 'authorization_code') {
    // Require PKCE: without a verifier, a stolen code alone would be enough to get a token.
    if (!isString(value.code) || !isString(value.code_verifier)) return null
    if (value.redirect_uri !== undefined && !isString(value.redirect_uri)) return null
    return {
      grant_type: 'authorization_code',
      code: value.code,
      code_verifier: value.code_verifier,
      redirect_uri: value.redirect_uri,
    }
  }
  if (value.grant_type === 'refresh_token') {
    if (value.refresh_token === undefined) return { grant_type: 'refresh_token' }
    if (isString(value.refresh_token)) return { grant_type: 'refresh_token', refresh_token: value.refresh_token }
  }
  return null
}

function sessionCookie(session: SessionOptions) {
  return {
    name: session.cookieName ?? 'gitvfs_github_session',
    options: {
      path: session.path ?? '/',
      secure: session.secure ?? true,
      httpOnly: true,
      sameSite: 'Strict' as const,
    },
  }
}

async function readSession(request: Request, session: SessionOptions): Promise<SessionPayload | null> {
  const { name } = sessionCookie(session)
  const value = await getSealedCookie(request.headers, session.secret, name)
  if (!value) return null
  try {
    const payload = JSON.parse(value) as SessionPayload
    if (payload.v !== 1 || typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null
    if (!isString(payload.rt) && !isString(payload.at)) return null
    return payload
  } catch {
    return null
  }
}

async function writeSession(headers: Headers, session: SessionOptions, payload: SessionPayload): Promise<void> {
  const { name, options } = sessionCookie(session)
  // Round up: the payload expiry is checked on every read, and rounding down would cut a second.
  const maxAge = Math.max(0, Math.ceil((payload.exp - Date.now()) / 1000))
  await setSealedCookie(headers, JSON.stringify(payload), session.secret, name, { ...options, maxAge })
}

function clearSession(headers: Headers, session: SessionOptions): void {
  const { name, options } = sessionCookie(session)
  deleteCookie(headers, name, options)
}

/**
 * A Fetch API handler that completes GitHub's token exchange for browser apps: it adds the client
 * secret, which must not ship to the browser, and the CORS headers GitHub does not send. It works
 * in Cloudflare Workers, Deno, Bun and Node 18+.
 *
 * ```ts
 * const handleToken = createTokenHandler({ clientId, clientSecret, allowedOrigins: ['https://example.com'] })
 * export default { fetch: (request, env) => handleToken(request) }
 * ```
 */
export function createTokenHandler(options: TokenHandlerOptions): (request: Request) => Promise<Response> {
  const githubUrl = (options.githubUrl ?? 'https://github.com').replace(/\/$/, '')
  const isAllowed = typeof options.allowedOrigins === 'function'
    ? options.allowedOrigins
    : originMatcher(options.allowedOrigins)
  const doFetch = options.fetch ?? fetch
  const session = options.session
  if (session && session.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`The session secret must be at least ${MIN_SECRET_LENGTH} characters`)
  }

  return async (request) => {
    const origin = request.headers.get('Origin')
    if (!origin || !isAllowed(origin)) {
      return json({ error: 'origin_not_allowed', error_description: 'This origin may not use the token endpoint' }, 403)
    }
    const headers = new Headers({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    })
    if (session) headers.set('Access-Control-Allow-Credentials', 'true')

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') {
      headers.set('Allow', 'POST, OPTIONS')
      return json({ error: 'method_not_allowed', error_description: 'Use POST' }, 405, headers)
    }

    const parsed = parseTokenRequest(await request.json().catch(() => null))
    if (parsed && 'action' in parsed) {
      if (session) clearSession(headers, session)
      return new Response(null, { status: 204, headers })
    }

    let tokenRequest = parsed
    let stored: SessionPayload | null = null
    if (tokenRequest?.grant_type === 'refresh_token' && session) {
      // Refresh tokens never come from the browser in session mode; only the sealed cookie counts.
      stored = await readSession(request, session)
      if (!stored) {
        clearSession(headers, session)
        return json({ error: 'no_session', error_description: 'No valid session; sign in again' }, 401, headers)
      }
      if (!stored.rt) {
        // Non-expiring token (no refresh token issued): the cookie holds the access token itself.
        const body: TokenResponse = {
          access_token: stored.at!,
          token_type: 'bearer',
          scope: stored.scope ?? '',
          session_expires_in: Math.floor((stored.exp - Date.now()) / 1000),
        }
        return json(body, 200, headers)
      }
      tokenRequest = { grant_type: 'refresh_token', refresh_token: stored.rt }
    }
    if (!tokenRequest || (tokenRequest.grant_type === 'refresh_token' && !tokenRequest.refresh_token)) {
      return json({ error: 'invalid_request', error_description: 'Expected a code and code_verifier, or a refresh_token' }, 400, headers)
    }

    let upstream: Response
    try {
      upstream = await doFetch(`${githubUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...tokenRequest, client_id: options.clientId, client_secret: options.clientSecret }),
      })
    } catch {
      return json({ error: 'github_unreachable', error_description: 'Could not reach GitHub' }, 502, headers)
    }

    const data = (await upstream.json().catch(() => null)) as Record<string, unknown> | null
    // GitHub reports OAuth errors (bad code, expired refresh token, ...) with a 200 status.
    if (!upstream.ok || !data || typeof data.access_token !== 'string') {
      // A rejected refresh token will not work next time either.
      if (session && stored && upstream.ok) clearSession(headers, session)
      return json(
        {
          error: typeof data?.error === 'string' ? data.error : 'token_exchange_failed',
          error_description: typeof data?.error_description === 'string'
            ? data.error_description
            : `GitHub responded with ${upstream.status}`,
        },
        400,
        headers,
      )
    }

    const body: Partial<TokenResponse> = {}
    for (const field of RESPONSE_FIELDS) {
      if (data[field] !== undefined) (body as Record<string, unknown>)[field] = data[field]
    }

    if (session) {
      const lifetime = typeof data.refresh_token_expires_in === 'number'
        ? data.refresh_token_expires_in
        : session.maxAge ?? DEFAULT_SESSION_MAX_AGE
      const payload: SessionPayload = typeof data.refresh_token === 'string'
        ? { v: 1, rt: data.refresh_token, exp: Date.now() + lifetime * 1000 }
        : { v: 1, at: data.access_token, scope: typeof data.scope === 'string' ? data.scope : '', exp: Date.now() + lifetime * 1000 }
      await writeSession(headers, session, payload)
      delete body.refresh_token
      delete body.refresh_token_expires_in
      body.session_expires_in = lifetime
    }
    return json(body, 200, headers)
  }
}
