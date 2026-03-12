const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Encode a string to Uint8Array (UTF-8). */
export function encodeText(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Decode a Uint8Array to string (UTF-8). */
export function decodeText(data: Uint8Array): string {
  return decoder.decode(data)
}

/** Encode bytes to base64. */
export function toBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  return btoa(binary)
}

/** Decode base64 to bytes. */
export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
