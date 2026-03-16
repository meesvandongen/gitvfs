import { describe, it, expect, beforeEach } from 'vitest'
import { GitFS } from '../../src/gitvfs'
import { MockProvider } from '../helpers/mock-provider'
import { NotFoundError } from '../../src/types/errors'

describe('GitFS', () => {
  let provider: MockProvider
  let fs: GitFS

  beforeEach(async () => {
    provider = new MockProvider()
    await provider.addFile('main', 'readme.md', '# Hello')
    await provider.addFile('main', 'posts/hello.md', '# Hello World')
    await provider.addFile('main', 'posts/draft.md', 'Draft content')

    fs = new GitFS({
      provider,
      branch: 'main',
      cache: 'memory',
    })
  })

  describe('readFile', () => {
    it('reads a file as Uint8Array by default', async () => {
      const content = await fs.readFile('readme.md')
      expect(content).toBeInstanceOf(Uint8Array)
    })

    it('reads a file as string with utf-8 encoding', async () => {
      const content = await fs.readFile('readme.md', { encoding: 'utf-8' })
      expect(content).toBe('# Hello')
    })

    it('throws NotFoundError for missing file', async () => {
      await expect(fs.readFile('missing.md')).rejects.toThrow(NotFoundError)
    })

    it('returns pending write content (overlay)', async () => {
      fs.writeFile('readme.md', '# Updated')
      const content = await fs.readFile('readme.md', { encoding: 'utf-8' })
      expect(content).toBe('# Updated')
    })

    it('throws NotFoundError for deleted file in buffer', async () => {
      fs.rm('readme.md')
      await expect(fs.readFile('readme.md')).rejects.toThrow(NotFoundError)
    })
  })

  describe('readdir', () => {
    it('lists root directory entries', async () => {
      const entries = await fs.readdir('')
      const names = entries.map((e) => e.name)
      expect(names).toContain('readme.md')
      expect(names).toContain('posts')
    })

    it('lists subdirectory entries', async () => {
      const entries = await fs.readdir('posts')
      const names = entries.map((e) => e.name)
      expect(names).toContain('hello.md')
      expect(names).toContain('draft.md')
    })

    it('reflects pending writes in listing', async () => {
      fs.writeFile('posts/new.md', 'New post')
      const entries = await fs.readdir('posts')
      const names = entries.map((e) => e.name)
      expect(names).toContain('new.md')
    })

    it('excludes deleted files from listing', async () => {
      fs.rm('posts/draft.md')
      const entries = await fs.readdir('posts')
      const names = entries.map((e) => e.name)
      expect(names).not.toContain('draft.md')
    })

    it('supports recursive listings', async () => {
      await provider.addFile('main', 'posts/archive/2024.md', 'Archived')
      const entries = await fs.readdir('posts', { recursive: true })
      const names = entries.map((e) => e.name)
      expect(names).toContain('hello.md')
      expect(names).toContain('draft.md')
      expect(names).toContain('archive')
      expect(names).toContain('archive/2024.md')
    })

    it('reuses the validated branch head across rapid navigation', async () => {
      await fs.readdir('')
      await fs.readdir('posts')
      await fs.readdir('')

      expect(provider.lastCommitShaCallCount).toBe(1)
    })
  })

  describe('exists', () => {
    it('returns true for existing files', async () => {
      expect(await fs.exists('readme.md')).toBe(true)
    })

    it('returns false for missing files', async () => {
      expect(await fs.exists('missing.md')).toBe(false)
    })

    it('returns false for deleted files', async () => {
      fs.rm('readme.md')
      expect(await fs.exists('readme.md')).toBe(false)
    })

    it('returns true for pending writes', async () => {
      fs.writeFile('new.md', 'content')
      expect(await fs.exists('new.md')).toBe(true)
    })
  })

  describe('stat', () => {
    it('returns metadata for existing file', async () => {
      const info = await fs.stat('readme.md')
      expect(info.type).toBe('blob')
      expect(info.sha).toBeTruthy()
    })

    it('throws NotFoundError for missing file', async () => {
      await expect(fs.stat('missing.md')).rejects.toThrow(NotFoundError)
    })
  })

  describe('writeFile + commit', () => {
    it('creates and commits a new file', async () => {
      fs.writeFile('posts/new.md', '# New Post')

      const status = fs.status()
      expect(status).toHaveLength(1)
      expect(status[0]).toEqual({ path: 'posts/new.md', action: 'create' })

      const result = await fs.commit('Add new post')
      expect(result.sha).toBeTruthy()
      expect(result.files['posts/new.md']).toBeTruthy()
    })

    it('updates an existing file', async () => {
      // First read to populate tree
      await fs.readFile('readme.md')

      fs.writeFile('readme.md', '# Updated')
      const status = fs.status()
      expect(status[0].action).toBe('update')

      const result = await fs.commit('Update readme')
      expect(result.sha).toBeTruthy()
    })

    it('clears buffer after commit', async () => {
      fs.writeFile('new.md', 'content')
      await fs.commit('Add file')
      expect(fs.status()).toHaveLength(0)
    })

    it('throws when nothing to commit', async () => {
      await expect(fs.commit('Empty')).rejects.toThrow('No changes to commit')
    })
  })

  describe('rm + commit', () => {
    it('deletes a file', async () => {
      fs.rm('posts/draft.md')
      const status = fs.status()
      expect(status[0]).toEqual({ path: 'posts/draft.md', action: 'delete' })

      await fs.commit('Remove draft')
      // Verify the file was deleted in the mock provider
      const branch = provider.branches.get('main')!
      expect(branch.files.find((f) => f.path === 'posts/draft.md')).toBeUndefined()
    })
  })

  describe('rename', () => {
    it('renames a file (move)', async () => {
      fs.writeFile('posts/draft.md', 'Draft content')
      fs.rename('posts/draft.md', 'posts/final.md')

      const status = fs.status()
      const paths = status.map((s) => s.path)
      expect(paths).toContain('posts/final.md')
      expect(paths).toContain('posts/draft.md')
    })
  })

  describe('discard', () => {
    it('clears pending changes', () => {
      fs.writeFile('new.md', 'content')
      fs.rm('readme.md')
      expect(fs.status()).toHaveLength(2)

      fs.discard()
      expect(fs.status()).toHaveLength(0)
    })
  })

  describe('branching', () => {
    it('creates a new branch', async () => {
      await fs.createBranch('feature/test')
      expect(provider.branches.has('feature/test')).toBe(true)
    })

    it('switches branch with checkout', async () => {
      await fs.createBranch('feature/test')
      await provider.addFile('feature/test', 'feature.md', 'Feature content')

      fs.checkout('feature/test')
      const content = await fs.readFile('feature.md', { encoding: 'utf-8' })
      expect(content).toBe('Feature content')
    })
  })

  describe('writeBranch (editorial workflow)', () => {
    it('auto-creates writeBranch on first commit', async () => {
      const editFs = new GitFS({
        provider,
        branch: 'main',
        writeBranch: 'drafts/update',
        cache: 'memory',
      })

      // Reads come from main
      const content = await editFs.readFile('readme.md', { encoding: 'utf-8' })
      expect(content).toBe('# Hello')

      // Writes go to writeBranch
      editFs.writeFile('new.md', 'Draft')
      await editFs.commit('Draft commit')

      expect(provider.branches.has('drafts/update')).toBe(true)
    })
  })

  describe('prefetch', () => {
    it('populates cache with file contents', async () => {
      await fs.prefetch()
      // After prefetch, reading should use cache (no additional API calls)
      const content = await fs.readFile('readme.md', { encoding: 'utf-8' })
      expect(content).toBe('# Hello')
    })
  })
})
