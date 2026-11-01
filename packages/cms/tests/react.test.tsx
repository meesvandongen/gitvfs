import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitFS, type GitProvider, type RepositoryInfo } from 'gitvfs'
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
    fs: new GitFS({ repository: remote, branch: 'main', cache: 'none' }),
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
