import { describe, it, expect } from 'vitest'
import { NoneCacheAdapter } from '../../src/cache/none'

describe('NoneCacheAdapter', () => {
  it('always returns undefined on get', async () => {
    const cache = new NoneCacheAdapter()
    await cache.set('key', 'value')
    expect(await cache.get('key')).toBeUndefined()
  })

  it('set is a no-op', async () => {
    const cache = new NoneCacheAdapter()
    await expect(cache.set('k', 'v')).resolves.toBeUndefined()
  })

  it('delete is a no-op', async () => {
    const cache = new NoneCacheAdapter()
    await expect(cache.delete('k')).resolves.toBeUndefined()
  })

  it('clear is a no-op', async () => {
    const cache = new NoneCacheAdapter()
    await expect(cache.clear()).resolves.toBeUndefined()
  })
})
