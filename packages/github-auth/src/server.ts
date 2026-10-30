import type { TokenRequest, TokenResponse } from './protocol.js'

export type { TokenRequest, TokenResponse }

export interface TokenHandlerOptions {
  clientId: string
  /** The app's client secret. Keep it in a secret store (e.g. `wrangler secret put`), never in code. */
  clientSecret: string
  /**
   * Origins allowed to call the handler, e.g. `['https://docs.example.com']`. Requests from any
   * other origin, or without an `Origin` header, are rejected. Use a function for patterns.
   */
  allowedOrigins: string[] | ((origin: string) => boolean)
  /** GitHub Enterprise Server: the web URL. Default: https://github.com */
  githubUrl?: string
  /** For tests. Default: the global `fetch`. */
  fetch?: typeof fetch
}

const RESPONSE_FIELDS = [
  'access_token',
  'token_type',
  'scope',
  'expires_in',
  'refresh_token',
  'refresh_token_expires_in',
] as const

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < 2048
}

/** Validate the browser's request; only the fields GitHub needs are passed on. */
export function parseTokenRequest(body: unknown): TokenRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const value = body as Record<string, unknown>
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
  if (value.grant_type === 'refresh_token' && isString(value.refresh_token)) {
    return { grant_type: 'refresh_token', refresh_token: value.refresh_token }
  }
  return null
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
    : (origin: string) => (options.allowedOrigins as string[]).includes(origin)
  const doFetch = options.fetch ?? fetch

  return async (request) => {
    const origin = request.headers.get('Origin')
    if (!origin || !isAllowed(origin)) {
      return json({ error: 'origin_not_allowed', error_description: 'This origin may not use the token endpoint' }, 403)
    }
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed', error_description: 'Use POST' }, 405, { ...cors, Allow: 'POST, OPTIONS' })
    }

    const tokenRequest = parseTokenRequest(await request.json().catch(() => null))
    if (!tokenRequest) {
      return json({ error: 'invalid_request', error_description: 'Expected a code and code_verifier, or a refresh_token' }, 400, cors)
    }

    let upstream: Response
    try {
      upstream = await doFetch(`${githubUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...tokenRequest, client_id: options.clientId, client_secret: options.clientSecret }),
      })
    } catch {
      return json({ error: 'github_unreachable', error_description: 'Could not reach GitHub' }, 502, cors)
    }

    const data = (await upstream.json().catch(() => null)) as Record<string, unknown> | null
    // GitHub reports OAuth errors (bad code, expired refresh token, ...) with a 200 status.
    if (!upstream.ok || !data || typeof data.access_token !== 'string') {
      return json(
        {
          error: typeof data?.error === 'string' ? data.error : 'token_exchange_failed',
          error_description: typeof data?.error_description === 'string'
            ? data.error_description
            : `GitHub responded with ${upstream.status}`,
        },
        400,
        cors,
      )
    }

    const body: Partial<TokenResponse> = {}
    for (const field of RESPONSE_FIELDS) {
      if (data[field] !== undefined) (body as Record<string, unknown>)[field] = data[field]
    }
    return json(body, 200, cors)
  }
}
