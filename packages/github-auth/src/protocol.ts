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
    refresh_token: string
  }

/** GitHub's token response, as the handler passes it on. */
export interface TokenResponse {
  access_token: string
  token_type?: string
  scope?: string
  /** Seconds. Only for expiring tokens (GitHub Apps, by default). */
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
}
