import type { GitRepository } from './provider.js'
import type { CacheAdapter } from '../cache/types.js'
import type { Change } from '../change-buffer.js'

export type GitVFSOptions = GitVFSBaseOptions & (
  | {
    /** The repository to work on, e.g. `github({ token }).repository('owner/name')`. */
    repository: GitRepository
    provider?: never
  }
  | {
    /** @deprecated Renamed to `repository`. */
    provider: GitRepository
    repository?: never
  }
)

export interface GitVFSBaseOptions {
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

/** @deprecated Renamed to `GitVFSOptions`. */
export type GitFSOptions = GitVFSOptions
/** @deprecated Renamed to `GitVFSBaseOptions`. */
export type GitFSBaseOptions = GitVFSBaseOptions
