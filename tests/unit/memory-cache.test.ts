import { describe, it, expect } from 'vitest'
import { MemoryCacheAdapter } from '../../src/cache/memory'

describe('MemoryCacheAdapter', () => {
  it('stores and retrieves values', async () => {
    const cache = new MemoryCacheAdapter()
    await cache.set('key', { data: 'value' })
    expect(await cache.get('key')).toEqual({ data: 'value' })
  })

  it('returns undefined for missing keys', async () => {
    const cache = new MemoryCacheAdapter()
    expect(await cache.get('missing')).toBeUndefined()
  })

  it('overwrites existing values', async () => {
    const cache = new MemoryCacheAdapter()
    await cache.set('key', 'v1')
    await cache.set('key', 'v2')
    expect(await cache.get('key')).toBe('v2')
  })

  it('deletes a key', async () => {
    const cache = new MemoryCacheAdapter()
    await cache.set('key', 'value')
    await cache.delete('key')
    expect(await cache.get('key')).toBeUndefined()
  })

  it('clears all keys', async () => {
    const cache = new MemoryCacheAdapter()
    await cache.set('a', 1)
    await cache.set('b', 2)
    await cache.clear()
    expect(await cache.get('a')).toBeUndefined()
    expect(await cache.get('b')).toBeUndefined()
  })
})
