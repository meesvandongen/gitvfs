import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createFetchGraphQL } from '../../src/providers/shared/graphql'
import { AuthError, RateLimitError, NetworkError, GitFSError } from '../../src/types/errors'

const GQL_URL = 'https://api.test.com/graphql'

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('createFetchGraphQL', () => {
  const fetchGraphQL = createFetchGraphQL({ token: 'test-token', url: GQL_URL })

  it('sends Bearer token in Authorization header', async () => {
    let authHeader: string | null = null
    server.use(
      http.post(GQL_URL, ({ request }) => {
        authHeader = request.headers.get('Authorization')
        return HttpResponse.json({ data: { result: 'ok' } })
      }),
    )

    await fetchGraphQL('query { result }')
    expect(authHeader).toBe('Bearer test-token')
  })

  it('sends Content-Type application/json', async () => {
    let contentType: string | null = null
    server.use(
      http.post(GQL_URL, ({ request }) => {
        contentType = request.headers.get('Content-Type')
        return HttpResponse.json({ data: { result: 'ok' } })
      }),
    )

    await fetchGraphQL('query { result }')
    expect(contentType).toBe('application/json')
  })

  it('sends query and variables in body', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.post(GQL_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ data: { result: 'ok' } })
      }),
    )

    await fetchGraphQL('query($id: ID!) { node(id: $id) { id } }', { id: '123' })
    expect(body!.query).toContain('query($id: ID!)')
    expect(body!.variables).toEqual({ id: '123' })
  })

  it('returns data field from response', async () => {
    server.use(
      http.post(GQL_URL, () =>
        HttpResponse.json({ data: { user: { name: 'Alice' } } }),
      ),
    )

    const data = (await fetchGraphQL('query { user { name } }')) as { user: { name: string } }
    expect(data.user.name).toBe('Alice')
  })

  it('throws GitFSError on GraphQL errors', async () => {
    server.use(
      http.post(GQL_URL, () =>
        HttpResponse.json({
          errors: [
            { message: 'Field not found' },
            { message: 'Invalid type' },
          ],
        }),
      ),
    )

    const err = await fetchGraphQL('query { bad }').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitFSError)
    expect((err as GitFSError).message).toContain('Field not found')
    expect((err as GitFSError).message).toContain('Invalid type')
    expect((err as GitFSError).code).toBe('GRAPHQL_ERROR')
  })

  it('throws AuthError on 401', async () => {
    server.use(
      http.post(GQL_URL, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    )

    await expect(fetchGraphQL('query { test }')).rejects.toThrow(AuthError)
  })

  it('throws AuthError on 403', async () => {
    server.use(
      http.post(GQL_URL, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    )

    await expect(fetchGraphQL('query { test }')).rejects.toThrow(AuthError)
  })

  it('throws RateLimitError on 429', async () => {
    server.use(
      http.post(GQL_URL, () =>
        HttpResponse.json(
          { message: 'Rate limit' },
          { status: 429, headers: { 'Retry-After': '90' } },
        ),
      ),
    )

    const err = await fetchGraphQL('query { test }').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retryAfter).toBe(90)
  })

  it('throws GitFSError on other HTTP errors', async () => {
    server.use(
      http.post(GQL_URL, () =>
        HttpResponse.text('Bad Gateway', { status: 502 }),
      ),
    )

    const err = await fetchGraphQL('query { test }').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitFSError)
    expect((err as GitFSError).code).toBe('HTTP_ERROR')
  })

  it('throws NetworkError when fetch fails', async () => {
    server.use(
      http.post(GQL_URL, () => HttpResponse.error()),
    )

    await expect(fetchGraphQL('query { test }')).rejects.toThrow(NetworkError)
  })
})
