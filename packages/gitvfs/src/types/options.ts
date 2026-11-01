import type { GitRepository } from './provider.js'
import type { CacheAdapter } from '../cache/types.js'
import type { Change } from '../change-buffer.js'

export interface GitVFSOptions {
  /** The repository to work on, e.g. `github({ token }).repository('owner/name')`. */
  repository: GitRepository
  branch: string
  writeBranch?: string
  cache?: 'memory' | 'indexeddb' | 'none' | CacheAdapter | CacheConfig
  headValidationIntervalMs?: number
  autoCommit?: boolean
  autoCommitDelay?: number
  commitMessage?: (changes: Change[]) => string
}

export interface CacheConfig {
  backend: 'memory' | 'indexeddb' | 'none'
  name?: string
}

