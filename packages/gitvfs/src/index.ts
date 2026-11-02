export { GitVFS } from './gitvfs.js'
export type { DirEntry, StatResult, BranchState } from './gitvfs.js'
export type { GitVFSOptions, CacheConfig } from './types/options.js'
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
  MergeOptions,
  MergeResult,
  ChangedFile,
  ChangedFileStatus,
  BranchComparison,
  PullRequestInfo,
  CreatePullRequestOptions,
  ListPullRequestsOptions,
  MergePullRequestOptions,
} from './types/provider.js'
export type { CacheAdapter } from './cache/types.js'
export type { Change } from './change-buffer.js'
export {
  GitVFSError,
  NotFoundError,
  RateLimitError,
  ConflictError,
  AuthError,
  NetworkError,
} from './types/errors.js'
export { MemoryCacheAdapter } from './cache/memory.js'
export { NoneCacheAdapter } from './cache/none.js'
export type { TokenProvider } from './providers/shared/http.js'
