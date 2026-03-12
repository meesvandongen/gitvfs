import type { GitProvider } from './provider.js'
import type { CacheAdapter } from '../cache/types.js'
import type { Change } from '../change-buffer.js'

export interface GitFSOptions {
  provider: GitProvider
  branch: string
  writeBranch?: string
  cache?: 'memory' | 'indexeddb' | 'none' | CacheAdapter | CacheConfig
  autoCommit?: boolean
  autoCommitDelay?: number
  commitMessage?: (changes: Change[]) => string
}

export interface CacheConfig {
  backend: 'memory' | 'indexeddb' | 'none'
  name?: string
}
