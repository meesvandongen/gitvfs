import { encodeText } from './encoding.js'

/**
 * Calculate the git SHA-1 hash for a blob.
 * Git hashes blobs as: "blob <size>\0<content>"
 */
export async function getGitHash(content: Uint8Array): Promise<string> {
  const header = encodeText(`blob ${content.length}\0`)
  const combined = new Uint8Array(header.length + content.length)
  combined.set(header, 0)
  combined.set(content, header.length)

  const hashBuffer = await crypto.subtle.digest('SHA-1', combined)
  const hashArray = new Uint8Array(hashBuffer)
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
