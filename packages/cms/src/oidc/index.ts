import { createOidc, type Oidc, type ParamsOfCreateOidc } from 'oidc-spa/core'
import type { TokenProvider } from 'gitvfs'

export type { Oidc, ParamsOfCreateOidc }

/**
 * A gitvfs token provider backed by an oidc-spa session. Each API call asks oidc-spa for the
 * current access token, which it renews in the background.
 */
export function oidcTokenProvider(oidc: Oidc.LoggedIn): TokenProvider {
  return async () => (await oidc.getTokens()).accessToken
}

export type OidcSession =
  | {
    isUserLoggedIn: false
    oidc: Oidc.NotLoggedIn
    /** Redirects to the identity provider; resolves never. */
    login: () => Promise<never>
  }
  | {
    isUserLoggedIn: true
    oidc: Oidc.LoggedIn
    token: TokenProvider
    /** Claims of the ID token, e.g. `name`, `preferred_username`, `picture`. */
    user: Record<string, unknown>
    logout: () => Promise<never>
  }

/**
 * Start (or restore) an OpenID Connect session with oidc-spa and expose what the CMS needs.
 *
 * Call `oidcEarlyInit()` from `oidc-spa/entrypoint` (or use `oidc-spa/vite-plugin`) at the very
 * start of your app, before this runs.
 */
export async function createOidcSession(params: ParamsOfCreateOidc): Promise<OidcSession> {
  const oidc = await createOidc(params)
  if (!oidc.isUserLoggedIn) {
    return {
      isUserLoggedIn: false,
      oidc,
      login: () => oidc.login({ doesCurrentHrefRequiresAuth: false }),
    }
  }
  return {
    isUserLoggedIn: true,
    oidc,
    token: oidcTokenProvider(oidc),
    user: oidc.getDecodedIdToken() as Record<string, unknown>,
    logout: () => oidc.logout({ redirectTo: 'current page' }),
  }
}

export interface GitLabOidcOptions {
  /** Application ID of a GitLab OAuth application (non-confidential, with PKCE). */
  clientId: string
  /** GitLab instance. Default: https://gitlab.com */
  gitlabUrl?: string
  /** Default: `['api']`, which gitvfs needs to read and commit. */
  scopes?: string[]
  BASE_URL?: string
}

/**
 * oidc-spa parameters for signing in with GitLab, whose OAuth tokens work directly against the
 * GitLab API used by `gitvfs/providers/gitlab`.
 */
export function gitlabOidc(options: GitLabOidcOptions): ParamsOfCreateOidc {
  return {
    issuerUri: (options.gitlabUrl ?? 'https://gitlab.com').replace(/\/$/, ''),
    clientId: options.clientId,
    scopes: options.scopes ?? ['api'],
    BASE_URL: options.BASE_URL,
  }
}
