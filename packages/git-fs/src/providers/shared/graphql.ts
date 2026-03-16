import { AuthError, NetworkError, RateLimitError, GitFSError } from '../../types/errors.js'
import type { TokenProvider } from './http.js'

export interface GraphQLOptions {
  token: TokenProvider
  url: string
}

export function createFetchGraphQL(options: GraphQLOptions) {
  return async function fetchGraphQL<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const token = typeof options.token === 'function' ? await options.token() : options.token
    let response: Response
    try {
      response = await fetch(options.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      })
    } catch (err) {
      throw new NetworkError(`GraphQL fetch failed: ${(err as Error).message}`)
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`Authentication failed: ${response.status}`)
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After') || '60')
      throw new RateLimitError('Rate limit exceeded', retryAfter)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GitFSError(`GraphQL HTTP ${response.status}: ${text}`, 'HTTP_ERROR')
    }

    const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> }

    if (json.errors?.length) {
      const msg = json.errors.map((e) => e.message).join('; ')
      throw new GitFSError(`GraphQL error: ${msg}`, 'GRAPHQL_ERROR')
    }

    return json.data as T
  }
}
