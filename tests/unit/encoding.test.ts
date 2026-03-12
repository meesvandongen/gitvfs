import { describe, it, expect } from 'vitest'
import { encodeText, decodeText, toBase64, fromBase64 } from '../../src/utils/encoding'

describe('encoding utils', () => {
  it('encodes and decodes text', () => {
    const text = 'Hello, World!'
    const bytes = encodeText(text)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(decodeText(bytes)).toBe(text)
  })

  it('encodes and decodes base64', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111])
    const b64 = toBase64(bytes)
    expect(b64).toBe('SGVsbG8=')
    expect(fromBase64(b64)).toEqual(bytes)
  })

  it('handles empty input', () => {
    expect(decodeText(encodeText(''))).toBe('')
    expect(toBase64(new Uint8Array([]))).toBe('')
  })

  it('handles unicode', () => {
    const text = '你好世界 🌍'
    expect(decodeText(encodeText(text))).toBe(text)
  })
})
