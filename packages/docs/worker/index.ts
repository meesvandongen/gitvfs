import { createTokenHandler, originMatcher } from 'gitvfs-github-auth/server'

interface Env {
  /** Client ID of the GitHub App or OAuth App behind "Sign in with GitHub" on /admin. */
  GITHUB_CLIENT_ID?: string
  /** Set with `wrangler secret put GITHUB_CLIENT_SECRET`. */
  GITHUB_CLIENT_SECRET?: string
  /** OAuth Apps only: the scope to request, e.g. `public_repo` or `repo`. */
  GITHUB_SCOPE?: string
  /**
   * Comma-separated origins that may sign in, e.g. `https://*.docs.example.com` for previews.
   * Each must match a callback URL of the app (with wildcard matching for subdomains).
   */
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
    const origins = (env.GITHUB_ALLOWED_ORIGINS ?? '').split(',')
    const enabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) && originMatcher(origins)(url.origin)

    if (url.pathname === '/api/github/config') {
      // GitHub only redirects to registered callback URLs, so other origins get none.
      return json(enabled ? { clientId: env.GITHUB_CLIENT_ID, scope: env.GITHUB_SCOPE || undefined } : { clientId: null })
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
