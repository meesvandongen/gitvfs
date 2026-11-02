import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS, type GitProvider, type RepositoryInfo } from 'gitvfs'
import { z } from 'zod'
import { createCms, defineCollection, defineSingleton, geoCircle, geoPoint, geoPolygon, graph, markdown } from '../src'
import {
  CmsApp,
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

describe('graph fields', () => {
  const flows = defineCollection({
    name: 'flows',
    label: 'Flows',
    folder: 'flows',
    format: 'yaml',
    schema: z.object({
      title: z.string().min(1),
      flow: graph({ label: 'Flow', nodeFields: { note: z.string().optional() }, edgeFields: { role: z.enum(['agent', 'lead']).optional() } }),
    }),
  })

  const file = `title: Help
flow:
  nodes:
    - id: start
      label: Start
      x: 0
      y: 0
    - id: done
      label: Done
      x: 0
      y: 120
  edges:
    - from: start
      to: done
`

  async function openHelp(source = file) {
    const remote = new MemoryRepository({ 'flows/help.yml': source })
    const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [flows] })
    act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
    const entry = await waitFor(() => byText('Helphelp'))
    await act(async () => entry.click())
    await waitFor(() => container.querySelector('.gcms-graph'))
    return remote
  }

  const nodeElement = (id: string) => container.querySelector<SVGGElement>(`[data-node="${id}"]`)!

  /** Screen position of a node's center, from the canvas and node transforms. */
  function screenOf(id: string) {
    const [ox, oy, zoom] = container.querySelector('.gcms-graph-svg > g')!.getAttribute('transform')!.match(/-?[\d.]+/g)!.map(Number)
    const [x, y] = nodeElement(id).getAttribute('transform')!.match(/-?[\d.]+/g)!.map(Number)
    return { x: ox + x * zoom, y: oy + y * zoom }
  }

  function pointer(target: Element, type: string, at: { x: number; y: number }) {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: at.x, clientY: at.y }))
  }

  function key(target: Element, name: string) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  }

  function choose(select: HTMLSelectElement, value: string) {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  it('adds, connects, moves and deletes nodes on the canvas', async () => {
    const remote = await openHelp()
    expect(container.querySelectorAll('[data-node]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(1)
    expect(container.querySelector('.gcms-graph-arrow')).toBeTruthy()

    // A new node gets its label input focused; its id follows the label while it is new.
    await act(async () => byText('Add node')!.click())
    const label = container.querySelector<HTMLInputElement>('.gcms-graph-panel input')!
    expect(document.activeElement).toBe(label)
    expect(label.value).toBe('New node')
    await act(async () => typeInto(label, 'Escalate'))
    expect(nodeElement('escalate')).toBeTruthy()

    // Drag from the handle of "Done" and drop on "Escalate".
    const viewport = container.querySelector('.gcms-graph-viewport')!
    await act(async () => {
      pointer(container.querySelector('[data-handle="done"]')!, 'pointerdown', screenOf('done'))
      pointer(viewport, 'pointermove', screenOf('escalate'))
      pointer(viewport, 'pointerup', screenOf('escalate'))
    })
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(2)
    expect(byText('From', 'span')).toBeTruthy()

    // Arrow keys move the focused node by one grid step; Delete removes it with its edges.
    await act(async () => key(nodeElement('done'), 'ArrowRight'))
    expect(nodeElement('done').getAttribute('transform')).toBe('translate(20 120)')
    await act(async () => key(nodeElement('start'), 'Delete'))
    expect(nodeElement('start')).toBeNull()
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(1)

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('flows/help.yml')).toBe(`title: Help
flow:
  nodes:
    - id: done
      label: Done
      x: 20
      y: 120
    - id: escalate
      label: Escalate
      x: 0
      y: 60
  edges:
    - from: done
      to: escalate
`)
  })

  it('edits labels, edges and node fields in the list view', async () => {
    const remote = await openHelp()
    await act(async () => byText('List')!.click())
    expect(container.querySelector('.gcms-graph-viewport')).toBeNull()

    // Existing nodes keep their id when the label changes.
    const first = container.querySelector<HTMLInputElement>('input[aria-label="Label of node 1"]')!
    await act(async () => typeInto(first, 'Begin'))
    expect(byText('start', 'code')).toBeTruthy()

    await act(async () => choose(container.querySelector<HTMLSelectElement>('select[aria-label="New edge from"]')!, 'done'))
    await act(async () => choose(container.querySelector<HTMLSelectElement>('select[aria-label="New edge to"]')!, 'start'))
    await act(async () => byText('Add edge')!.click())
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Label of edge 2"]')!, 'retry'))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove edge 1"]')!.click())

    // Declared node fields are edited with the regular inputs in the panel.
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Edit Done"]')!.click())
    const note = await waitFor(() => container.querySelector<HTMLInputElement>('.gcms-graph-panel input[name$=".note"]'))
    await act(async () => typeInto(note, 'Close the ticket'))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Edit edge 1"]')!.click())
    const role = await waitFor(() => container.querySelector<HTMLSelectElement>('.gcms-graph-panel select[name$=".role"]'))
    await act(async () => choose(role, 'agent'))

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('flows/help.yml')).toBe(`title: Help
flow:
  nodes:
    - id: start
      label: Begin
      x: 0
      y: 0
    - id: done
      label: Done
      x: 0
      y: 120
      note: Close the ticket
  edges:
    - from: done
      to: start
      label: retry
      role: agent
`)

    // Clearing an optional field removes its key, and the input stays empty.
    await act(async () => choose(container.querySelector<HTMLSelectElement>('.gcms-graph-panel select[name$=".role"]')!, ''))
    expect(container.querySelector<HTMLSelectElement>('.gcms-graph-panel select[name$=".role"]')!.value).toBe('')
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 2)
    expect(remote.text('flows/help.yml')).toMatch(/label: retry\n$/)
  })

  it('shows broken references and lays out nodes without positions', async () => {
    const remote = await openHelp('title: Help\nflow:\n  nodes:\n    - id: a\n      label: A\n    - id: b\n      label: B\n  edges:\n    - from: a\n      to: ghost\n')
    // Missing positions are filled in by auto layout.
    expect(nodeElement('a').getAttribute('transform')).toBe('translate(40 20)')
    expect(nodeElement('b').getAttribute('transform')).toBe('translate(160 20)')

    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Edge a → ghost: No node has the id “ghost”', 'li'))
    expect(remote.commits).toHaveLength(0)

    await act(async () => byText('List')!.click())
    expect(byText('ghost (missing)', 'option')).toBeTruthy()
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove edge 1"]')!.click())
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('flows/help.yml')).toContain('    - id: b\n      label: B\n      x: 160\n      y: 20\n  edges: []\n')
  })
})
