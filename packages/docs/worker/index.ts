import { createTokenHandler } from 'gitvfs-github-auth/server'

interface Env {
  /** Client ID of the GitHub App behind "Sign in with GitHub" on /admin. */
  GITHUB_CLIENT_ID?: string
  /** Set with `wrangler secret put GITHUB_CLIENT_SECRET`. */
  GITHUB_CLIENT_SECRET?: string
  /** Comma-separated origins that may sign in; each needs a callback URL on the GitHub App. */
  GITHUB_ALLOWED_ORIGINS?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

// Everything else is served from static assets; wrangler.jsonc only routes /api/github/* here.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origins = (env.GITHUB_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
    const enabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) && origins.includes(url.origin)

    if (url.pathname === '/api/github/config') {
      // GitHub only redirects to registered callback URLs, so other origins (previews) get none.
      return json({ clientId: enabled ? env.GITHUB_CLIENT_ID : null })
    }
    if (url.pathname === '/api/github/token' && enabled) {
      return createTokenHandler({
        clientId: env.GITHUB_CLIENT_ID!,
        clientSecret: env.GITHUB_CLIENT_SECRET!,
        allowedOrigins: origins,
      })(request)
    }
    return json({ error: 'not_found' }, 404)
  },
}
