# gitvfs-github-auth

Sign in with GitHub from a browser app, using the authorization code flow with PKCE, and hand the token to [gitvfs](../gitvfs).

GitHub [supports PKCE](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/), but its token endpoint still requires the client secret and sends no CORS headers. A browser app therefore cannot finish the sign-in on its own. This package has two halves:

- **`gitvfs-github-auth`** runs in the browser. It redirects to GitHub, keeps the PKCE verifier across the redirect, exchanges the code, and refreshes expiring tokens.
- **`gitvfs-github-auth/server`** is a small Fetch API handler that adds the client secret and CORS headers. It works in Cloudflare Workers, Deno, Bun or Node 18+, and only accepts code exchanges that carry a PKCE verifier.

## Install

```sh
pnpm add gitvfs gitvfs-github-auth
```

## Create a GitHub App

A GitHub App is recommended over an OAuth App. Its user tokens only reach repositories where the app is installed, are limited to the permissions you choose, and expire after eight hours (they are refreshed automatically).

1. Create the app under **Settings → Developer settings → GitHub Apps**.
2. Set the **Callback URL** to the page that handles the redirect, for example `https://docs.example.com/admin`.
3. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**. Leave **Expire user authorization tokens** on.
4. Generate a client secret, then install the app on the repositories it should edit.

With an OAuth App, pass `scope: 'repo'` (or `public_repo`) instead.

## Token handler

```ts
// worker.ts (Cloudflare Workers)
import { createTokenHandler } from 'gitvfs-github-auth/server'

export default {
  fetch(request: Request, env: { GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string }) {
    return createTokenHandler({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      allowedOrigins: ['https://docs.example.com'],
    })(request)
  },
}
```

Store the secret with `wrangler secret put GITHUB_CLIENT_SECRET`, not in code.

## Browser

```ts
import { GitFS } from 'gitvfs'
import { github } from 'gitvfs/providers/github'
import { createGitHubAuth } from 'gitvfs-github-auth'

const auth = createGitHubAuth({
  clientId: 'Iv23li…',
  tokenUrl: '/api/github/token',
  redirectUri: `${location.origin}/admin`,
})

await auth.handleRedirect() // finishes a sign-in when GitHub redirects back

if (!auth.isSignedIn()) {
  await auth.login() // redirects to GitHub
}

const fs = new GitFS({
  provider: github({ owner: 'acme', repo: 'site', token: auth.token }),
  branch: 'main',
})
```

`auth.token` is a gitvfs `TokenProvider`: every request gets a valid access token, and expired tokens are refreshed once, even with concurrent requests. Other methods:

| Method | |
| --- | --- |
| `fetchUser()` | The signed-in user's profile (`login`, `name`, `avatar_url`). |
| `signOut()` | Forget the tokens in this browser. |
| `getTokens()` | The stored tokens and their expiry times. |

Errors are `GitHubAuthError`s with a `code`: `not_signed_in`, `session_expired`, `state_mismatch`, `token_exchange_failed`, or GitHub's own error (`access_denied`, `bad_verification_code`, `bad_refresh_token`, …).

Tokens live in `sessionStorage` by default. Pass `storage: 'memory'` to keep them only for the current page load (the PKCE verifier still survives the redirect), or `storage: 'local'` to keep them across browser restarts.

## Limits

- Callback URLs are matched exactly, without wildcards, so a sign-in only works on the URLs registered with the app. Preview deployments on other hostnames need their own callback URL. A GitHub App accepts up to ten.
- Anything with access to the page can read the tokens, which holds for any browser-based sign-in. Keep the editor on its own origin and do not render untrusted HTML next to it.
