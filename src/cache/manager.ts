import type { CacheAdapter } from './types.js'
import type { TreeEntry, FileContent } from '../types/provider.js'

export class CacheManager {
  private adapter: CacheAdapter
  private repoKey: string

  constructor(adapter: CacheAdapter, repoKey: string) {
    this.adapter = adapter
    this.repoKey = repoKey
  }

  private key(suffix: string): string {
    return `${this.repoKey}:${suffix}`
  }

  async getHeadSha(branch: string): Promise<string | undefined> {
    return this.adapter.get<string>(this.key(`${branch}:head`))
  }

  async setHeadSha(branch: string, sha: string): Promise<void> {
    await this.adapter.set(this.key(`${branch}:head`), sha)
  }

  async getDirEntries(
    branch: string,
    path: string,
    recursive = false,
  ): Promise<TreeEntry[] | undefined> {
    return this.adapter.get<TreeEntry[]>(this.key(`${branch}:dir:${recursive ? 'recursive:' : ''}${path}`))
  }

  async setDirEntries(
    branch: string,
    path: string,
    entries: TreeEntry[],
    recursive = false,
  ): Promise<void> {
    await this.adapter.set(this.key(`${branch}:dir:${recursive ? 'recursive:' : ''}${path}`), entries)
  }

  async getFileContent(branch: string, path: string): Promise<FileContent | undefined> {
    return this.adapter.get<FileContent>(this.key(`${branch}:file:${path}`))
  }

  async setFileContent(branch: string, path: string, content: FileContent): Promise<void> {
    await this.adapter.set(this.key(`${branch}:file:${path}`), content)
  }

  async clear(): Promise<void> {
    await this.adapter.clear()
  }
}
