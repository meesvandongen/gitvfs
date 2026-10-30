import { codeChallenge, createPkcePair, randomString } from '../src/pkce'

describe('PKCE', () => {
  it('matches the RFC 7636 test vector', async () => {
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('creates URL-safe verifiers and 43 character challenges', async () => {
    const { verifier, challenge } = await createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(await codeChallenge(verifier))
  })

  it('does not repeat random strings', () => {
    expect(randomString()).not.toBe(randomString())
  })
})
