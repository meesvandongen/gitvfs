import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS } from 'gitvfs'
import { z } from 'zod'
import { createCms, datetime, defineCollection, duration, field, geoPoint, money, phone, slider, time } from '../src'
import { CmsApp } from '../src/react'
import { MemoryRepository } from './helpers/memory-repository'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function input(selector: string): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(selector)
  if (!element) throw new Error(`No ${selector}`)
  return element
}

function typeInto(element: HTMLInputElement | HTMLSelectElement, value: string, event = 'input') {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event(event, { bubbles: true }))
}

const shows = defineCollection({
  name: 'shows',
  label: 'Shows',
  folder: 'shows',
  format: 'yaml',
  schema: z.object({
    title: z.string().min(1),
    id: z.string().check(field({ label: 'ID', readOnly: true })),
    importedFrom: z.string().optional().check(field({ hidden: true })),
    starts: datetime({ label: 'Starts', timeZone: 'Europe/Amsterdam' }),
    doors: time({ label: 'Doors' }).optional(),
    volume: z.number().int().min(0).max(100).check(slider({ label: 'Volume', unit: '%' })),
    price: money({ label: 'Price', currencies: ['EUR', 'USD'] }),
    runtime: duration({ label: 'Runtime' }),
    boxOffice: phone({ label: 'Box office', defaultCountryCode: '31' }).optional(),
    venue: geoPoint({ label: 'Venue', readOnly: true }).optional(),
  }),
})

const SHOW = `title: Show
id: show-001
importedFrom: legacy.csv
starts: 2026-11-20T19:30:00+01:00
doors: "18:45"
volume: 40
price:
  amount: 25
  currency: EUR
runtime: PT1H30M
venue:
  lat: 52.37
  lng: 4.9
`

async function openShow(file = SHOW) {
  const remote = new MemoryRepository({ 'shows/show.yml': file })
  const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [shows] })
  act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
  const entry = await waitFor(() => byText('Showshow'))
  await act(async () => entry.click())
  await waitFor(() => container.querySelector('input[name="starts"]'))
  return remote
}

async function save(remote: MemoryRepository) {
  const commits = remote.commits.length
  await act(async () => byText('Save')!.click())
  await waitFor(() => remote.commits.length > commits)
  return remote.text('shows/show.yml')!
}

describe('basic input fields', () => {
  it('shows stored values and saves them unchanged', async () => {
    const remote = await openShow()
    expect(input('input[name="starts"]').value).toBe('2026-11-20T19:30')
    expect(container.querySelector('#starts-zone')?.textContent).toBe(
      'Time in Europe/Amsterdam (UTC+01:00). Saved as 2026-11-20T19:30:00+01:00',
    )
    expect(input('input[name="doors"]').value).toBe('18:45')
    expect(input('input[type="range"]').value).toBe('40')
    expect(input('input[id="volume-value"]').value).toBe('40')
    expect(input('input[name="price"]').value).toBe('25.00')
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Currency"]')!.value).toBe('EUR')
    expect(container.querySelector('output')?.textContent).toMatch(/25\.00/)
    expect(input('input[name="runtime"]').value).toBe('1')
    expect(input('input[id="runtime-minutes"]').value).toBe('30')
    expect(byText('1 hour, 30 minutes, saved as PT1H30M', 'p')).toBeTruthy()
    expect(byText('Unsaved', 'span')).toBeUndefined()

    expect(await save(remote)).toBe(SHOW)
  })

  it('edits every field and stores the documented formats', async () => {
    const remote = await openShow()
    await act(async () => typeInto(input('input[name="starts"]'), '2026-07-01T20:00'))
    await act(async () => typeInto(input('input[name="doors"]'), '19:15'))
    await act(async () => typeInto(input('input[type="range"]'), '55'))
    expect(input('input[id="volume-value"]').value).toBe('55')
    await act(async () => typeInto(input('input[name="price"]'), '19,5'))
    await act(async () => typeInto(container.querySelector('select')!, 'USD', 'change'))
    await act(async () => typeInto(input('input[id="runtime-minutes"]'), '45'))
    await act(async () => typeInto(input('input[name="boxOffice"]'), '020 123 4567'))
    expect(byText('Saved as +31201234567', 'p')?.querySelector('a')?.getAttribute('href')).toBe('tel:+31201234567')

    const saved = await save(remote)
    expect(saved).toContain('starts: 2026-07-01T20:00:00+02:00\n')
    expect(saved).toContain('doors: "19:15"\n')
    expect(saved).toContain('volume: 55\n')
    expect(saved).toContain('price:\n  amount: 19.5\n  currency: USD\n')
    expect(saved).toContain('runtime: PT1H45M\n')
    expect(saved).toContain('boxOffice: "+31201234567"\n')
    // Hidden and read-only values are kept.
    expect(saved).toContain('id: show-001\nimportedFrom: legacy.csv\n')
    expect(saved).toContain('venue:\n  lat: 52.37\n  lng: 4.9\n')
  })

  it('removes optional values that are cleared', async () => {
    const remote = await openShow(SHOW.replace('runtime: PT1H30M\n', 'runtime: PT1H30M\nboxOffice: "+31201234567"\n'))
    expect(input('input[name="boxOffice"]').value).toBe('+31201234567')
    await act(async () => typeInto(input('input[name="doors"]'), ''))
    await act(async () => typeInto(input('input[name="boxOffice"]'), ''))
    expect(input('input[name="doors"]').value).toBe('')
    const saved = await save(remote)
    expect(saved).not.toContain('doors')
    expect(saved).not.toContain('boxOffice')
  })

  it('renders read-only fields disabled and leaves hidden ones out', async () => {
    await openShow()
    const id = input('input[name="id"]')
    expect(id.value).toBe('show-001')
    expect(id.closest('fieldset')?.disabled).toBe(true)
    expect(container.querySelector('[name="importedFrom"]')).toBeNull()

    // The read-only map shows the venue but ignores clicks.
    const lat = input('input[id="venue"]')
    expect(lat.closest('fieldset.gcms-readonly')).toBeTruthy()
    const viewport = container.querySelector('.gcms-map-viewport')!
    await act(async () => {
      for (const type of ['pointerdown', 'pointerup']) {
        viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: 20, clientY: 20 }))
      }
    })
    expect(lat.value).toBe('52.37')
  })

  it('explains what is wrong before saving', async () => {
    const remote = await openShow()
    await act(async () => typeInto(input('input[name="price"]'), '1.2345'))
    await act(async () => typeInto(input('input[id="runtime-minutes"]'), '1.5'))
    expect(byText('Use whole numbers', 'p')).toBeTruthy()
    await act(async () => typeInto(input('input[name="boxOffice"]'), '+12'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Use at most 2 decimals', 'p'))
    await waitFor(() => byText('Enter a valid phone number', 'p'))
    expect(remote.commits).toHaveLength(0)
  })
})
