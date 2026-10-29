import { GitFS } from 'gitvfs'
import { z } from 'zod'
import { ContentValidationError, createCms, defineCollection, defineSingleton, markdown } from '../src'
import { MemoryProvider } from './helpers/memory-provider'

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  folder: 'content/posts/',
  schema: z.object({
    title: z.string().min(1),
    date: z.coerce.date().optional(),
    draft: z.boolean().default(false),
    body: z.string().check(markdown()),
  }),
})

const settings = defineSingleton({
  name: 'settings',
  path: 'data/site.json',
  schema: z.object({ title: z.string(), description: z.string().optional() }),
})

function setup(files: Record<string, string> = {}) {
  const provider = new MemoryProvider(files)
  const fs = new GitFS({ provider, branch: 'main', cache: 'none' })
  const cms = createCms({ fs, collections: [posts], singletons: [settings] })
  return { provider, cms }
}

describe('GitCms collections', () => {
  it('lists entries with labels from frontmatter', async () => {
    const { cms } = setup({
      'content/posts/b.md': '---\ntitle: Beta\n---\nB',
      'content/posts/a.md': '---\ntitle: Alpha\n---\nA',
      'content/posts/notes.txt': 'ignored',
      'content/posts/broken.md': '---\ntitle: [unclosed\n---\n',
    })
    const entries = await cms.listEntries('posts')
    expect(entries.map((e) => [e.slug, e.label])).toEqual([
      ['a', 'Alpha'],
      ['b', 'Beta'],
      ['broken', 'broken'],
    ])
  })

  it('returns no entries when the folder does not exist', async () => {
    const { cms } = setup({ 'README.md': 'hi' })
    expect(await cms.listEntries('posts')).toEqual([])
  })

  it('reads an entry with the body under the body field', async () => {
    const { cms } = setup({ 'content/posts/a.md': '---\ntitle: Alpha\n---\n\nHello\n' })
    const entry = await cms.readEntry('posts', 'a')
    expect(entry.data).toEqual({ title: 'Alpha', body: 'Hello\n' })
    expect(entry.issues).toEqual([])
  })

  it('reports schema issues of stored content', async () => {
    const { cms } = setup({ 'content/posts/a.md': '---\ntitle: ""\n---\n' })
    const entry = await cms.readEntry('posts', 'a')
    expect(entry.issues.map((issue) => issue.path)).toEqual([['title']])
  })

  it('creates an entry as one commit', async () => {
    const { cms, provider } = setup({ 'README.md': 'hi' })
    const result = await cms.saveEntry('posts', {
      slug: 'hello',
      data: { title: 'Hello', date: '2024-05-01', body: '# Hi' },
    })
    expect(result.path).toBe('content/posts/hello.md')
    expect(provider.text('content/posts/hello.md')).toBe(
      '---\ntitle: Hello\ndate: 2024-05-01\ndraft: false\n---\n\n# Hi\n',
    )
    expect(provider.commits.at(-1)?.message).toBe('Create content/posts/hello.md')
  })

  it('refuses to overwrite an existing entry when creating', async () => {
    const { cms } = setup({ 'content/posts/hello.md': '---\ntitle: Old\n---\n' })
    await expect(
      cms.saveEntry('posts', { slug: 'hello', data: { title: 'New', body: '' } }),
    ).rejects.toThrow(/already exists/)
  })

  it('keeps frontmatter keys the schema does not know about', async () => {
    const { cms, provider } = setup({
      'content/posts/a.md': '---\ntitle: Alpha\nlayout: wide\n---\nOld body\n',
    })
    await cms.saveEntry('posts', { slug: 'a', previousSlug: 'a', data: { title: 'Alpha 2', body: 'New body' } })
    expect(provider.text('content/posts/a.md')).toBe(
      '---\ntitle: Alpha 2\nlayout: wide\ndraft: false\n---\n\nNew body\n',
    )
    expect(provider.commits.at(-1)?.message).toBe('Update content/posts/a.md')
  })

  it('renames when the slug changes', async () => {
    const { cms, provider } = setup({ 'content/posts/a.md': '---\ntitle: Alpha\n---\nBody\n' })
    await cms.saveEntry('posts', { slug: 'alpha', previousSlug: 'a', data: { title: 'Alpha', body: 'Body' } })
    expect(provider.text('content/posts/a.md')).toBeUndefined()
    expect(provider.text('content/posts/alpha.md')).toContain('title: Alpha')
    expect(provider.commits.at(-1)?.message).toBe('Rename content/posts/a.md to content/posts/alpha.md')
  })

  it('deletes an entry', async () => {
    const { cms, provider } = setup({ 'content/posts/a.md': 'x', 'content/posts/b.md': 'y' })
    await cms.deleteEntry('posts', 'a')
    expect(provider.text('content/posts/a.md')).toBeUndefined()
    expect((await cms.listEntries('posts')).map((e) => e.slug)).toEqual(['b'])
  })

  it('validates before writing anything', async () => {
    const { cms, provider } = setup({ 'README.md': 'hi' })
    await expect(cms.saveEntry('posts', { slug: 'x', data: { title: '' } })).rejects.toBeInstanceOf(
      ContentValidationError,
    )
    expect(provider.commits).toHaveLength(0)
    expect(cms.fs.status()).toEqual([])
  })

  it('rejects slugs that escape the folder', async () => {
    const { cms } = setup()
    await expect(
      cms.saveEntry('posts', { slug: '../../evil', data: { title: 'x', body: '' } }),
    ).rejects.toThrow(/Invalid slug/)
  })

  it('discards staged changes when a commit fails', async () => {
    const { cms, provider } = setup({ 'README.md': 'hi' })
    provider.commit = async () => {
      throw new Error('boom')
    }
    await expect(
      cms.saveEntry('posts', { slug: 'x', data: { title: 'X', body: '' } }),
    ).rejects.toThrow('boom')
    expect(cms.fs.status()).toEqual([])
  })

  it('runs concurrent saves one after another', async () => {
    const { cms, provider } = setup({ 'README.md': 'hi' })
    await Promise.all([
      cms.saveEntry('posts', { slug: 'one', data: { title: 'One', body: '' } }),
      cms.saveEntry('posts', { slug: 'two', data: { title: 'Two', body: '' } }),
    ])
    expect(provider.commits.map((c) => c.changes.map((change) => change.path))).toEqual([
      ['content/posts/one.md'],
      ['content/posts/two.md'],
    ])
  })
})

describe('GitCms singletons', () => {
  it('reads a missing singleton as empty', async () => {
    const { cms } = setup({ 'README.md': 'hi' })
    expect(await cms.readSingleton('settings')).toEqual({
      path: 'data/site.json',
      exists: false,
      data: {},
      issues: [],
    })
  })

  it('creates and updates a singleton', async () => {
    const { cms, provider } = setup({ 'README.md': 'hi' })
    await cms.saveSingleton('settings', { title: 'My site' })
    expect(provider.text('data/site.json')).toBe('{\n  "title": "My site"\n}\n')
    expect(provider.commits.at(-1)?.message).toBe('Create data/site.json')

    await cms.saveSingleton('settings', { title: 'Renamed', description: 'Hi' })
    expect(JSON.parse(provider.text('data/site.json')!)).toEqual({ title: 'Renamed', description: 'Hi' })
    expect(provider.commits.at(-1)?.message).toBe('Update data/site.json')
  })
})

describe('content type definitions', () => {
  it('fills in defaults', () => {
    expect(posts).toMatchObject({
      kind: 'collection',
      folder: 'content/posts',
      format: 'markdown',
      extension: 'md',
      bodyField: 'body',
      slugField: 'title',
    })
    expect(settings).toMatchObject({ kind: 'singleton', format: 'json' })
  })

  it('rejects duplicate names', () => {
    const fs = new GitFS({ provider: new MemoryProvider(), branch: 'main' })
    expect(() => createCms({ fs, collections: [posts], singletons: [{ ...settings, name: 'posts' }] })).toThrow(
      /Duplicate/,
    )
  })
})
