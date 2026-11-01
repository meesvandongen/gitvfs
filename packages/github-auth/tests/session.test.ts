// Browser-like environments strip the Origin and Cookie headers from Request objects; the handler runs server-side.
// @vitest-environment node
import { createTokenHandler } from '../src/server'

const ORIGIN = 'https://docs.example.com'
const SECRET = 'a-very-long-session-secret-for-tests-0123456789'

function setup(responses: unknown[]) {
  const calls: Array<Record<string, unknown>> = []
  const handler = createTokenHandler({
    clientId: 'Iv1.client',
    clientSecret: 'shh',
    allowedOrigins: [ORIGIN],
    session: { secret: SECRET, path: '/api/github' },
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init?.body as string))
      return new Response(JSON.stringify(responses.shift()))
    },
  })
  return { handler, calls }
}

function post(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: ORIGIN }
  if (cookie) headers.Cookie = cookie
  return new Request(`${ORIGIN}/api/github/token`, { method: 'POST', headers, body: JSON.stringify(body) })
}

/** The cookie pair (name=value) from a response, as a browser would send it back. */
function cookieFrom(response: Response): string {
  const header = response.headers.get('Set-Cookie') ?? ''
  return header.split(';')[0]
}

const exchange = { grant_type: 'authorization_code', code: 'abc', code_verifier: 'v'.repeat(43) }
const githubTokens = (n: number) => ({
  access_token: `ghu_${n}`,
  token_type: 'bearer',
  scope: '',
  expires_in: 28800,
  refresh_token: `ghr_${n}`,
  refresh_token_expires_in: 15897600,
})

describe('cookie sessions', () => {
  it('keeps the refresh token in a sealed HttpOnly cookie, never in the response', async () => {
    const { handler } = setup([githubTokens(1)])
    const response = await handler(post(exchange))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ access_token: 'ghu_1', token_type: 'bearer', scope: '', expires_in: 28800, session_expires_in: 15897600 })

    const header = response.headers.get('Set-Cookie')!
    expect(header).toMatch(/^gitvfs_github_session=/)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Strict')
    expect(header).toContain('Path=/api/github')
    expect(header).toContain('Max-Age=15897600')
    // Encrypted: neither token appears in the cookie.
    expect(decodeURIComponent(header)).not.toContain('ghr_1')
    expect(decodeURIComponent(header)).not.toContain('ghu_1')
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  it('refreshes with the token from the cookie and rotates the cookie', async () => {
    const { handler, calls } = setup([githubTokens(1), githubTokens(2)])
    const cookie = cookieFrom(await handler(post(exchange)))

    const response = await handler(post({ grant_type: 'refresh_token' }, cookie))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ access_token: 'ghu_2' })
    expect(calls[1]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_1', client_secret: 'shh' })
    expect(cookieFrom(response)).not.toBe(cookie)
  })

  it('ignores refresh tokens sent by the browser', async () => {
    const { handler, calls } = setup([])
    const response = await handler(post({ grant_type: 'refresh_token', refresh_token: 'ghr_stolen' }))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'no_session' })
    expect(calls).toHaveLength(0)
  })

  it('rejects tampered cookies and cookies sealed with another secret', async () => {
    const { handler } = setup([githubTokens(1)])
    const cookie = cookieFrom(await handler(post(exchange)))
    const tampered = cookie.slice(0, -4) + (cookie.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect((await handler(post({ grant_type: 'refresh_token' }, tampered))).status).toBe(401)

    const other = createTokenHandler({
      clientId: 'Iv1.client',
      clientSecret: 'shh',
      allowedOrigins: [ORIGIN],
      session: { secret: 'another-session-secret-that-is-long-enough', path: '/api/github' },
      fetch: async () => new Response('{}'),
    })
    expect((await other(post({ grant_type: 'refresh_token' }, cookie))).status).toBe(401)
  })

  it('treats an expired session as signed out', async () => {
    const { handler } = setup([{ ...githubTokens(1), refresh_token_expires_in: 60 }])
    const cookie = cookieFrom(await handler(post(exchange)))
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    try {
      expect((await handler(post({ grant_type: 'refresh_token' }, cookie))).status).toBe(401)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('clears the cookie when GitHub rejects the refresh token', async () => {
    const { handler } = setup([githubTokens(1), { error: 'bad_refresh_token', error_description: 'revoked' }])
    const cookie = cookieFrom(await handler(post(exchange)))
    const response = await handler(post({ grant_type: 'refresh_token' }, cookie))
    expect(response.status).toBe(400)
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })

  it('stores non-expiring access tokens (OAuth Apps) in the cookie instead', async () => {
    const { handler, calls } = setup([{ access_token: 'gho_1', token_type: 'bearer', scope: 'public_repo' }])
    const first = await handler(post(exchange))
    expect(await first.json()).toEqual({ access_token: 'gho_1', token_type: 'bearer', scope: 'public_repo', session_expires_in: 2592000 })

    const restored = await handler(post({ grant_type: 'refresh_token' }, cookieFrom(first)))
    expect(await restored.json()).toMatchObject({ access_token: 'gho_1', scope: 'public_repo' })
    expect(calls).toHaveLength(1)
  })

  it('signs out by clearing the cookie', async () => {
    const { handler } = setup([])
    const response = await handler(post({ action: 'sign_out' }))
    expect(response.status).toBe(204)
    expect(response.headers.get('Set-Cookie')).toMatch(/^gitvfs_github_session=; Max-Age=0; Path=\/api\/github/)
  })

  it('requires a long secret', () => {
    expect(() =>
      createTokenHandler({ clientId: 'id', clientSecret: 's', allowedOrigins: [ORIGIN], session: { secret: 'short' } }),
    ).toThrow(/at least 32/)
  })
})
