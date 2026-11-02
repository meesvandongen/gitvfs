import { describe, it, expect, beforeEach, vi } from 'vite-plus/test'
import { GitVFS } from '../../src/gitvfs'
import { MockRepository } from '../helpers/mock-repository'
import { NotFoundError } from '../../src/types/errors'

describe('GitVFS', () => {
  let repository: MockRepository
  let fs: GitVFS

  beforeEach(async () => {
    repository = new MockRepository()
    await repository.addFile('main', 'readme.md', '# Hello')
    await repository.addFile('main', 'posts/hello.md', '# Hello World')
    await repository.addFile('main', 'posts/draft.md', 'Draft content')

    fs = new GitVFS({
      repository,
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
      await repository.addFile('main', 'posts/archive/2024.md', 'Archived')
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

      expect(repository.lastCommitShaCallCount).toBe(1)
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
      // Verify the file was deleted in the mock repository
      const branch = repository.branches.get('main')!
      expect(branch.files.find((f) => f.path === 'posts/draft.md')).toBeUndefined()
    })
  })

  describe('rename', () => {
    const text = (path: string) => {
      const file = repository.branches.get('main')!.files.find((f) => f.path === path)
      return file ? new TextDecoder().decode(file.content) : undefined
    }

    it('keeps the content of an unchanged file', async () => {
      fs.rename('posts/hello.md', 'posts/renamed.md')
      await fs.commit('Rename')

      expect(text('posts/renamed.md')).toBe('# Hello World')
      expect(text('posts/hello.md')).toBeUndefined()
    })

    it('sends one move with the content and no separate deletion', async () => {
      const commit = vi.spyOn(repository, 'commit')
      fs.rename('posts/hello.md', 'posts/renamed.md')
      await fs.commit('Rename')

      const changes = commit.mock.calls[0][0].changes
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ action: 'move', path: 'posts/renamed.md', previousPath: 'posts/hello.md' })
      expect(new TextDecoder().decode(changes[0].content as Uint8Array)).toBe('# Hello World')
    })

    it('reads the renamed file before committing', async () => {
      fs.rename('posts/hello.md', 'posts/renamed.md')
      expect(await fs.readFile('posts/renamed.md', { encoding: 'utf-8' })).toBe('# Hello World')
      expect(await fs.exists('posts/hello.md')).toBe(false)
      expect((await fs.readdir('posts')).map((e) => e.name).sort()).toEqual(['draft.md', 'renamed.md'])
    })

    it('moves pending edits along', async () => {
      fs.writeFile('posts/draft.md', 'Edited draft')
      fs.rename('posts/draft.md', 'posts/final.md')
      expect(await fs.readFile('posts/final.md', { encoding: 'utf-8' })).toBe('Edited draft')
      await fs.commit('Edit and rename')

      expect(text('posts/final.md')).toBe('Edited draft')
      expect(text('posts/draft.md')).toBeUndefined()
    })

    it('renames a file created in the same batch without deleting anything', async () => {
      const commit = vi.spyOn(repository, 'commit')
      fs.writeFile('posts/new.md', 'New')
      fs.rename('posts/new.md', 'posts/newer.md')
      await fs.commit('Create')

      expect(commit.mock.calls[0][0].changes).toEqual([{ action: 'create', path: 'posts/newer.md', content: 'New' }])
      expect(text('posts/newer.md')).toBe('New')
    })

    it('follows a file renamed twice back to its original path', async () => {
      fs.rename('posts/hello.md', 'posts/a.md')
      fs.rename('posts/a.md', 'posts/b.md')
      expect(fs.status()).toEqual(
        expect.arrayContaining([
          { path: 'posts/b.md', action: 'move' },
          { path: 'posts/hello.md', action: 'delete' },
        ]),
      )
      await fs.commit('Rename twice')

      expect(text('posts/b.md')).toBe('# Hello World')
      expect(text('posts/a.md')).toBeUndefined()
      expect(text('posts/hello.md')).toBeUndefined()
    })

    it('treats a rename to the same path as nothing', () => {
      fs.rename('posts/hello.md', 'posts/hello.md')
      expect(fs.status()).toEqual([])
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
      expect(repository.branches.has('feature/test')).toBe(true)
    })

    it('switches branch with checkout', async () => {
      await fs.createBranch('feature/test')
      await repository.addFile('feature/test', 'feature.md', 'Feature content')

      fs.checkout('feature/test')
      const content = await fs.readFile('feature.md', { encoding: 'utf-8' })
      expect(content).toBe('Feature content')
    })
  })

  describe('writeBranch (editorial workflow)', () => {
    it('auto-creates writeBranch on first commit', async () => {
      const editFs = new GitVFS({
        repository,
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

      expect(repository.branches.has('drafts/update')).toBe(true)
    })

    const text = (branch: string, path: string) => {
      const file = repository.branches.get(branch)?.files.find((f) => f.path === path)
      return file ? new TextDecoder().decode(file.content) : undefined
    }
    const draftsFs = (options: { headValidationIntervalMs?: number } = {}) =>
      new GitVFS({ repository, branch: 'main', writeBranch: 'drafts', cache: 'memory', ...options })

    it('reads its own commits back instead of the base branch (regression)', async () => {
      const editFs = draftsFs()
      editFs.writeFile('readme.md', '# Edited')
      await editFs.commit('Edit once')

      // Used to read '# Hello' from main, so the next edit built on main and dropped this one.
      expect(await editFs.readFile('readme.md', { encoding: 'utf-8' })).toBe('# Edited')

      const current = (await editFs.readFile('readme.md', { encoding: 'utf-8' })) as string
      editFs.writeFile('readme.md', `${current}, twice`)
      await editFs.commit('Edit twice')

      expect(text('drafts', 'readme.md')).toBe('# Edited, twice')
      expect(text('main', 'readme.md')).toBe('# Hello')
    })

    it('lists files created and deleted on the write branch after committing', async () => {
      const editFs = draftsFs()
      editFs.writeFile('posts/new.md', 'New')
      editFs.rm('posts/draft.md')
      await editFs.commit('Add and remove')

      expect((await editFs.readdir('posts')).map((e) => e.name).sort()).toEqual(['hello.md', 'new.md'])
      expect(await editFs.exists('posts/draft.md')).toBe(false)
      expect(fs.status()).toEqual([])
      expect((await fs.readdir('posts')).map((e) => e.name).sort()).toEqual(['draft.md', 'hello.md'])
    })

    it('reads from a write branch that already exists', async () => {
      await repository.createBranch('drafts', repository.branches.get('main')!.sha)
      await repository.addFile('drafts', 'drafts-only.md', 'Draft')

      const editFs = draftsFs()
      expect(await editFs.readFile('drafts-only.md', { encoding: 'utf-8' })).toBe('Draft')
    })

    it('reads from the base branch until the write branch appears', async () => {
      const editFs = draftsFs({ headValidationIntervalMs: 0 })
      expect(await editFs.exists('drafts-only.md')).toBe(false)

      await repository.createBranch('drafts', repository.branches.get('main')!.sha)
      await repository.addFile('drafts', 'drafts-only.md', 'Draft')
      repository.branches.get('drafts')!.sha = 'commit-sha-drafts'

      expect(await editFs.readFile('drafts-only.md', { encoding: 'utf-8' })).toBe('Draft')
    })

    it('branches from the write branch once it exists', async () => {
      const editFs = draftsFs()
      editFs.writeFile('readme.md', '# Edited')
      await editFs.commit('Edit')
      await editFs.createBranch('drafts-copy')

      expect(text('drafts-copy', 'readme.md')).toBe('# Edited')
    })
  })

  describe('checkout', () => {
    it('reports its branches', async () => {
      const editFs = new GitVFS({ repository, branch: 'main', writeBranch: 'drafts' })
      expect(editFs.branches()).toEqual({ base: 'main', write: 'drafts', read: 'main' })
      expect(fs.repository).toBe(repository)
    })

    it('switches to a write branch on top of a base', async () => {
      await repository.createBranch('drafts', repository.branches.get('main')!.sha)
      await repository.addFile('drafts', 'drafts-only.md', 'Draft')

      fs.checkout('drafts', { base: 'main' })
      expect(await fs.readFile('drafts-only.md', { encoding: 'utf-8' })).toBe('Draft')
      expect(fs.branches()).toEqual({ base: 'main', write: 'drafts', read: 'drafts' })

      fs.checkout('main')
      expect(await fs.exists('drafts-only.md')).toBe(false)
      expect(fs.branches()).toEqual({ base: 'main', write: 'main', read: 'main' })
    })
  })

  describe('updateFromBase', () => {
    it('merges the base branch in and reads the result', async () => {
      const editFs = new GitVFS({ repository, branch: 'main', writeBranch: 'drafts', cache: 'memory' })
      editFs.writeFile('readme.md', '# Edited')
      await editFs.commit('Edit')
      expect(await editFs.exists('news.md')).toBe(false)

      // Someone adds a file to main; the stub merges it in like the host would.
      await repository.addFile('main', 'news.md', 'News')
      const mergeBranch = vi.fn(async ({ into, from }: { into: string; from: string }) => {
        const target = repository.branches.get(into)!
        const source = repository.branches.get(from)!
        target.files = [...target.files, ...source.files.filter((f) => !target.files.some((t) => t.path === f.path))]
        target.sha = 'commit-sha-merge'
        return { sha: target.sha, date: new Date().toISOString() }
      })
      repository.mergeBranch = mergeBranch

      expect(await editFs.updateFromBase('Update')).toMatchObject({ sha: 'commit-sha-merge' })
      expect(mergeBranch).toHaveBeenCalledWith({ into: 'drafts', from: 'main', message: 'Update' })
      expect(await editFs.readFile('news.md', { encoding: 'utf-8' })).toBe('News')
      expect(await editFs.readFile('readme.md', { encoding: 'utf-8' })).toBe('# Edited')
    })

    it('needs a separate write branch', async () => {
      repository.mergeBranch = vi.fn()
      await expect(fs.updateFromBase()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    })

    it('needs a repository that can merge', async () => {
      const editFs = new GitVFS({ repository, branch: 'main', writeBranch: 'drafts' })
      await expect(editFs.updateFromBase()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
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
