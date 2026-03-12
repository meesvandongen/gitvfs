export { GitFS } from './git-fs.js'
export type { DirEntry, StatResult } from './git-fs.js'
export type { GitFSOptions, CacheConfig } from './types/options.js'
export type {
  GitProvider,
  TreeEntry,
  FileContent,
  BranchInfo,
  CommitOptions,
  CommitResult,
  CommitFileChange,
} from './types/provider.js'
export type { CacheAdapter } from './cache/types.js'
export type { Change } from './change-buffer.js'
export {
  GitFSError,
  NotFoundError,
  RateLimitError,
  ConflictError,
  AuthError,
  NetworkError,
} from './types/errors.js'
export { MemoryCacheAdapter } from './cache/memory.js'
export { NoneCacheAdapter } from './cache/none.js'
