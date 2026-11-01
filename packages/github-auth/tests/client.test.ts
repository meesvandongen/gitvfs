import { GitHubAuthError, createGitHubAuth, toTokens } from '../src/client'
import { codeChallenge } from '../src/pkce'

const tokenUrl = 'https://docs.example.com/api/github/token'

function mockTokenEndpoint(responses: Array<{ status?: number; body: unknown }>) {
  const requests: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(tokenUrl)
    requests.push(JSON.parse(init?.body as string))
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
  }))
  return requests
}

function createAuth() {
  return createGitHubAuth({
    clientId: 'Iv1.client',
    tokenUrl,
    redirectUri: 'https://docs.example.com/admin',
    storage: 'memory',
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sessionStorage.clear()
})

async function signIn(auth = createAuth(), tokenResponse: unknown = { access_token: 'ghu_1', token_type: 'bearer', scope: '' }) {
  const authorizeUrl = new URL(await auth.createAuthorizeUrl({ returnTo: '/admin?tab=posts' }))
  const requests = mockTokenEndpoint([{ body: tokenResponse }])
  const result = await auth.handleRedirect(
    `https://docs.example.com/admin?code=the-code&state=${authorizeUrl.searchParams.get('state')}`,
  )
  return { auth, authorizeUrl, requests, result }
}

describe('GitHubAuth', () => {
  it('builds a PKCE authorize URL', async () => {
    const auth = createGitHubAuth({ clientId: 'Iv1.client', tokenUrl, redirectUri: 'https://docs.example.com/admin', scope: 'repo' })
    const url = new URL(await auth.createAuthorizeUrl())
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'Iv1.client',
      redirect_uri: 'https://docs.example.com/admin',
      code_challenge_method: 'S256',
      scope: 'repo',
    })
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('state')).toBeTruthy()
  })

  it('exchanges the code with the matching verifier', async () => {
    const { auth, authorizeUrl, requests, result } = await signIn()
    expect(result).toEqual({ returnTo: '/admin?tab=posts' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://docs.example.com/admin',
    })
    expect(await codeChallenge(String(requests[0].code_verifier))).toBe(authorizeUrl.searchParams.get('code_challenge'))
    expect(auth.isSignedIn()).toBe(true)
    expect(await auth.token()).toBe('ghu_1')
  })

  it('ignores URLs without a sign-in response', async () => {
    expect(await createAuth().handleRedirect('https://docs.example.com/admin?tab=x')).toBeNull()
  })

  it('rejects a response whose state was not issued here', async () => {
    const auth = createAuth()
    await auth.createAuthorizeUrl()
    await expect(auth.handleRedirect('https://docs.example.com/admin?code=c&state=forged')).rejects.toMatchObject({
      code: 'state_mismatch',
    })
    expect(auth.isSignedIn()).toBe(false)
  })

  it('reports errors GitHub sends back', async () => {
    const auth = createAuth()
    await auth.createAuthorizeUrl()
    await expect(
      auth.handleRedirect('https://docs.example.com/admin?error=access_denied&error_description=The+user+denied&state=s'),
    ).rejects.toMatchObject({ code: 'access_denied', message: 'The user denied' })
  })

  it('reports failed exchanges with the error from the token endpoint', async () => {
    const auth = createAuth()
    const state = new URL(await auth.createAuthorizeUrl()).searchParams.get('state')
    mockTokenEndpoint([{ status: 400, body: { error: 'bad_verification_code', error_description: 'expired' } }])
    const attempt = auth.handleRedirect(`https://docs.example.com/admin?code=c&state=${state}`)
    await expect(attempt).rejects.toBeInstanceOf(GitHubAuthError)
    await expect(attempt).rejects.toMatchObject({ code: 'bad_verification_code', message: 'expired' })
  })

  it('throws when signed out', async () => {
    await expect(createAuth().token()).rejects.toMatchObject({ code: 'not_signed_in' })
  })

  it('refreshes expired tokens once for concurrent callers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { auth } = await signIn(createAuth(), {
      access_token: 'ghu_1',
      expires_in: 28800,
      refresh_token: 'ghr_1',
      refresh_token_expires_in: 15897600,
    })

    vi.setSystemTime(new Date('2026-01-01T08:00:00Z'))
    const requests = mockTokenEndpoint([
      { body: { access_token: 'ghu_2', expires_in: 28800, refresh_token: 'ghr_2', refresh_token_expires_in: 15897600 } },
    ])
    expect(await Promise.all([auth.token(), auth.token()])).toEqual(['ghu_2', 'ghu_2'])
    expect(requests).toEqual([{ grant_type: 'refresh_token', refresh_token: 'ghr_1' }])
    expect(auth.getTokens()?.refreshToken).toBe('ghr_2')
  })

  it('signs out when the refresh token has expired too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { auth } = await signIn(createAuth(), {
      access_token: 'ghu_1',
      expires_in: 60,
      refresh_token: 'ghr_1',
      refresh_token_expires_in: 120,
    })
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
    expect(auth.isSignedIn()).toBe(false)
    await expect(auth.token()).rejects.toMatchObject({ code: 'session_expired' })
    expect(auth.getTokens()).toBeNull()
  })

  it('signs out when a refresh is rejected', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { auth } = await signIn(createAuth(), { access_token: 'ghu_1', expires_in: 60, refresh_token: 'ghr_1' })
    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'))
    mockTokenEndpoint([{ status: 400, body: { error: 'bad_refresh_token', error_description: 'revoked' } }])
    await expect(auth.token()).rejects.toMatchObject({ code: 'bad_refresh_token' })
    expect(auth.getTokens()).toBeNull()
  })

  it('keeps the verifier across the redirect even with memory token storage', async () => {
    const first = createAuth()
    const state = new URL(await first.createAuthorizeUrl()).searchParams.get('state')
    // A new page load: a new instance with fresh memory storage.
    const second = createAuth()
    mockTokenEndpoint([{ body: { access_token: 'ghu_1' } }])
    await second.handleRedirect(`https://docs.example.com/admin?code=c&state=${state}`)
    expect(await second.token()).toBe('ghu_1')
  })

  it('signs out', async () => {
    const { auth } = await signIn()
    await auth.signOut()
    expect(auth.isSignedIn()).toBe(false)
  })
})

describe('toTokens', () => {
  it('converts lifetimes to timestamps', () => {
    expect(toTokens({ access_token: 'a', expires_in: 10, refresh_token: 'r', refresh_token_expires_in: 20 }, 1000)).toEqual({
      accessToken: 'a',
      tokenType: 'bearer',
      scope: '',
      expiresAt: 11_000,
      refreshToken: 'r',
      refreshTokenExpiresAt: 21_000,
    })
  })
})

describe('GitHubAuth with cookie sessions', () => {
  function createCookieAuth() {
    return createGitHubAuth({ clientId: 'Iv1.client', tokenUrl, redirectUri: 'https://docs.example.com/admin', session: 'cookie' })
  }

  function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
    const calls: Array<{ body: Record<string, unknown>; credentials?: RequestCredentials }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string), credentials: init?.credentials })
      const next = responses.shift()
      if (!next) throw new Error('unexpected request')
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status ?? 200 })
    }))
    return calls
  }

  it('keeps tokens out of web storage and sends the cookie', async () => {
    sessionStorage.setItem('gitvfs-github-auth:tokens', '{"accessToken":"stale"}')
    const auth = createCookieAuth()
    expect(sessionStorage.getItem('gitvfs-github-auth:tokens')).toBeNull()

    const state = new URL(await auth.createAuthorizeUrl()).searchParams.get('state')
    const calls = mockFetch([{ body: { access_token: 'ghu_1', expires_in: 28800, session_expires_in: 15897600 } }])
    await auth.handleRedirect(`https://docs.example.com/admin?code=c&state=${state}`)

    expect(calls[0].credentials).toBe('include')
    expect(await auth.token()).toBe('ghu_1')
    const stored = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i)!))
    expect(stored.join()).not.toContain('ghu_1')
  })

  it('restores a session after a reload through the cookie', async () => {
    const calls = mockFetch([{ body: { access_token: 'ghu_2', expires_in: 28800, session_expires_in: 1000 } }])
    const auth = createCookieAuth()
    expect(auth.isSignedIn()).toBe(false)
    expect(await auth.restoreSession()).toBe(true)
    expect(calls[0]).toEqual({ body: { grant_type: 'refresh_token' }, credentials: 'include' })
    expect(await auth.token()).toBe('ghu_2')
  })

  it('reports a missing session as signed out', async () => {
    mockFetch([{ status: 401, body: { error: 'no_session', error_description: 'No valid session' } }])
    const auth = createCookieAuth()
    expect(await auth.restoreSession()).toBe(false)
    mockFetch([{ status: 401, body: { error: 'no_session' } }])
    await expect(auth.token()).rejects.toMatchObject({ code: 'not_signed_in' })
  })

  it('asks the handler to clear the cookie on sign-out', async () => {
    const calls = mockFetch([{ body: { access_token: 'ghu_1', expires_in: 28800 } }, { status: 204 }])
    const auth = createCookieAuth()
    await auth.restoreSession()
    await auth.signOut()
    expect(calls[1]).toEqual({ body: { action: 'sign_out' }, credentials: 'include' })
    expect(auth.isSignedIn()).toBe(false)
  })
})
