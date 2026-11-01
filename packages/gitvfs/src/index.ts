export { GitVFS, GitFS } from './gitvfs.js'
export type { DirEntry, StatResult } from './gitvfs.js'
export type { GitVFSOptions, GitVFSBaseOptions, GitFSOptions, GitFSBaseOptions, CacheConfig } from './types/options.js'
export type {
  GitProvider,
  GitRepository,
  RepositoryInfo,
  ListRepositoriesOptions,
  TreeEntry,
  ReadDirOptions,
  FileContent,
  BranchInfo,
  CommitOptions,
  CommitResult,
  CommitFileChange,
} from './types/provider.js'
export type { CacheAdapter } from './cache/types.js'
export type { Change } from './change-buffer.js'
export {
  GitVFSError,
  GitFSError,
  NotFoundError,
  RateLimitError,
  ConflictError,
  AuthError,
  NetworkError,
} from './types/errors.js'
export { MemoryCacheAdapter } from './cache/memory.js'
export { NoneCacheAdapter } from './cache/none.js'
export type { TokenProvider } from './providers/shared/http.js'
