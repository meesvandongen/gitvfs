import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS, type GitProvider, type RepositoryInfo } from 'gitvfs'
import { z } from 'zod'
import {
  createCms,
  defineCollection,
  defineSingleton,
  geoCircle,
  geoPoint,
  geoPoints,
  geoPolygon,
  markdown,
  reference,
  references,
  type Geocoder,
  type MapOptions,
} from '../src'
import {
  CmsApp,
  CmsProvider,
  DocumentEditor,
  RepositoryPicker,
  applyMarkdownFormat,
  buildPreviewDocument,
  pruneBlankOptionals,
  toDateInputValue,
  toSource,
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
      branches: geoPoints({ label: 'Branches', labels: true, maxPoints: 3 }).optional(),
      // An ordinary optional group: left blank, it must not block saving.
      contact: z.object({ phone: z.string().min(1) }).optional(),
    }),
  })

  function setupPlaces(file: string, mapDefaults?: MapOptions) {
    const remote = new MemoryRepository({ 'places/shop.yml': file })
    const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [places] })
    act(() => root.render(<CmsApp cms={cms} title="Test CMS" mapDefaults={mapDefaults} />))
    return remote
  }

  /** The map field labelled `label`. */
  function geoField(label: string): HTMLElement {
    const wrapper = [...container.querySelectorAll('.gcms-field')].find((el) => el.querySelector('label')?.textContent?.startsWith(label))
    return wrapper!.querySelector<HTMLElement>('.gcms-geo')!
  }

  function inField(field: HTMLElement, text: string, selector = 'button') {
    return [...field.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text)
  }

  function key(target: Element, name: string) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
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

  it('searches places and picks a result with the keyboard or the mouse', async () => {
    const queries: Array<{ query: string; signal: AbortSignal }> = []
    const geocoder: Geocoder = async (query, options) => {
      queries.push({ query, signal: options.signal })
      return [
        { label: 'Dam, Amsterdam', lat: 52.3731, lng: 4.8926, bounds: { south: 52.372, north: 52.374, west: 4.891, east: 4.894 } },
        { label: 'Utrecht Centraal', lat: 52.0894, lng: 5.1101 },
      ]
    }
    geocoder.attribution = 'Search by Test'
    const remote = setupPlaces('title: Shop\nlocation:\n  lat: 52.3731\n  lng: 4.8922\n', { geocoder })
    const lat = await openShop()

    const search = container.querySelector<HTMLInputElement>('input[id="location-search"]')!
    expect(search.getAttribute('role')).toBe('combobox')
    // Typing alone does not search.
    await act(async () => typeInto(search, 'station'))
    expect(queries).toHaveLength(0)
    await act(async () => key(search, 'Enter'))
    const options = await waitFor(() => {
      const found = container.querySelectorAll('[role="option"]')
      return found.length === 2 ? found : undefined
    })
    expect(queries[0].query).toBe('station')
    expect(queries[0].signal).toBeInstanceOf(AbortSignal)
    expect(search.getAttribute('aria-expanded')).toBe('true')
    expect(byText('Search by Test', 'p')).toBeTruthy()

    await act(async () => key(search, 'ArrowDown'))
    await act(async () => key(search, 'ArrowDown'))
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    expect(search.getAttribute('aria-activedescendant')).toBe(options[1].id)
    await act(async () => key(search, 'Enter'))
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(lat.value).toBe('52.0894')
    expect(container.querySelector<HTMLInputElement>('input[id="location-lng"]')!.value).toBe('5.1101')
    // Enter searched and chose; it did not submit the form.
    expect(remote.commits).toHaveLength(0)

    // A polygon only moves its map to the place.
    const areaSearch = container.querySelector<HTMLInputElement>('input[id="area-search"]')!
    await act(async () => typeInto(areaSearch, 'dam'))
    await act(async () => inField(geoField('Area'), 'Search')!.click())
    const dam = await waitFor(() => byText('Dam, Amsterdam', 'li'))
    await act(async () => dam.click())
    expect(container.querySelector('polygon')).toBeNull()
    expect(inField(geoField('Area'), '0 corners', 'summary')).toBeTruthy()

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('places/shop.yml')).toBe('title: Shop\nlocation:\n  lat: 52.0894\n  lng: 5.1101\n')
  })

  it('shows search failures', async () => {
    const geocoder: Geocoder = async () => {
      throw new Error('Address search failed (HTTP 503)')
    }
    setupPlaces('title: Shop\nlocation:\n  lat: 52.3731\n  lng: 4.8922\n', { geocoder })
    await openShop()
    const search = container.querySelector<HTMLInputElement>('input[id="location-search"]')!
    await act(async () => typeInto(search, 'nowhere'))
    await act(async () => key(search, 'Enter'))
    await waitFor(() => byText('Address search failed (HTTP 503)', 'p'))
  })

  it('edits several numbered, labelled markers', async () => {
    const remote = setupPlaces('title: Shop\nlocation:\n  lat: 52.3731\n  lng: 4.8922\nbranches:\n  - lat: 52.3731\n    lng: 4.8922\n    label: Centre\n')
    await openShop()
    const branches = geoField('Branches')
    const viewport = branches.querySelector('.gcms-map-viewport')!
    expect(branches.querySelector('.gcms-map-marker-badge')?.textContent).toBe('1')
    expect(branches.querySelector('.gcms-map-marker-caption')?.textContent).toBe('Centre')

    for (const [x, y] of [[200, 100], [400, 220]]) {
      await act(async () => {
        pointer(viewport, 'pointerdown', x, y)
        pointer(viewport, 'pointerup', x, y)
      })
    }
    expect([...branches.querySelectorAll('.gcms-map-marker-badge')].map((el) => el.textContent)).toEqual(['1', '2', '3'])
    expect(branches.textContent).toContain('The maximum of 3 markers is reached.')
    // Full: clicking the map adds nothing.
    await act(async () => {
      pointer(viewport, 'pointerdown', 300, 300)
      pointer(viewport, 'pointerup', 300, 300)
    })
    expect(branches.querySelectorAll('.gcms-map-marker')).toHaveLength(3)

    const labels = [...branches.querySelectorAll<HTMLInputElement>('.gcms-map-label input')]
    await act(async () => typeInto(labels[1], 'North'))
    expect(branches.querySelectorAll('.gcms-map-marker-caption')[1]?.textContent).toBe('North')
    await act(async () => branches.querySelector<HTMLButtonElement>('button[aria-label="Remove marker 3"]')!.click())

    // Drag the first marker to the east; its label stays.
    const [first] = branches.querySelectorAll('.gcms-map-marker')
    await act(async () => {
      pointer(first, 'pointerdown', 300, 160)
      pointer(first, 'pointermove', 340, 160)
      pointer(first, 'pointerup', 340, 160)
    })
    const lngs = [...branches.querySelectorAll<HTMLInputElement>('.gcms-map-points input')].filter((_, index) => index % 3 === 2)
    expect(Number(lngs[0].value)).toBeGreaterThan(4.8922)

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    const saved = remote.text('places/shop.yml')!
    expect(saved).toMatch(/branches:\n  - lat: 52\.3731\n    lng: 4\.89\d+\n    label: Centre\n  - lat: [\d.]+\n    lng: [\d.]+\n    label: North\n$/)
  })

  it('saves cleared optional lists as absent', async () => {
    const remote = setupPlaces(
      'title: Shop\nlocation:\n  lat: 52.3731\n  lng: 4.8922\narea:\n  - lat: 52.37\n    lng: 4.89\n  - lat: 52.38\n    lng: 4.9\n  - lat: 52.36\n    lng: 4.91\nbranches:\n  - lat: 52.3731\n    lng: 4.8922\n',
    )
    await openShop()
    await act(async () => inField(geoField('Area'), 'Clear')!.click())
    await act(async () => inField(geoField('Branches'), 'Remove last marker')!.click())
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('places/shop.yml')).toBe('title: Shop\nlocation:\n  lat: 52.3731\n  lng: 4.8922\n')
  })

  it('clears a stored point and a stored circle', async () => {
    const remote = setupPlaces('title: Shop\nlocation:\n  lat: 52.3731\n  lng: 4.8922\ndelivery:\n  lat: 52.3731\n  lng: 4.8922\n  radius: 900\n')
    const lat = await openShop()
    const [clearPoint, clearCircle] = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === 'Clear')
    await act(async () => clearCircle.click())
    expect(container.querySelector<HTMLInputElement>('input[id="delivery-radius"]')!.value).toBe('')
    await act(async () => clearPoint.click())
    expect(lat.value).toBe('')
    expect(container.querySelectorAll('.gcms-map-marker')).toHaveLength(0)
    // The required point is flagged instead of being saved.
    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Required', 'p'))
    expect(remote.commits).toHaveLength(0)

    // Placing the point again saves; the cleared optional circle is left out.
    const viewport = container.querySelector('.gcms-map-viewport')!
    await act(async () => {
      pointer(viewport, 'pointerdown', 300, 160)
      pointer(viewport, 'pointerup', 300, 160)
    })
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('places/shop.yml')).not.toContain('delivery')
  })

  it('shows what is wrong with stored coordinates', async () => {
    setupPlaces('title: Shop\nlocation:\n  lat: 123\n  lng: 4.8922\n')
    await openShop()
    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Latitude is at most 90', 'p'))
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

  it('leaves cleared (null) values out of the source', () => {
    expect(toSource(settings, { title: 'Demo', cleared: null, nested: { a: null, b: 1 } } as never)).toBe('title: Demo\nnested:\n  b: 1\n')
  })

  it('leaves optional groups left blank out of the source, as saving does', () => {
    const events = defineCollection({
      name: 'events',
      folder: 'events',
      format: 'yaml',
      schema: z.object({ title: z.string(), location: z.object({ venue: z.string(), city: z.string() }).optional() }),
    })
    expect(toSource(events, { title: 'Hours', location: { venue: undefined, city: '' } })).toBe('title: Hours\n')
    expect(toSource(events, { title: 'Hours', location: { venue: 'Hall', city: undefined } })).toBe('title: Hours\nlocation:\n  venue: Hall\n')
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
  // Defined rather than assigned: earlier tests may leave `confirm` read-only.
  const originalConfirm = Object.getOwnPropertyDescriptor(window, 'confirm')
  beforeEach(() => {
    confirmations = []
    answer = false
    const confirm = (message?: string) => {
      confirmations.push(String(message))
      return answer
    }
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true })
  })
  afterEach(() => {
    if (originalConfirm) Object.defineProperty(window, 'confirm', originalConfirm)
    else delete (window as { confirm?: unknown }).confirm
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

  it('edits references in a change: marks, reverts, saves on the branch and warns from it', async () => {
    const remote = new MemoryRepository(files)
    const cms = createCms({
      fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }),
      collections: [articles, authors],
      changes: true,
    })
    await act(async () => {
      await cms.startChange('New authors')
    })
    act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
    const author = await open('One')
    await waitFor(() => author.value === 'Ada Lovelace')
    expect(container.querySelector('.gcms-change')).toBeNull()

    await act(async () => byText('Clear')!.click())
    const marker = await waitFor(() => container.querySelector<HTMLElement>('.gcms-change'))
    expect(marker.title).toBe('On main: “ada”')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Revert author to main"]')!.click())
    await waitFor(() => author.value === 'Ada Lovelace' && !container.querySelector('.gcms-change'))

    await act(async () => author.focus())
    await act(async () => typeInto(author, 'grace'))
    await act(async () => key(author, 'Enter'))
    await waitFor(() => container.querySelector('.gcms-change'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.text('articles/one.yml', 'cms/new-authors') === 'title: One\nauthor: grace\nrelated: []\n')
    expect(remote.text('articles/one.yml')).toBe('title: One\nauthor: ada\n')

    // References are looked up on the change's branch: Grace is now used by One and Two there.
    await act(async () => byText('Authors')!.click())
    await act(async () => (await waitFor(() => byText('Grace Hoppergrace'))).click())
    await waitFor(() => container.querySelector('input[name="name"]'))
    await act(async () => byText('Delete')!.click())
    await waitFor(() => confirmations.length === 1)
    expect(confirmations[0]).toContain('Referenced by 2 entries: “One” and “Two”.')
  })
})
