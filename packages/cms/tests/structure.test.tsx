import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS } from 'gitvfs'
import { z } from 'zod'
import { createCms, defineSingleton, field, table, tree } from '../src'
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

function byLabel(label: string): HTMLElement | undefined {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? undefined
}

function typeInto(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(target: Element, name: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
}

function paste(target: Element, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
  target.dispatchEvent(event)
}

function open(files: Record<string, string>, singleton: ReturnType<typeof defineSingleton>) {
  const remote = new MemoryRepository(files)
  const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), singletons: [singleton] })
  act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
  return remote
}

async function save(remote: MemoryRepository, commits = 1) {
  await act(async () => byText('Save')!.click())
  await waitFor(() => remote.commits.length === commits)
}

describe('table fields', () => {
  const pricing = defineSingleton({
    name: 'pricing',
    label: 'Pricing',
    path: 'pricing.yml',
    schema: z.object({
      plans: z
        .array(
          z.object({
            name: z.string().min(1).check(field({ label: 'Plan' })),
            price: z.number().min(0, 'Price cannot be negative').check(field({ label: 'Price' })),
            featured: z.boolean().default(false),
            billing: z.enum(['monthly', 'yearly']).optional(),
            features: z.array(z.string()).default([]),
          }),
        )
        .default([])
        .check(table({ label: 'Plans' })),
    }),
  })

  const seed = `plans:
  - name: Free
    price: 0
    featured: false
    features:
      - 1 site
  - name: Pro
    price: 12
    featured: true
    billing: monthly
`

  async function openPricing(file = seed) {
    const remote = open({ 'pricing.yml': file }, pricing)
    await act(async () => (await waitFor(() => byText('Pricing'))).click())
    await waitFor(() => container.querySelector('table'))
    return remote
  }

  const cell = (row: number, column: number) => container.querySelector<HTMLInputElement>(`[data-row="${row}"][data-col="${column}"]`)!

  it('renders a grid with labeled columns and a read-only column', async () => {
    await openPricing()
    const table = container.querySelector('table')!
    expect(table.getAttribute('aria-label')).toBe('Plans')
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Row',
      'Plan *',
      'Price *',
      'Featured',
      'Billing',
      'Features (read-only)',
      'Actions',
    ])
    expect(cell(0, 0).value).toBe('Free')
    expect(cell(1, 1).value).toBe('12')
    expect(cell(1, 2).checked).toBe(true)
    expect((cell(1, 3) as unknown as HTMLSelectElement).value).toBe('monthly')
    expect(container.querySelector('.gcms-table-static')!.textContent).toBe('1 item')
    expect(cell(0, 0).getAttribute('aria-label')).toBe('Plan, row 1')
    expect(byText('Unsaved', 'span')).toBeUndefined()
  })

  it('edits, adds, moves and deletes rows', async () => {
    const remote = await openPricing()
    await act(async () => typeInto(cell(1, 1), '15'))
    await act(async () => byText('Add row')!.click())
    // The new row's first cell gets focus.
    expect(document.activeElement).toBe(cell(2, 0))
    await act(async () => typeInto(cell(2, 0), 'Team'))
    await act(async () => typeInto(cell(2, 1), '49'))
    await act(async () => byLabel('Move row 3 up')!.click())
    expect(cell(1, 0).value).toBe('Team')
    await act(async () => byLabel('Delete row 1')!.click())
    expect(cell(0, 0).value).toBe('Team')

    await save(remote)
    expect(remote.text('pricing.yml')).toBe(`plans:
  - name: Team
    price: 49
    featured: false
    features: []
  - name: Pro
    price: 15
    featured: true
    billing: monthly
    features: []
`)
  })

  it('moves between cells with the keyboard', async () => {
    await openPricing()
    const first = cell(0, 0)
    first.focus()
    await act(async () => key(first, 'ArrowDown'))
    expect(document.activeElement).toBe(cell(1, 0))
    // Left and right leave a text cell only from the edge of its text.
    cell(1, 0).setSelectionRange(1, 1)
    await act(async () => key(cell(1, 0), 'ArrowRight'))
    expect(document.activeElement).toBe(cell(1, 0))
    cell(1, 0).setSelectionRange(3, 3)
    await act(async () => key(cell(1, 0), 'ArrowRight'))
    expect(document.activeElement).toBe(cell(1, 1))
    // Alt+Up moves the row, and focus goes with it.
    await act(async () => key(cell(1, 1), 'ArrowUp', { altKey: true }))
    expect(cell(0, 0).value).toBe('Pro')
    expect(document.activeElement).toBe(cell(0, 1))
    // Enter goes down, and adds a row from the last one.
    await act(async () => key(cell(0, 1), 'Enter'))
    expect(document.activeElement).toBe(cell(1, 1))
    await act(async () => key(cell(1, 1), 'Enter'))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(document.activeElement).toBe(cell(2, 1))
  })

  it('pastes cells from a spreadsheet and copies rows as CSV', async () => {
    const remote = await openPricing()
    // A block copied from a spreadsheet, pasted into the price of the second row.
    await act(async () => paste(cell(1, 1), '20\tyes\n30\tno\n'))
    expect(cell(1, 1).value).toBe('20')
    expect(cell(2, 1).value).toBe('30')
    expect(cell(2, 2).checked).toBe(false)
    expect(byText('Pasted 2 rows', 'span')).toBeTruthy()

    // A header row maps columns by name, wherever the paste lands.
    await act(async () => paste(byText('Add row')!, 'Price,Plan\n99,"Enterprise, yearly"\n'))
    expect(cell(3, 0).value).toBe('Enterprise, yearly')
    expect(cell(3, 1).value).toBe('99')

    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => (copied = text) }, configurable: true })
    await act(async () => byText('Copy as CSV')!.click())
    expect(copied.split('\n')).toEqual([
      'name,price,featured,billing,features',
      'Free,0,false,,"[""1 site""]"',
      'Pro,20,true,monthly,',
      ',30,false,,[]',
      '"Enterprise, yearly",99,false,,[]',
    ])
    await waitFor(() => byText('Copied 4 rows as CSV', 'span'))

    await act(async () => typeInto(cell(2, 0), 'Team'))
    await save(remote)
    expect(remote.text('pricing.yml')).toContain('  - name: Enterprise, yearly\n    price: 99\n')
  })

  it('shows errors in the cells they belong to', async () => {
    const remote = await openPricing('plans:\n  - name: Free\n    price: -1\n')
    await act(async () => byText('Add row')!.click())
    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Price cannot be negative', 'span'))
    expect(cell(0, 1).getAttribute('aria-invalid')).toBe('true')
    expect(cell(0, 1).getAttribute('aria-describedby')).toBe(container.querySelector('.gcms-table-error')!.id)
    // The new row misses its required name and price.
    expect(container.querySelectorAll('tbody tr')[1].querySelectorAll('.gcms-table-error')).toHaveLength(2)
    expect(remote.commits).toHaveLength(0)

    await act(async () => typeInto(cell(0, 1), 'abc'))
    await waitFor(() => byText('Enter a number', 'span'))
  })
})

describe('tree fields', () => {
  const navigation = defineSingleton({
    name: 'navigation',
    label: 'Navigation',
    path: 'navigation.yml',
    schema: z.object({
      menu: tree({ label: 'Menu', fields: { label: z.string().min(1), href: z.string().optional() }, maxDepth: 3 }).default([]),
    }),
  })

  const seed = `menu:
  - label: Home
    href: /
  - label: Docs
    href: /docs
    children:
      - label: Guides
        href: /docs/guides
      - label: API
        href: /docs/api
  - label: Blog
    href: /blog
`

  async function openNavigation(file = seed) {
    const remote = open({ 'navigation.yml': file }, navigation)
    await act(async () => (await waitFor(() => byText('Navigation'))).click())
    await waitFor(() => container.querySelector('[role="tree"]'))
    return remote
  }

  const items = () => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
  const item = (label: string) => items().find((el) => el.querySelector('.gcms-tree-label')?.textContent === label)!
  const outline = () => items().map((el) => `${'  '.repeat(Number(el.getAttribute('aria-level')) - 1)}${el.querySelector('.gcms-tree-label')!.textContent}`)

  it('renders an ARIA tree and navigates it with the keyboard', async () => {
    await openNavigation()
    expect(container.querySelector('[role="tree"]')!.getAttribute('aria-label')).toBe('Menu')
    expect(outline()).toEqual(['Home', 'Docs', '  Guides', '  API', 'Blog'])
    expect(item('Docs').getAttribute('aria-expanded')).toBe('true')
    expect(item('Home').hasAttribute('aria-expanded')).toBe(false)
    expect(item('Guides').getAttribute('aria-posinset')).toBe('1')
    expect(item('Guides').getAttribute('aria-setsize')).toBe('2')
    // One tab stop: the first item.
    expect(items().map((el) => el.tabIndex)).toEqual([0, -1, -1, -1, -1])

    item('Home').focus()
    await act(async () => key(item('Home'), 'ArrowDown'))
    expect(document.activeElement).toBe(item('Docs'))
    await act(async () => key(item('Docs'), 'ArrowLeft'))
    expect(item('Docs').getAttribute('aria-expanded')).toBe('false')
    expect(outline()).toEqual(['Home', 'Docs', 'Blog'])
    await act(async () => key(item('Docs'), 'ArrowRight'))
    await act(async () => key(item('Docs'), 'ArrowRight'))
    expect(document.activeElement).toBe(item('Guides'))
    await act(async () => key(item('Guides'), 'ArrowLeft'))
    expect(document.activeElement).toBe(item('Docs'))
    await act(async () => key(item('Docs'), 'End'))
    expect(document.activeElement).toBe(item('Blog'))
  })

  it('moves, indents and outdents items like an outliner', async () => {
    const remote = await openNavigation()
    item('Guides').focus()
    await act(async () => key(item('Guides'), 'ArrowLeft', { altKey: true }))
    expect(outline()).toEqual(['Home', 'Docs', '  API', 'Guides', 'Blog'])
    expect(document.activeElement).toBe(item('Guides'))
    await act(async () => key(item('Guides'), 'ArrowUp', { altKey: true }))
    expect(outline()).toEqual(['Home', 'Guides', 'Docs', '  API', 'Blog'])
    // Indent Blog under Docs with the button.
    await act(async () => item('Blog').querySelector<HTMLElement>('.gcms-tree-row')!.click())
    await act(async () => byLabel('Indent: Blog')!.click())
    expect(outline()).toEqual(['Home', 'Guides', 'Docs', '  API', '  Blog'])
    expect(document.activeElement).toBe(item('Blog'))

    await save(remote)
    expect(remote.text('navigation.yml')).toBe(`menu:
  - label: Home
    href: /
  - label: Guides
    href: /docs/guides
  - label: Docs
    href: /docs
    children:
      - label: API
        href: /docs/api
      - label: Blog
        href: /blog
`)
  })

  it('adds, edits inline and deletes items', async () => {
    const remote = await openNavigation()
    await act(async () => item('Blog').querySelector<HTMLElement>('.gcms-tree-row')!.click())
    await act(async () => byLabel('Add child: Blog')!.click())
    const label = await waitFor(() => (document.activeElement instanceof HTMLInputElement ? document.activeElement : null))
    await act(async () => typeInto(label, 'Archive'))
    await act(async () => key(label, 'Enter'))
    expect(container.querySelector('.gcms-tree-editor')).toBeNull()
    expect(document.activeElement).toBe(item('Archive'))
    expect(item('Archive').getAttribute('aria-level')).toBe('2')

    // Deleting an item with children asks first.
    await act(async () => item('Docs').querySelector<HTMLElement>('.gcms-tree-row')!.click())
    await act(async () => key(item('Docs'), 'Delete'))
    expect(byText('Delete with 2 nested items?', 'span')).toBeTruthy()
    expect(outline()).toContain('Docs')
    await act(async () => byText('Delete')!.click())
    expect(outline()).toEqual(['Home', 'Blog', '  Archive'])

    await save(remote)
    expect(remote.text('navigation.yml')).toBe(`menu:
  - label: Home
    href: /
  - label: Blog
    href: /blog
    children:
      - label: Archive
`)
  })

  it('drags an item to a new place', async () => {
    await openNavigation()
    const row = (label: string) => item(label).querySelector<HTMLElement>('.gcms-tree-row')!
    await act(async () => row('Home').dispatchEvent(new Event('dragstart', { bubbles: true })))
    // Without layout the drop lands after the row under the pointer.
    await act(async () => row('API').dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true })))
    expect(row('API').className).toContain('gcms-tree-drop--after')
    await act(async () => row('API').dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })))
    expect(outline()).toEqual(['Docs', '  Guides', '  API', '  Home', 'Blog'])
  })

  it('respects maxDepth and shows errors per item', async () => {
    const remote = await openNavigation(`menu:
  - label: A
    children:
      - label: B
        children:
          - label: C
`)
    await act(async () => item('C').querySelector<HTMLElement>('.gcms-tree-row')!.click())
    expect(byLabel('Add child: C')!.getAttribute('aria-disabled')).toBe('true')
    expect(byLabel('Indent: C')!.getAttribute('aria-disabled')).toBe('true')

    await act(async () => byText('Add item')!.click())
    await act(async () => byText('Save')!.click())
    const problem = await waitFor(() => container.querySelector('.gcms-tree-problems li'))
    expect(problem.textContent).toBe('Untitled: Required')
    expect(item('Untitled').querySelector('.gcms-tree-flag')).toBeTruthy()
    expect(remote.commits).toHaveLength(0)
  })
})
