/** What the browser sends to the token endpoint. The handler adds the client ID and secret. */
export type TokenRequest =
  | {
    grant_type: 'authorization_code'
    code: string
    code_verifier: string
    redirect_uri?: string
  }
  | {
    grant_type: 'refresh_token'
    /** Omitted with cookie sessions: the handler reads the refresh token from the sealed cookie. */
    refresh_token?: string
  }

/** Ends a cookie session: the handler clears the sealed cookie. */
export interface SignOutRequest {
  action: 'sign_out'
}

/** GitHub's token response, as the handler passes it on. */
export interface TokenResponse {
  access_token: string
  token_type?: string
  scope?: string
  /** Seconds. Only for expiring tokens (GitHub Apps, by default). */
  expires_in?: number
  /** Never sent with cookie sessions; the refresh token stays in the sealed cookie. */
  refresh_token?: string
  refresh_token_expires_in?: number
  /** Cookie sessions: seconds until the session cookie expires. */
  session_expires_in?: number
}
