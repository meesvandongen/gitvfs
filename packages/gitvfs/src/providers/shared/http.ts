import { AuthError, NetworkError, RateLimitError, NotFoundError, GitFSError } from '../../types/errors.js'

export type TokenProvider = string | (() => string | Promise<string>)

export interface HttpOptions {
  token: TokenProvider
  baseUrl: string
}

async function resolveToken(token: TokenProvider): Promise<string> {
  return typeof token === 'function' ? token() : token
}

type RequestOptions = RequestInit & { raw?: boolean }

/** Authenticated request with the library's error mapping; resolves to the successful response. */
async function request(options: HttpOptions, path: string, init: RequestOptions = {}): Promise<Response> {
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
    if ((err as Error).name === 'AbortError') throw err
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

  return response
}

export function createFetchREST(options: HttpOptions) {
  return async function fetchREST(path: string, init: RequestOptions = {}): Promise<unknown> {
    const response = await request(options, path, init)
    if (init.raw) {
      return new Uint8Array(await response.arrayBuffer())
    }
    return response.json()
  }
}

/** The next page's URL: the `Link: <...>; rel="next"` header (GitHub, GitLab), else GitLab's `X-Next-Page`. */
export function nextPageUrl(response: Response, currentUrl: string): string | null {
  const link = response.headers.get('Link')
  if (link) {
    for (const part of link.split(',')) {
      const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/)
      if (match) return match[1]
    }
    return null
  }
  const nextPage = response.headers.get('X-Next-Page')
  if (nextPage) {
    const url = new URL(currentUrl)
    url.searchParams.set('page', nextPage)
    return url.toString()
  }
  return null
}

/** Yields each page of a paginated list endpoint, following the host's next-page links. */
export function createPaginate(options: HttpOptions) {
  return async function* paginate<T>(path: string, init: RequestInit = {}): AsyncGenerator<T[]> {
    let url: string | null = path.startsWith('http') ? path : `${options.baseUrl}${path}`
    while (url) {
      const response = await request(options, url, init)
      yield (await response.json()) as T[]
      url = nextPageUrl(response, url)
    }
  }
}
