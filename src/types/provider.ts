export interface TreeEntry {
  path: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
}

export interface FileContent {
  path: string
  sha: string
  content: Uint8Array
  size: number
}

export interface BranchInfo {
  name: string
  sha: string
}

export interface CommitFileChange {
  action: 'create' | 'update' | 'delete' | 'move'
  path: string
  content?: Uint8Array | string
  previousPath?: string
}

export interface CommitOptions {
  branch: string
  message: string
  changes: CommitFileChange[]
  expectedHeadOid?: string
}

export interface CommitResult {
  sha: string
  date: string
  files: Record<string, { sha: string }>
}

export interface ReadDirOptions {
  recursive?: boolean
}

export interface GitProvider {
  readdir(ref: string, path: string, options?: ReadDirOptions): Promise<TreeEntry[]>
  getFiles(ref: string, paths: string[]): Promise<Map<string, FileContent>>
  getFile(ref: string, path: string): Promise<FileContent>
  getBlob(sha: string): Promise<Uint8Array>
  getBranch(name: string): Promise<BranchInfo>
  getLastCommitSha(branch: string): Promise<string>
  createBranch(name: string, fromSha: string): Promise<BranchInfo>
  deleteBranch(name: string): Promise<void>
  commit(options: CommitOptions): Promise<CommitResult>
}
