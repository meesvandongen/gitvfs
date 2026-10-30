function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A random URL-safe string with `bytes` bytes of entropy. */
export function randomString(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** The S256 code challenge for a PKCE code verifier (RFC 7636). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/** A fresh verifier and its challenge. GitHub expects a 43 character challenge, which S256 gives. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomString(32)
  return { verifier, challenge: await codeChallenge(verifier) }
}
