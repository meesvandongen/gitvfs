import type { CacheAdapter } from './types.js'

export class NoneCacheAdapter implements CacheAdapter {
  async get<T>(): Promise<T | undefined> {
    return undefined
  }

  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async clear(): Promise<void> {}
}
