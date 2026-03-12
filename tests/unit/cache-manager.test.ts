import { describe, it, expect } from 'vitest'
import { CacheManager } from '../../src/cache/manager'
import { MemoryCacheAdapter } from '../../src/cache/memory'

describe('CacheManager', () => {
  function createManager() {
    return new CacheManager(new MemoryCacheAdapter(), 'test-repo')
  }

  it('stores and retrieves head SHA', async () => {
    const cm = createManager()
    await cm.setHeadSha('main', 'abc123')
    expect(await cm.getHeadSha('main')).toBe('abc123')
  })

  it('stores and retrieves tree', async () => {
    const cm = createManager()
    const tree = [
      { path: 'file.txt', type: 'blob' as const, sha: 'aaa', size: 10 },
    ]
    await cm.setTree('main', tree)
    expect(await cm.getTree('main')).toEqual(tree)
  })

  it('stores and retrieves file content', async () => {
    const cm = createManager()
    const content = {
      path: 'file.txt',
      sha: 'abc',
      content: new Uint8Array([1, 2, 3]),
      size: 3,
    }
    await cm.setFileContent('abc', 'file.txt', content)
    expect(await cm.getFileContent('abc', 'file.txt')).toEqual(content)
  })

  it('returns undefined for missing keys', async () => {
    const cm = createManager()
    expect(await cm.getHeadSha('main')).toBeUndefined()
    expect(await cm.getTree('main')).toBeUndefined()
    expect(await cm.getFileContent('abc', 'file.txt')).toBeUndefined()
  })

  it('clears all cached data', async () => {
    const cm = createManager()
    await cm.setHeadSha('main', 'abc')
    await cm.clear()
    expect(await cm.getHeadSha('main')).toBeUndefined()
  })
})
