import { describe, it, expect } from 'vitest'
import { getGitHash } from '../../src/utils/hash'
import { encodeText } from '../../src/utils/encoding'

describe('getGitHash', () => {
  it('computes correct git blob hash for "hello"', async () => {
    // printf 'hello' | git hash-object --stdin => b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0
    const hash = await getGitHash(encodeText('hello'))
    expect(hash).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
  })

  it('computes correct hash for empty content', async () => {
    // git hash-object -t blob --stdin < /dev/null
    // => e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
    const hash = await getGitHash(new Uint8Array([]))
    expect(hash).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })
})
