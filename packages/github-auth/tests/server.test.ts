// Browser-like environments strip the Origin header from Request objects; the handler runs server-side.
// @vitest-environment node
import { createTokenHandler, parseTokenRequest } from '../src/server'

const ORIGIN = 'https://docs.example.com'

function setup(githubResponse: unknown = { access_token: 'ghu_token', token_type: 'bearer', scope: '' }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const handler = createTokenHandler({
    clientId: 'Iv1.client',
    clientSecret: 'shh',
    allowedOrigins: [ORIGIN],
    fetch: async (url, init) => {
      calls.push({ url: url as string, body: JSON.parse(init?.body as string) })
      return new Response(JSON.stringify(githubResponse), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  return { handler, calls }
}

function post(body: unknown, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (origin) headers.Origin = origin
  return new Request('https://docs.example.com/api/github/token', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const exchange = { grant_type: 'authorization_code', code: 'abc', code_verifier: 'v'.repeat(43) }

describe('createTokenHandler', () => {
  it('adds the client credentials and passes on only token fields', async () => {
    const { handler, calls } = setup({
      access_token: 'ghu_token',
      token_type: 'bearer',
      scope: '',
      expires_in: 28800,
      refresh_token: 'ghr_refresh',
      refresh_token_expires_in: 15897600,
      unexpected: 'dropped',
    })
    const response = await handler(post({ ...exchange, redirect_uri: `${ORIGIN}/admin`, extra: 'ignored' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      access_token: 'ghu_token',
      token_type: 'bearer',
      scope: '',
      expires_in: 28800,
      refresh_token: 'ghr_refresh',
      refresh_token_expires_in: 15897600,
    })
    expect(calls).toEqual([
      {
        url: 'https://github.com/login/oauth/access_token',
        body: { ...exchange, redirect_uri: `${ORIGIN}/admin`, client_id: 'Iv1.client', client_secret: 'shh' },
      },
    ])
  })

  it('refreshes tokens', async () => {
    const { handler, calls } = setup()
    const response = await handler(post({ grant_type: 'refresh_token', refresh_token: 'ghr_refresh' }))
    expect(response.status).toBe(200)
    expect(calls[0].body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'ghr_refresh',
      client_id: 'Iv1.client',
      client_secret: 'shh',
    })
  })

  it('rejects other origins and requests without one', async () => {
    const { handler, calls } = setup()
    expect((await handler(post(exchange, 'https://evil.example'))).status).toBe(403)
    expect((await handler(post(exchange, null))).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('answers CORS preflights', async () => {
    const { handler } = setup()
    const response = await handler(
      new Request('https://docs.example.com/api/github/token', { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS')
  })

  it('requires PKCE', async () => {
    const { handler, calls } = setup()
    const response = await handler(post({ grant_type: 'authorization_code', code: 'abc' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
    expect(calls).toHaveLength(0)
  })

  it('turns GitHub OAuth errors into 400 responses', async () => {
    const { handler } = setup({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' })
    const response = await handler(post(exchange))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'bad_verification_code',
      error_description: 'The code passed is incorrect or expired.',
    })
  })

  it('reports GitHub being unreachable', async () => {
    const handler = createTokenHandler({
      clientId: 'id',
      clientSecret: 'secret',
      allowedOrigins: (origin) => origin.endsWith('.example.com'),
      fetch: async () => {
        throw new TypeError('network down')
      },
    })
    expect((await handler(post(exchange))).status).toBe(502)
  })

  it('rejects other methods', async () => {
    const { handler } = setup()
    const response = await handler(new Request('https://docs.example.com/api/github/token', { headers: { Origin: ORIGIN } }))
    expect(response.status).toBe(405)
  })
})

describe('parseTokenRequest', () => {
  it('accepts only known grants with string fields', () => {
    expect(parseTokenRequest(null)).toBeNull()
    expect(parseTokenRequest({ grant_type: 'client_credentials' })).toBeNull()
    expect(parseTokenRequest({ ...exchange, code: 42 })).toBeNull()
    expect(parseTokenRequest({ grant_type: 'refresh_token', refresh_token: '' })).toBeNull()
    expect(parseTokenRequest(exchange)).toEqual({ ...exchange, redirect_uri: undefined })
  })
})
