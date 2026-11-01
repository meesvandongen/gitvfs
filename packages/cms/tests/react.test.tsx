import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS, type GitProvider, type RepositoryInfo } from 'gitvfs'
import { z } from 'zod'
import { createCms, defineCollection, defineSingleton, geoCircle, geoPoint, geoPolygon, markdown, reference, references } from '../src'
import {
  CmsApp,
  CmsProvider,
  DocumentEditor,
  RepositoryPicker,
  applyMarkdownFormat,
  buildPreviewDocument,
  pruneBlankOptionals,
  toDateInputValue,
  unsetMissingOptionals,
} from '../src/react'
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

describe('map fields', () => {
  const places = defineCollection({
    name: 'places',
    label: 'Places',
    folder: 'places',
    format: 'yaml',
    schema: z.object({
      title: z.string().min(1),
      location: geoPoint({ label: 'Location' }),
      delivery: geoCircle({ label: 'Delivery range', maxRadius: 5000 }).optional(),
      area: geoPolygon({ label: 'Area' }).optional(),
      // An ordinary optional group: left blank, it must not block saving.
      contact: z.object({ phone: z.string().min(1) }).optional(),
    }),
  })

  function setupPlaces(file: string) {
    const remote = new MemoryRepository({ 'places/shop.yml': file })
    const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [places] })
    act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
    return remote
  }

  async function openShop() {
    const entry = await waitFor(() => byText('Shopshop'))
    await act(async () => entry.click())
    return waitFor(() => container.querySelector<HTMLInputElement>('input[id="location"]'))
  }

  function pointer(target: Element, type: string, x: number, y: number) {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }))
  }

  it('edits coordinates by typing, pasting and clicking the map', async () => {
    const remote = setupPlaces('title: Shop\nlocation:\n  lat: 52.3731\n  lng: 4.8922\n')
    const lat = await openShop()
    expect(lat.value).toBe('52.3731')
    const lng = container.querySelector<HTMLInputElement>('input[id="location-lng"]')!
    expect(lng.value).toBe('4.8922')
    expect(container.querySelector('.gcms-map-tile')?.getAttribute('src')).toMatch(/^https:\/\/tile\.openstreetmap\.org\/15\//)
    expect(container.querySelectorAll('.gcms-map-marker')).toHaveLength(1)
    // Untouched optional map fields stay empty instead of becoming invalid `{}` objects.
    expect(byText('Unsaved', 'span')).toBeUndefined()

    await act(async () => typeInto(lat, '52.09'))
    await act(async () => typeInto(lng, '5.12'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('places/shop.yml')).toBe('title: Shop\nlocation:\n  lat: 52.09\n  lng: 5.12\n')

    // A click without movement in the middle of the map picks the map's center.
    const viewport = container.querySelector('.gcms-map-viewport')!
    await act(async () => {
      pointer(viewport, 'pointerdown', 300, 160)
      pointer(viewport, 'pointerup', 300, 160)
    })
    expect(lat.value).toBe('52.09')
    expect(lng.value).toBe('5.12')
    // Dragging pans the map instead of moving the marker.
    await act(async () => {
      pointer(viewport, 'pointerdown', 300, 160)
      pointer(viewport, 'pointermove', 400, 160)
      pointer(viewport, 'pointerup', 400, 160)
    })
    expect(lng.value).toBe('5.12')
    await act(async () => {
      pointer(viewport, 'pointerdown', 300, 160)
      pointer(viewport, 'pointerup', 300, 160)
    })
    expect(Number(lng.value)).toBeLessThan(5.12)
  })

  it('places a circle and draws a polygon', async () => {
    const remote = setupPlaces('title: Shop\nlocation:\n  lat: 52.3731\n  lng: 4.8922\n')
    await openShop()

    const [, circleMap, areaMap] = [...container.querySelectorAll('.gcms-map-viewport')]
    await act(async () => {
      pointer(circleMap, 'pointerdown', 300, 160)
      pointer(circleMap, 'pointerup', 300, 160)
    })
    const radius = container.querySelector<HTMLInputElement>('input[id="delivery-radius"]')!
    expect(radius.value).toBe('1000')
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')!.max).toBe('5000')

    for (const [x, y] of [[250, 120], [350, 120], [300, 200], [280, 210]]) {
      await act(async () => {
        pointer(areaMap, 'pointerdown', x, y)
        pointer(areaMap, 'pointerup', x, y)
      })
    }
    expect(container.querySelector('polygon')).toBeTruthy()
    expect(byText('4 corners', 'summary')).toBeTruthy()
    await act(async () => byText('Remove last corner')!.click())
    expect(byText('3 corners', 'summary')).toBeTruthy()

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    const saved = remote.text('places/shop.yml')!
    expect(saved).toContain('delivery:\n  lat: 20\n  lng: 0\n  radius: 1000\n')
    expect(saved.match(/- lat: /g)).toHaveLength(3)
  })

  it('shows what is wrong with stored coordinates', async () => {
    setupPlaces('title: Shop\nlocation:\n  lat: 123\n  lng: 4.8922\n')
    await openShop()
    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Latitude is at most 90', 'p'))
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

  it('leaves missing optional groups empty, at any depth', () => {
    const schema = z.object({
      title: z.string(),
      place: z.object({ city: z.string(), pin: z.object({ lat: z.number() }).optional() }).optional(),
      seo: z.object({ title: z.string().optional() }),
    })
    const unset = unsetMissingOptionals(schema as never, { title: 'x', seo: {} })
    expect(unset).toEqual({ title: 'x', place: undefined, seo: { title: undefined } })
    expect('place' in unset).toBe(true)
    expect(unsetMissingOptionals(schema as never, { place: { city: 'A' } }).place).toEqual({ city: 'A', pin: undefined })

    // What the form holds once AutoForm's inputs for an untouched group have mounted.
    expect(pruneBlankOptionals(schema as never, { title: 'x', place: { city: '', pin: {} }, seo: { title: undefined } }))
      .toEqual({ title: 'x', place: undefined, seo: { title: undefined } })
    expect(pruneBlankOptionals(schema as never, { place: { city: 'A', pin: { lat: undefined } } }))
      .toEqual({ place: { city: 'A', pin: undefined } })
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

describe('reference fields', () => {
  const authors = defineCollection({
    name: 'authors',
    label: 'Authors',
    folder: 'authors',
    format: 'json',
    labelField: 'name',
    slugField: 'name',
    schema: z.object({ name: z.string().min(1), role: z.string().optional() }),
  })
  const articles = defineCollection({
    name: 'articles',
    label: 'Articles',
    folder: 'articles',
    format: 'yaml',
    schema: z.object({
      title: z.string().min(1),
      author: reference({ collection: 'authors', label: 'Author', display: ['role'] }),
      reviewer: reference({ collection: 'authors', label: 'Reviewer' }).optional(),
      related: references({ collection: 'articles', label: 'Related', max: 2 }).default([]),
    }),
  })

  const files = {
    'authors/ada.json': '{ "name": "Ada Lovelace", "role": "editor" }\n',
    'authors/grace.json': '{ "name": "Grace Hopper", "role": "writer" }\n',
    'articles/one.yml': 'title: One\nauthor: ada\n',
    'articles/two.yml': 'title: Two\nauthor: grace\n',
    'articles/three.yml': 'title: Three\nauthor: alan\nrelated: [one, gone]\n',
  }

  let confirmations: string[] = []
  let answer = false
  const originalConfirm = window.confirm
  beforeEach(() => {
    confirmations = []
    answer = false
    window.confirm = (message) => {
      confirmations.push(String(message))
      return answer
    }
  })
  afterEach(() => {
    window.confirm = originalConfirm
  })

  function setupArticles() {
    const remote = new MemoryRepository(files)
    const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [articles, authors] })
    act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
    return { remote, cms }
  }

  async function open(label: string) {
    const entry = await waitFor(() => [...container.querySelectorAll<HTMLElement>('.gcms-entry')].find((el) => el.querySelector('.gcms-entry-label')?.textContent === label))
    await act(async () => entry.click())
    return waitFor(() => container.querySelector<HTMLInputElement>('input[id="author"]'))
  }

  const key = (element: Element, name: string) =>
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  const options = () => [...container.querySelectorAll('#author ~ .gcms-ref-popup [role="option"]')].map((el) => el.firstChild?.textContent)

  it('picks an entry with the keyboard and opens it', async () => {
    const { remote, cms } = setupArticles()
    const listEntries = vi.spyOn(cms, 'listEntries')
    const author = await open('One')
    await waitFor(() => author.value === 'Ada Lovelace')
    expect(byText('editor · ada', 'p')).toBeTruthy()
    expect(author.getAttribute('role')).toBe('combobox')
    // Both author fields share one listing of the collection.
    expect(listEntries.mock.calls.filter(([name]) => name === 'authors')).toHaveLength(1)

    await act(async () => author.focus())
    await act(async () => typeInto(author, 'hop'))
    expect(author.getAttribute('aria-expanded')).toBe('true')
    expect(options()).toEqual(['Grace Hopper'])
    await act(async () => key(author, 'ArrowDown'))
    await act(async () => key(author, 'Enter'))
    expect(author.value).toBe('Grace Hopper')
    expect(author.getAttribute('aria-expanded')).toBe('false')

    // Escape restores the picked entry after typing.
    await act(async () => typeInto(author, 'zzz'))
    expect(byText('No matching entries.', 'p')).toBeTruthy()
    await act(async () => key(author, 'Escape'))
    await act(async () => key(author, 'Escape'))
    expect(author.value).toBe('Grace Hopper')

    // Opening another entry asks before dropping unsaved changes.
    const openGrace = () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Grace Hopper"]')!.click()
    await act(async () => openGrace())
    expect(confirmations).toEqual(['Leave this document? Your unsaved changes are lost.'])
    expect(container.querySelector('input[id="author"]')).toBe(author)

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('articles/one.yml')).toBe('title: One\nauthor: grace\nrelated: []\n')

    await act(async () => openGrace())
    expect(confirmations).toHaveLength(1)
    const name = await waitFor(() => container.querySelector<HTMLInputElement>('input[name="name"]'))
    expect(name.value).toBe('Grace Hopper')
  })

  it('warns about missing entries without blocking saves', async () => {
    const { remote } = setupArticles()
    const author = await open('Three')
    const warning = await waitFor(() => container.querySelector('.gcms-warning'))
    expect(warning.textContent).toContain('Authors has no entry “alan”.')
    expect(author.getAttribute('aria-describedby')).toBe(warning.id)
    expect(author.value).toBe('alan')
    expect(container.querySelector('.gcms-ref-item--missing .gcms-ref-item-label')?.textContent).toBe('gone')
    expect(byText('One picked entry no longer exists. They may have been renamed or deleted: remove them or pick others.', 'p')).toBeTruthy()

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('articles/three.yml')).toBe('title: Three\nauthor: alan\nrelated:\n  - one\n  - gone\n')

    await act(async () => byText('Clear')!.click())
    expect(author.value).toBe('')
    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Required', 'p'))
    expect(remote.commits).toHaveLength(1)
  })

  it('adds, reorders and removes entries of a list', async () => {
    const { remote } = setupArticles()
    await open('Two')
    const related = container.querySelector<HTMLInputElement>('input[id="related"]')!
    const listed = () => [...container.querySelectorAll('.gcms-ref-item-label')].map((el) => el.textContent)

    await act(async () => related.focus())
    await act(async () => key(related, 'ArrowDown'))
    const relatedOptions = () => [...container.querySelectorAll('#related ~ .gcms-ref-popup [role="option"]')]
    await waitFor(() => relatedOptions().length === 3)
    await act(async () => (relatedOptions()[1] as HTMLElement).click()) // Three (sorted by label)
    await act(async () => key(related, 'ArrowDown'))
    // Entries already in the list are not offered again.
    expect(relatedOptions().map((el) => el.firstChild?.textContent)).toEqual(['One', 'Two'])
    await act(async () => key(related, 'Enter'))
    expect(listed()).toEqual(['Three', 'One'])

    // The maximum is two.
    await act(async () => key(related, 'ArrowDown'))
    expect(byText('The maximum of 2 is reached; remove one to add another.', 'p')).toBeTruthy()
    expect(relatedOptions()).toHaveLength(0)

    const up = container.querySelector<HTMLButtonElement>('button[aria-label="Move One up"]')!
    await act(async () => up.click())
    expect(listed()).toEqual(['One', 'Three'])
    // Focus stays with the moved item; at the top, on its other move button.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move One down')
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Moved One to position 1 of 2.')

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('articles/two.yml')).toBe('title: Two\nauthor: grace\nrelated:\n  - one\n  - three\n')

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove One"]')!.click())
    expect(listed()).toEqual(['Three'])
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove Three')
  })

  it('names the entries that reference an entry before deleting it', async () => {
    setupArticles()
    await act(async () => (await waitFor(() => byText('Authors'))).click())
    await act(async () => (await waitFor(() => byText('Ada Lovelaceada'))).click())
    await waitFor(() => container.querySelector('input[name="name"]'))
    await act(async () => byText('Delete')!.click())
    await waitFor(() => confirmations.length === 1)
    expect(confirmations[0]).toBe('Delete authors/ada.json? This creates a commit.\n\nReferenced by 1 entry: “One”. Their references will point at a missing entry.')

    // Renaming breaks references too.
    const slug = container.querySelector<HTMLInputElement>('input[id$="-slug"]')!
    await act(async () => typeInto(slug, 'ada-lovelace'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => confirmations.length === 2)
    expect(confirmations[1]).toBe('Referenced by 1 entry: “One”. Renaming “ada” to “ada-lovelace” breaks those references. Rename anyway?')
  })

  it('picks entries of several collections as { collection, slug }', async () => {
    const home = defineSingleton({
      name: 'home',
      label: 'Homepage',
      path: 'home.yml',
      schema: z.object({ highlight: reference({ collection: ['articles', 'authors'], label: 'Highlight' }).optional() }),
    })
    const remote = new MemoryRepository({ ...files, 'home.yml': 'highlight:\n  collection: authors\n  slug: grace\n' })
    const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [articles, authors], singletons: [home] })
    act(() => root.render(<CmsApp cms={cms} view={{ type: 'singleton', name: 'home' }} />))

    const highlight = await waitFor(() => container.querySelector<HTMLInputElement>('input[id="highlight"]'))
    await waitFor(() => highlight.value === 'Grace Hopper')
    expect(byText('Authors · grace', 'p')).toBeTruthy()
    await act(async () => highlight.focus())
    await act(async () => typeInto(highlight, 'o'))
    const listed = [...container.querySelectorAll('[role="option"]')].map((el) => el.lastChild?.textContent)
    expect(listed).toEqual(['Articles · one', 'Articles · two', 'Authors · ada', 'Authors · grace'])
    await act(async () => key(highlight, 'Enter'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('home.yml')).toBe('highlight:\n  collection: articles\n  slug: one\n')
  })

  it('works without CmsApp, without links to other entries', async () => {
    const remote = new MemoryRepository(files)
    const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [articles, authors] })
    act(() =>
      root.render(
        <CmsProvider cms={cms}>
          <DocumentEditor contentType={articles} slug="one" />
        </CmsProvider>,
      ),
    )
    const author = await waitFor(() => container.querySelector<HTMLInputElement>('input[id="author"]'))
    await waitFor(() => author.value === 'Ada Lovelace')
    expect(byText('Open')).toBeUndefined()
    expect(byText('Clear')).toBeTruthy()
  })
})
