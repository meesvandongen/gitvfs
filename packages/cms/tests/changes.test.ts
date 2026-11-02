import { GitVFS } from 'gitvfs'
import { z } from 'zod'
import { changeBranchName, changeTitle, createCms, defineCollection, defineSingleton, diffLines, markdown, valueAt, valuesEqual } from '../src'
import { MemoryRepository } from './helpers/memory-repository'

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  folder: 'content/posts',
  schema: z.object({ title: z.string().min(1), body: z.string().check(markdown()).default('') }),
})

const settings = defineSingleton({
  name: 'settings',
  label: 'Site settings',
  path: 'data/site.json',
  schema: z.object({ title: z.string() }),
})

function setup(changes: Parameters<typeof createCms>[0]['changes'] = true) {
  const remote = new MemoryRepository({
    'content/posts/hello.md': '---\ntitle: Hello\n---\n\nHi\n',
    'content/posts/old.md': '---\ntitle: Old news\n---\n',
    'data/site.json': '{"title":"Site"}\n',
    'README.md': '# Site\n',
  })
  const cms = createCms({
    fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }),
    collections: [posts],
    singletons: [settings],
    changes,
  })
  return { remote, cms }
}

describe('changes', () => {
  it('starts a change on its own branch and leaves main alone until published', async () => {
    const { remote, cms } = setup()
    const seen: number[] = []
    cms.subscribe(() => seen.push(cms.getState().version))

    expect(await cms.startChange('Spring update!')).toBe('cms/spring-update')
    expect(cms.getState()).toMatchObject({ base: 'main', branch: 'cms/spring-update', inChange: true })

    await cms.saveEntry('posts', { slug: 'hello', previousSlug: 'hello', data: { title: 'Hello, spring', body: 'Hi\n' } })
    await cms.saveEntry('posts', { slug: 'spring', data: { title: 'Spring is here', body: '' } })
    await cms.deleteEntry('posts', 'old')
    remote.branches.get('cms/spring-update')!.files.set('README.md', { sha: 'readme-2', content: new TextEncoder().encode('# New\n') })

    expect(remote.text('content/posts/hello.md')).toBe('---\ntitle: Hello\n---\n\nHi\n')
    expect((await cms.readEntry('posts', 'hello')).data.title).toBe('Hello, spring')
    expect((await cms.readBaseEntry('posts', 'hello'))?.data.title).toBe('Hello')
    expect(await cms.readBaseEntry('posts', 'spring')).toBeNull()
    expect((await cms.readBaseSingleton('settings'))?.data).toEqual({ title: 'Site' })

    const changed = await cms.changedContent()
    expect(changed.map(({ path, status, slug, label, contentType }) => ({ path, status, slug, label, type: contentType?.name }))).toEqual([
      { path: 'content/posts/hello.md', status: 'modified', slug: 'hello', label: 'Hello, spring', type: 'posts' },
      { path: 'content/posts/old.md', status: 'removed', slug: 'old', label: 'Old news', type: 'posts' },
      { path: 'content/posts/spring.md', status: 'added', slug: 'spring', label: 'Spring is here', type: 'posts' },
      { path: 'README.md', status: 'modified', label: 'README.md', type: undefined },
    ])

    const pull = await cms.openPullRequest({ body: 'For the new season' })
    expect(pull).toMatchObject({ title: 'Spring update', head: 'cms/spring-update', base: 'main', state: 'open' })
    expect(await cms.pullRequest()).toMatchObject({ number: pull.number })
    expect(await cms.listChanges()).toEqual([{ branch: 'cms/spring-update', title: 'Spring update', pullRequest: pull }])

    await cms.publishChange()
    expect(remote.text('content/posts/hello.md')).toContain('Hello, spring')
    expect(remote.text('content/posts/spring.md')).toContain('Spring is here')
    expect(remote.text('content/posts/old.md')).toBeUndefined()
    expect(remote.pulls[0].state).toBe('merged')
    expect(remote.branches.has('cms/spring-update')).toBe(false)
    expect(cms.getState()).toMatchObject({ branch: 'main', inChange: false })
    expect((await cms.readEntry('posts', 'hello')).data.title).toBe('Hello, spring')

    // Every commit and branch switch was announced, in order.
    expect(seen).toEqual(seen.map((_, index) => index + 1))
    expect(seen.length).toBeGreaterThanOrEqual(6)
  })

  it('switches between changes and back to main', async () => {
    const { cms } = setup()
    await cms.startChange('First')
    await cms.saveEntry('posts', { slug: 'first', data: { title: 'First' } })
    await cms.switchTo(null)
    await expect(cms.readEntry('posts', 'first')).rejects.toThrow()
    await cms.switchTo('cms/first')
    expect((await cms.readEntry('posts', 'first')).data.title).toBe('First')
    expect(await cms.startChange('First')).toBe('cms/first-2')
    expect((await cms.listChanges()).map((change) => change.branch)).toEqual(['cms/first', 'cms/first-2'])
  })

  it('brings published work into a change, and reports conflicts', async () => {
    const { remote, cms } = setup()
    await cms.startChange('Mine')
    await cms.saveEntry('posts', { slug: 'hello', previousSlug: 'hello', data: { title: 'Mine' } })
    expect(await cms.updateChange()).toBeNull()

    await remote.commit({ branch: 'main', message: 'Elsewhere', changes: [{ action: 'create', path: 'content/posts/other.md', content: '---\ntitle: Other\n---\n' }] })
    expect(await cms.updateChange()).not.toBeNull()
    expect((await cms.readEntry('posts', 'other')).data.title).toBe('Other')
    expect((await cms.changedContent()).map((change) => change.slug)).toEqual(['hello'])

    await remote.commit({ branch: 'main', message: 'Clash', changes: [{ action: 'update', path: 'content/posts/hello.md', content: '---\ntitle: Theirs\n---\n' }] })
    await expect(cms.updateChange()).rejects.toThrow(/conflict/i)
  })

  it('discards a change with its pull request', async () => {
    const { remote, cms } = setup()
    await cms.startChange('Nope')
    await cms.saveSingleton('settings', { title: 'Nope' })
    expect((await cms.changedContent())[0]).toMatchObject({ label: 'Site settings', status: 'modified' })
    await cms.openPullRequest()
    await cms.discardChange()
    expect(remote.pulls[0].state).toBe('closed')
    expect(remote.branches.has('cms/nope')).toBe(false)
    expect(cms.getState().inChange).toBe(false)
    expect(remote.text('data/site.json')).toBe('{"title":"Site"}\n')
  })

  it('keeps main read-only when changes are required', async () => {
    const { remote, cms } = setup({ required: true, branchPrefix: 'edits/' })
    expect(cms.canEdit()).toBe(false)
    await expect(cms.saveSingleton('settings', { title: 'Direct' })).rejects.toThrow('Start a change')
    expect(remote.text('data/site.json')).toBe('{"title":"Site"}\n')
    // A failed save leaves nothing staged behind.
    expect(cms.fs.status()).toEqual([])

    expect(await cms.startChange('Allowed')).toBe('edits/allowed')
    expect(cms.canEdit()).toBe(true)
    await cms.saveSingleton('settings', { title: 'Allowed' })
    expect(remote.text('data/site.json', 'edits/allowed')).toContain('Allowed')
  })

  it('refuses change operations when changes are off', async () => {
    const { cms } = setup(false)
    expect(cms.changes).toBeNull()
    await expect(cms.startChange('x')).rejects.toThrow('Changes are not enabled')
    await expect(cms.listChanges()).rejects.toThrow('Changes are not enabled')
    expect(await cms.changedContent()).toEqual([])
  })
})

describe('change helpers', () => {
  it('names branches and titles changes', () => {
    expect(changeBranchName('cms/', 'Spring update')).toBe('cms/spring-update')
    expect(changeBranchName('cms/', '!!!')).toBe('cms/change')
    expect(changeTitle('cms/', 'cms/spring-update')).toBe('Spring update')
    expect(changeTitle('cms/', 'feature/x')).toBe('Feature x')
  })

  it('compares form values by content', () => {
    expect(valuesEqual({ a: 1, b: [1, { c: '' }] }, { b: [1, {}], a: 1 })).toBe(true)
    expect(valuesEqual(undefined, '')).toBe(true)
    expect(valuesEqual(null, undefined)).toBe(true)
    expect(valuesEqual(new Date('2024-05-01T00:00:00Z'), '2024-05-01')).toBe(true)
    expect(valuesEqual('a', 'b')).toBe(false)
    expect(valuesEqual([1, 2], [2, 1])).toBe(false)
    expect(valueAt({ author: { name: 'Ada' }, tags: ['x', 'y'] }, 'author.name')).toBe('Ada')
    expect(valueAt({ tags: ['x', 'y'] }, 'tags.1')).toBe('y')
    expect(valueAt({ tags: null }, 'tags.1')).toBeUndefined()
  })

  it('diffs lines', () => {
    const lines = (diff: ReturnType<typeof diffLines>) => diff.map((line) => `${{ same: ' ', added: '+', removed: '-' }[line.kind]}${line.text}`)
    expect(lines(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n'))).toEqual([' a', '-b', '+B', ' c', '+d'])
    expect(lines(diffLines('', 'x\n'))).toEqual(['+x'])
    expect(lines(diffLines('x\n', ''))).toEqual(['-x'])
    expect(lines(diffLines('same\n', 'same\n'))).toEqual([' same'])
    expect(lines(diffLines('a\nb\nc\nd', 'a\nx\ny\nd'))).toEqual([' a', '-b', '-c', '+x', '+y', ' d'])
  })
})
