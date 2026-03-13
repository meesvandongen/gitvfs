import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createFetchREST } from '../../src/providers/shared/http'
import { AuthError, NotFoundError, RateLimitError, NetworkError, GitFSError } from '../../src/types/errors'

const BASE = 'https://api.test.com'

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('createFetchREST', () => {
  const fetchREST = createFetchREST({ token: 'test-token', baseUrl: BASE })

  it('sends Bearer token in Authorization header', async () => {
    let authHeader: string | null = null
    server.use(
      http.get(`${BASE}/test`, ({ request }) => {
        authHeader = request.headers.get('Authorization')
        return HttpResponse.json({ ok: true })
      }),
    )

    await fetchREST('/test')
    expect(authHeader).toBe('Bearer test-token')
  })

  it('sets JSON Accept header by default', async () => {
    let acceptHeader: string | null = null
    server.use(
      http.get(`${BASE}/test`, ({ request }) => {
        acceptHeader = request.headers.get('Accept')
        return HttpResponse.json({ ok: true })
      }),
    )

    await fetchREST('/test')
    expect(acceptHeader).toBe('application/json')
  })

  it('sets raw Accept header when raw option is true', async () => {
    let acceptHeader: string | null = null
    server.use(
      http.get(`${BASE}/test`, ({ request }) => {
        acceptHeader = request.headers.get('Accept')
        return new HttpResponse(new Uint8Array([1, 2, 3]), { status: 200 })
      }),
    )

    const result = await fetchREST('/test', { raw: true })
    expect(acceptHeader).toBe('application/vnd.github.raw')
    expect(result).toBeInstanceOf(Uint8Array)
  })

  it('sets Content-Type when body is provided', async () => {
    let contentType: string | null = null
    server.use(
      http.post(`${BASE}/test`, ({ request }) => {
        contentType = request.headers.get('Content-Type')
        return HttpResponse.json({ ok: true })
      }),
    )

    await fetchREST('/test', { method: 'POST', body: JSON.stringify({ key: 'val' }) })
    expect(contentType).toBe('application/json')
  })

  it('parses JSON response', async () => {
    server.use(
      http.get(`${BASE}/data`, () => HttpResponse.json({ foo: 'bar' })),
    )

    const data = (await fetchREST('/data')) as { foo: string }
    expect(data.foo).toBe('bar')
  })

  it('handles absolute URLs', async () => {
    server.use(
      http.get('https://other.api.com/resource', () => HttpResponse.json({ ok: true })),
    )

    const data = (await fetchREST('https://other.api.com/resource')) as { ok: boolean }
    expect(data.ok).toBe(true)
  })

  it('returns undefined for 204 No Content', async () => {
    server.use(
      http.delete(`${BASE}/resource`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
    )

    const result = await fetchREST('/resource', { method: 'DELETE' })
    expect(result).toBeUndefined()
  })

  it('throws AuthError on 401', async () => {
    server.use(
      http.get(`${BASE}/auth`, () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    )

    await expect(fetchREST('/auth')).rejects.toThrow(AuthError)
  })

  it('throws AuthError on 403', async () => {
    server.use(
      http.get(`${BASE}/forbidden`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    )

    await expect(fetchREST('/forbidden')).rejects.toThrow(AuthError)
  })

  it('throws NotFoundError on 404', async () => {
    server.use(
      http.get(`${BASE}/missing`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    )

    await expect(fetchREST('/missing')).rejects.toThrow(NotFoundError)
  })

  it('throws RateLimitError on 429 with Retry-After', async () => {
    server.use(
      http.get(`${BASE}/limited`, () =>
        HttpResponse.json(
          { message: 'Rate limit' },
          { status: 429, headers: { 'Retry-After': '120' } },
        ),
      ),
    )

    const err = await fetchREST('/limited').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retryAfter).toBe(120)
  })

  it('defaults Retry-After to 60 when header is missing', async () => {
    server.use(
      http.get(`${BASE}/limited2`, () =>
        HttpResponse.json({ message: 'Rate limit' }, { status: 429 }),
      ),
    )

    const err = await fetchREST('/limited2').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retryAfter).toBe(60)
  })

  it('throws GitFSError on 500', async () => {
    server.use(
      http.get(`${BASE}/error`, () =>
        HttpResponse.text('Server Error', { status: 500 }),
      ),
    )

    const err = await fetchREST('/error').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitFSError)
    expect((err as GitFSError).code).toBe('HTTP_ERROR')
  })

  it('throws NetworkError when fetch itself fails', async () => {
    server.use(
      http.get(`${BASE}/network`, () => HttpResponse.error()),
    )

    await expect(fetchREST('/network')).rejects.toThrow(NetworkError)
  })
})
