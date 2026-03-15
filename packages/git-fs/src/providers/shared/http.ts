import { AuthError, NetworkError, RateLimitError, NotFoundError, GitFSError } from '../../types/errors.js'

export type TokenProvider = string | (() => string | Promise<string>)

export interface HttpOptions {
  token: TokenProvider
  baseUrl: string
}

async function resolveToken(token: TokenProvider): Promise<string> {
  return typeof token === 'function' ? token() : token
}

export function createFetchREST(options: HttpOptions) {
  return async function fetchREST(
    path: string,
    init: RequestInit & { raw?: boolean } = {},
  ): Promise<unknown> {
    const url = path.startsWith('http') ? path : `${options.baseUrl}${path}`
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await resolveToken(options.token)}`)
    if (!headers.has('Accept')) {
      headers.set('Accept', init.raw ? 'application/vnd.github.raw' : 'application/json')
    }
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    let response: Response
    try {
      response = await fetch(url, { ...init, headers })
    } catch (err) {
      throw new NetworkError(`Fetch failed: ${(err as Error).message}`)
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`Authentication failed: ${response.status}`)
    }

    if (response.status === 404) {
      throw new NotFoundError(`Not found: ${path}`)
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After') || '60')
      throw new RateLimitError('Rate limit exceeded', retryAfter)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GitFSError(`HTTP ${response.status}: ${text}`, 'HTTP_ERROR')
    }

    if (init.raw) {
      return new Uint8Array(await response.arrayBuffer())
    }

    return response.json()
  }
}
