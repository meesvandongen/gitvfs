import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS, type GitProvider, type RepositoryInfo } from 'gitvfs'
import { z } from 'zod'
import { createCms, defineCollection, defineSingleton, markdown } from '../src'
import { CmsApp, RepositoryPicker, applyMarkdownFormat, buildPreviewDocument, toDateInputValue } from '../src/react'
import { MemoryRepository } from './helpers/memory-repository'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  folder: 'posts',
  schema: z.object({
    title: z.string().min(1),
    draft: z.boolean().default(false),
    body: z.string().check(markdown()).default(''),
  }),
})

const settings = defineSingleton({
  name: 'settings',
  label: 'Site settings',
  path: 'site.yml',
  schema: z.object({ title: z.string() }),
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function waitFor<T>(find: () => T | null | undefined, timeout = 2000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for element')
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
}

function byText(text: string, selector = 'button'): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text)
}

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function setup() {
  const remote = new MemoryRepository({
    'posts/hello.md': '---\ntitle: Hello\n---\n\nSome **bold** text\n',
    'site.yml': 'title: Demo\n',
  })
  const cms = createCms({
    fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }),
    collections: [posts],
    singletons: [settings],
  })
  act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
  return remote
}

describe('CmsApp', () => {
  it('lists entries and edits one with a live preview', async () => {
    const remote = setup()

    const entry = await waitFor(() => byText('Hellohello'))
    await act(async () => entry.click())

    const title = await waitFor(() => container.querySelector<HTMLInputElement>('input[name="title"]'))
    expect(title.value).toBe('Hello')
    const body = container.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!
    expect(body.value).toBe('Some **bold** text\n')

    const frame = await waitFor(() => container.querySelector('iframe'))
    expect(frame.getAttribute('sandbox')).toBe('')
    await waitFor(() => frame.getAttribute('srcdoc')?.includes('<strong>bold</strong>'))

    await act(async () => typeInto(title, 'Hello again'))
    await waitFor(() => container.querySelector('iframe')?.getAttribute('srcdoc')?.includes('Hello again'))
    expect(byText('Unsaved', 'span')).toBeTruthy()

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('posts/hello.md')).toBe('---\ntitle: Hello again\ndraft: false\n---\n\nSome **bold** text\n')
  })

  it('creates an entry with a slug derived from the title', async () => {
    const remote = setup()

    await act(async () => (await waitFor(() => byText('New'))).click())
    const title = await waitFor(() => container.querySelector<HTMLInputElement>('input[name="title"]'))
    await act(async () => typeInto(title, 'Brand New Post'))

    const slug = container.querySelector<HTMLInputElement>('input[id$="-slug"]')!
    expect(slug.value).toBe('brand-new-post')

    await act(async () => byText('Create')!.click())
    await waitFor(() => remote.text('posts/brand-new-post.md'))
    expect(remote.commits.at(-1)?.message).toBe('Create posts/brand-new-post.md')
    await waitFor(() => byText('Brand New Postbrand-new-post'))
  })

  it('shows validation errors instead of committing', async () => {
    const remote = setup()

    await act(async () => (await waitFor(() => byText('New'))).click())
    await waitFor(() => container.querySelector('input[name="title"]'))
    await act(async () => byText('Create')!.click())
    await waitFor(() => container.querySelector('.gcms-field .gcms-error'))
    expect(remote.commits).toHaveLength(0)
  })

  it('edits a singleton and shows its source', async () => {
    const remote = setup()

    await act(async () => (await waitFor(() => byText('Site settings'))).click())
    const title = await waitFor(() => container.querySelector<HTMLInputElement>('input[name="title"]'))
    expect(title.value).toBe('Demo')
    expect(byText('Preview')).toBeUndefined()
    expect(container.querySelector('.gcms-source')?.textContent).toBe('title: Demo\n')

    await act(async () => typeInto(title, 'Renamed'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.text('site.yml') === 'title: Renamed\n')
  })
})

describe('CmsApp changes', () => {
  async function setupChanges(
    changes: Parameters<typeof createCms>[0]['changes'] = true,
    prepare?: (remote: MemoryRepository) => Promise<void>,
  ) {
    const remote = new MemoryRepository({
      'posts/hello.md': '---\ntitle: Hello\n---\n\nSome **bold** text\n',
      'posts/other.md': '---\ntitle: Other\n---\n',
      'site.yml': 'title: Demo\n',
    })
    await prepare?.(remote)
    const cms = createCms({
      fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }),
      collections: [posts],
      singletons: [settings],
      changes,
    })
    act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
    return { remote, cms }
  }

  const select = () => container.querySelector<HTMLSelectElement>('.gcms-change-switcher select')!

  it('edits in a change, marks and reverts changed fields, compares, and publishes', async () => {
    const { remote, cms } = await setupChanges()

    // Start a change from the sidebar.
    await act(async () => (await waitFor(() => byText('New change'))).click())
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Name of the change"]')!, 'Spring update'))
    await act(async () => byText('Start')!.click())
    await waitFor(() => cms.getState().inChange)
    expect(select().value).toBe('cms/spring-update')
    await waitFor(() => byText('Review & publish'))

    // Edit an entry: the title is marked as changed and can be reverted.
    await act(async () => (await waitFor(() => byText('Hellohello'))).click())
    const title = await waitFor(() => container.querySelector<HTMLInputElement>('input[name="title"]'))
    expect(container.querySelector('.gcms-change')).toBeNull()
    await act(async () => typeInto(title, 'Hello spring'))
    const marker = await waitFor(() => container.querySelector<HTMLElement>('.gcms-change'))
    expect(marker.title).toBe('On main: “Hello”')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Revert title to main"]')!.click())
    await waitFor(() => title.value === 'Hello' && !container.querySelector('.gcms-change'))

    await act(async () => typeInto(title, 'Hello spring'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.text('posts/hello.md', 'cms/spring-update')?.includes('Hello spring'))
    expect(remote.text('posts/hello.md')).toContain('title: Hello\n')

    // The entry list and the nav show what changed.
    await waitFor(() => byText('Hello springEditedhello'))
    await waitFor(() => byText('Posts1'))

    // Compare: side by side previews, and the source diff.
    await act(async () => byText('Changes')!.click())
    await waitFor(() => container.querySelectorAll('.gcms-compare-side iframe').length === 2)
    const [before, after] = [...container.querySelectorAll('.gcms-compare-side iframe')].map((frame) => frame.getAttribute('srcdoc'))
    expect(before).toContain('<h1>Hello</h1>')
    expect(after).toContain('<h1>Hello spring</h1>')
    await act(async () => byText('Source changes')!.click())
    const diff = [...container.querySelectorAll('.gcms-diff-line--removed, .gcms-diff-line--added')].map((line) => line.textContent)
    expect(diff).toEqual(['−Removed: title: Hello\n', '+Added: title: Hello spring\n'])

    // Review, open a pull request, and publish it.
    await act(async () => byText('Review & publish1')!.click())
    await waitFor(() => byText('EditedHello springPosts · posts/hello.md'))
    await act(async () => (await waitFor(() => byText('Open pull request'))).click())
    await waitFor(() => remote.pulls.length === 1)
    expect(remote.pulls[0]).toMatchObject({ title: 'Spring update', head: 'cms/spring-update', base: 'main' })
    const publish = await waitFor(() => byText('Publish'))
    Object.defineProperty(window, 'confirm', { value: () => true, configurable: true })
    await act(async () => publish.click())
    await waitFor(() => !cms.getState().inChange)
    expect(remote.text('posts/hello.md')).toContain('title: Hello spring')
    expect(remote.branches.has('cms/spring-update')).toBe(false)
    await waitFor(() => select().value === '')
    expect(byText('Review & publish')).toBeUndefined()
  })

  it('keeps main read-only when changes are required', async () => {
    const { remote } = await setupChanges({ required: true })
    expect((await waitFor(() => byText('New'))).hasAttribute('disabled')).toBe(true)
    await act(async () => (await waitFor(() => byText('Site settings'))).click())
    await waitFor(() => container.querySelector('input[name="title"]'))
    expect(byText('Save')!.hasAttribute('disabled')).toBe(true)
    expect(container.querySelector('.gcms-notice')?.textContent).toContain('Start a change')
    expect(remote.commits).toHaveLength(0)
  })

  it('switches to an existing change and marks entries that are new in it', async () => {
    const { cms } = await setupChanges(true, async (remote) => {
      await remote.createBranch('cms/draft', remote.branches.get('main')!.sha)
      await remote.commit({ branch: 'cms/draft', message: 'Draft', changes: [{ action: 'create', path: 'posts/draft.md', content: '---\ntitle: Draft\n---\n' }] })
    })

    await waitFor(() => [...select().options].some((option) => option.value === 'cms/draft'))
    await act(async () => {
      select().value = 'cms/draft'
      select().dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitFor(() => cms.getState().branch === 'cms/draft')
    await act(async () => (await waitFor(() => byText('DraftNewdraft'))).click())
    await waitFor(() => byText('New in this change', 'span'))
    // Fields of a new entry are not each marked as changed.
    expect(container.querySelector('.gcms-change')).toBeNull()
  })
})

describe('editor helpers', () => {
  it('wraps the selection or a placeholder', () => {
    expect(applyMarkdownFormat('make this bold', 5, 9, { kind: 'wrap', before: '**', after: '**', placeholder: 'x' }))
      .toEqual({ value: 'make **this** bold', selectionStart: 7, selectionEnd: 11 })
    expect(applyMarkdownFormat('', 0, 0, { kind: 'wrap', before: '_', after: '_', placeholder: 'italic' }).value)
      .toBe('_italic_')
  })

  it('prefixes the current line', () => {
    expect(applyMarkdownFormat('one\ntwo', 5, 5, { kind: 'line', prefix: '## ' }).value).toBe('one\n## two')
  })

  it('normalizes date input values', () => {
    expect(toDateInputValue(new Date('2024-05-01T00:00:00Z'))).toBe('2024-05-01')
    expect(toDateInputValue('2024-05-01T10:00:00Z')).toBe('2024-05-01')
    expect(toDateInputValue(undefined)).toBe('')
  })

  it('locks down the preview document', () => {
    const html = buildPreviewDocument({ html: '<p>x</p>', stylesheets: ['/site.css"><script>'] })
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('href="/site.css&quot;&gt;&lt;script&gt;"')
    expect(html).not.toContain('<script>')
  })
})

describe('RepositoryPicker', () => {
  const info = (fullName: string, description: string | null = null): RepositoryInfo => ({
    fullName,
    name: fullName.split('/')[1],
    owner: fullName.split('/')[0],
    defaultBranch: 'main',
    private: fullName.startsWith('acme/'),
    description,
    webUrl: `https://github.com/${fullName}`,
    updatedAt: null,
  })

  function fakeProvider(list: () => AsyncIterable<RepositoryInfo>): GitProvider & { calls: number } {
    const provider = {
      name: 'fake',
      calls: 0,
      listRepositories() {
        provider.calls++
        return list()
      },
      repository: () => {
        throw new Error('not used')
      },
    }
    return provider
  }

  it('lists, searches and picks repositories', async () => {
    const provider = fakeProvider(async function* () {
      yield info('acme/site', 'The marketing site')
      yield info('acme/api')
      yield info('ada/notes')
    })
    const picked: string[] = []
    act(() =>
      root.render(
        <RepositoryPicker
          provider={provider}
          // An inline filter must not restart loading on every render.
          filter={(repo) => repo.fullName !== 'acme/api'}
          onSelect={(repo) => picked.push(repo.fullName)}
        />,
      ),
    )

    await waitFor(() => byText('ada/notes'))
    expect([...container.querySelectorAll('.gcms-picker-item')].map((el) => el.textContent)).toEqual([
      'acme/siteprivateThe marketing site',
      'ada/notes',
    ])

    typeInto(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'MARKETING')
    await waitFor(() => !byText('ada/notes') || undefined)
    act(() => container.querySelector<HTMLButtonElement>('.gcms-picker-item')!.click())
    expect(picked).toEqual(['acme/site'])
    expect(provider.calls).toBe(1)
    expect(byText('Cancel')).toBeUndefined()
  })

  it('offers Cancel when onCancel is given', async () => {
    let cancelled = 0
    const provider = fakeProvider(async function* () {
      yield info('acme/site')
    })
    act(() => root.render(<RepositoryPicker provider={provider} onSelect={() => {}} onCancel={() => cancelled++} />))
    act(() => byText('Cancel')!.click())
    expect(cancelled).toBe(1)
  })

  it('shows errors and retries', async () => {
    let fail = true
    const provider = fakeProvider(async function* () {
      if (fail) throw new Error('Authentication failed: 401')
      yield info('acme/site')
    })
    act(() => root.render(<RepositoryPicker provider={provider} onSelect={() => {}} />))
    const alert = await waitFor(() => container.querySelector('[role="alert"]'))
    expect(alert.textContent).toContain('Authentication failed: 401')

    fail = false
    act(() => byText('Try again')!.click())
    await waitFor(() => byText('acme/siteprivate'))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
