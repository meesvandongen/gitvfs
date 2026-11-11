import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS } from 'gitvfs'
import { z } from 'zod'
import { createCms, defineCollection, defineSingleton, file, image, imagePath, type CmsOptions } from '../src'
import { CmsApp, type CmsView } from '../src/react'
import { MemoryRepository } from './helpers/memory-repository'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const png = (seed: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1])

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  folder: 'posts',
  schema: z.object({
    title: z.string().min(1),
    cover: image({ label: 'Cover', folder: 'public/images', publicPath: '/images', maxSize: 1000 }).optional(),
  }),
})
const site = defineSingleton({
  name: 'site',
  label: 'Site settings',
  path: 'site.json',
  schema: z.object({ logo: imagePath({ folder: 'public/images' }).optional(), menu: file({ folder: 'public/files', accept: '.pdf' }).optional() }),
})

const seed = {
  'posts/hello.md': '---\ntitle: Hello\ncover:\n  src: /images/team.png\n---\nThe ![team](/images/team.png).\n',
  'site.json': '{ "logo": "/images/team.png" }\n',
  'public/images/team.png': png(1),
  'public/images/unused.png': png(2),
  'public/files/menu.pdf': '%PDF-1.4',
}

let container: HTMLDivElement
let root: Root
let confirmations: string[] = []
let answer = true
const originalConfirm = Object.getOwnPropertyDescriptor(window, 'confirm')

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  confirmations = []
  answer = true
  const confirm = (message?: string) => {
    confirmations.push(String(message))
    return answer
  }
  Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (originalConfirm) Object.defineProperty(window, 'confirm', originalConfirm)
  else delete (window as { confirm?: unknown }).confirm
})

async function waitFor<T>(find: () => T | null | undefined | false, timeout = 2000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for element')
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
}

function byText(text: string, selector = 'button', scope: ParentNode = container): HTMLElement | undefined {
  return [...scope.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text)
}

function typeInto(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function pickFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}

const library = () => container.querySelector<HTMLElement>('.gcms-media-library')!
const tileNames = () => [...library().querySelectorAll('.gcms-media-grid .gcms-library-item .gcms-media-name')].map((el) => el.textContent)
const tile = (name: string) => [...library().querySelectorAll<HTMLElement>('.gcms-media-grid .gcms-library-item')].find((el) => el.querySelector('.gcms-media-name')?.textContent === name)
const panel = () => container.querySelector<HTMLElement>('.gcms-media-panel')
const status = () => library().querySelector('.gcms-document-header [role="status"]')!.textContent

function render(files: Record<string, string | Uint8Array> = seed, options: Partial<CmsOptions> = {}, onViewChange?: (view: CmsView) => void) {
  const remote = new MemoryRepository(files)
  const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [posts], singletons: [site], ...options })
  act(() => root.render(<CmsApp cms={cms} title="Test CMS" onViewChange={onViewChange} />))
  return { remote, cms }
}

async function openMedia() {
  const item = await waitFor(() => byText('Media'))
  await act(async () => item.click())
  await waitFor(() => tile('team.png'))
}

describe('media library view', () => {
  it('is in the sidebar only when there are media folders', async () => {
    const plain = defineCollection({ name: 'notes', folder: 'notes', schema: z.object({ title: z.string() }) })
    const cms = createCms({ fs: new GitVFS({ repository: new MemoryRepository({}), branch: 'main', cache: 'none' }), collections: [plain] })
    act(() => root.render(<CmsApp cms={cms} />))
    await waitFor(() => byText('notes'))
    expect(byText('Media')).toBeUndefined()
  })

  it('lists the files of each folder with sizes, filters them, and opens their details', async () => {
    const views: CmsView[] = []
    render(seed, {}, (view) => views.push(view))
    await openMedia()
    expect(byText('Media')!.getAttribute('aria-current')).toBe('page')
    expect(tileNames()).toEqual(['team.png', 'unused.png'])
    expect(tile('team.png')!.textContent).toContain('10 B')
    expect(tile('team.png')!.querySelector('img')!.src).toMatch(/^blob:/)

    // One folder per media folder, as pressed buttons.
    const folders = [...library().querySelectorAll<HTMLButtonElement>('.gcms-media-folder')]
    expect(folders.map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([['Images', 'true'], ['Files', 'false']])
    await act(async () => folders[1].click())
    await waitFor(() => tile('menu.pdf'))
    expect(tile('menu.pdf')!.querySelector('.gcms-file-icon')!.textContent).toBe('PDF')
    await act(async () => byText('Images', '.gcms-media-folder')!.click())
    await waitFor(() => tile('team.png'))

    await act(async () => typeInto(library().querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!, 'UNU'))
    expect(tileNames()).toEqual(['unused.png'])
    expect(library().textContent).toContain('1 of 2 files')
    await act(async () => typeInto(library().querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!, ''))

    await act(async () => tile('team.png')!.click())
    const details = await waitFor(() => panel())
    expect(tile('team.png')!.getAttribute('aria-current')).toBe('true')
    expect(details.getAttribute('aria-labelledby')).toBe(details.querySelector('h3')!.id)
    expect(details.querySelector('h3')!.textContent).toBe('team.png')
    expect([...details.querySelectorAll('dd code')].map((code) => code.textContent)).toEqual(['public/images/team.png', '/images/team.png'])
    expect(details.textContent).toContain('10 B')
    expect(views.at(-1)).toEqual({ type: 'media', folder: 'public/images', path: 'public/images/team.png' })

    // Escape closes the details.
    await act(async () => details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(panel()).toBeNull()
  })

  it('lists where a file is used, opens those documents, and warns before deleting it', async () => {
    const { remote } = render()
    await openMedia()
    await act(async () => tile('team.png')!.click())
    await waitFor(() => panel()?.querySelector('.gcms-media-usage-list'))
    const usage = panel()!.querySelector('.gcms-media-usage')!
    expect(usage.textContent).toContain('Used in 2 documents: “Hello” and “Site settings”.')
    expect([...usage.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Hello posts/hello.md · cover.src, body',
      'Site settings site.json · logo',
    ])

    // Cancelled: nothing happens.
    answer = false
    await act(async () => byText('Delete', 'button', panel()!)!.click())
    expect(confirmations[0]).toContain('Delete public/images/team.png? This creates a commit.')
    expect(confirmations[0]).toContain('Used in 2 documents: “Hello” and “Site settings”. They will point at a missing file.')
    expect(remote.commits).toHaveLength(0)

    // The link opens the entry.
    await act(async () => byText('Hello', 'button', usage)!.click())
    await waitFor(() => container.querySelector('input[name="title"]'))
    expect(container.querySelector<HTMLInputElement>('input[name="title"]')!.value).toBe('Hello')
  })

  it('deletes an unused file after a plain confirmation, in one commit', async () => {
    const { remote } = render()
    await openMedia()
    await act(async () => tile('unused.png')!.click())
    await waitFor(() => panel()?.textContent?.includes('No entry or singleton uses this file.'))
    await act(async () => byText('Delete', 'button', panel()!)!.click())
    expect(confirmations).toEqual(['Delete public/images/unused.png? This creates a commit.'])
    await waitFor(() => remote.commits.length === 1)
    expect(remote.commits[0].message).toBe('Delete public/images/unused.png')
    expect(remote.text('public/images/unused.png')).toBeUndefined()
    await waitFor(() => tileNames().length === 1)
    expect(tileNames()).toEqual(['team.png'])
    expect(panel()).toBeNull()
    expect(status()).toMatch(/^Deleted unused\.png in commit [0-9a-f]{7}\.$/)
  })

  it('uploads picked files in one commit, checking the folder’s limits', async () => {
    const { remote } = render()
    await openMedia()
    const input = library().querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.multiple).toBe(true)
    expect(input.accept).toBe('image/*')

    await pickFiles(input, [
      new File([png(3)], 'Team.png', { type: 'image/png' }),
      new File([png(4)], 'New Photo.PNG', { type: 'image/png' }),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    ])
    await waitFor(() => remote.commits.length === 1)
    expect(remote.commits[0].changes.map((change) => change.path).sort()).toEqual(['public/images/new-photo.png', 'public/images/team-2.png'])
    expect([...(await remote.getFile('main', 'public/images/team-2.png')).content]).toEqual([...png(3)])
    await waitFor(() => tileNames().length === 4)
    expect(tileNames()).toEqual(['new-photo.png', 'team-2.png', 'team.png', 'unused.png'])
    expect(library().querySelector('[role="alert"]')!.textContent).toContain('notes.txt is not an accepted type of file (image/*)')
    expect(status()).toMatch(/^Uploaded 2 files in commit [0-9a-f]{7}\.$/)

    // One file: uploaded and opened.
    await pickFiles(input, [new File([png(5)], 'logo.png', { type: 'image/png' })])
    await waitFor(() => remote.commits.length === 2)
    await waitFor(() => panel()?.querySelector('h3')?.textContent === 'logo.png')
    expect(remote.commits[1].message).toBe('Upload public/images/logo.png')
  })

  it('uploads files dropped on the view', async () => {
    const { remote } = render()
    await openMedia()
    const dataTransfer = { types: ['Files'], files: [new File([png(6)], 'dropped.png', { type: 'image/png' })], dropEffect: 'none' }
    const drag = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      return event
    }
    await act(async () => library().dispatchEvent(drag('dragover')))
    expect(library().querySelector('.gcms-media-drop')!.textContent).toBe('Drop to upload to public/images')
    await act(async () => library().dispatchEvent(drag('drop')))
    await waitFor(() => remote.commits.length === 1)
    expect(remote.commits[0].changes.map((change) => change.path)).toEqual(['public/images/dropped.png'])
    expect(library().querySelector('.gcms-media-drop')).toBeNull()
  })

  it('is read-only on the published branch, and commits to the change in a change', async () => {
    const { remote } = render(seed, { changes: { required: true } })
    await openMedia()
    expect(byText('Upload…')).toBeUndefined()
    expect(library().textContent).toContain('Start a change in the sidebar to upload or delete files.')
    await act(async () => tile('unused.png')!.click())
    await waitFor(() => panel()?.textContent?.includes('No entry or singleton uses this file.'))
    expect(byText('Delete', 'button', panel()!)).toBeUndefined()
    expect(byText('Download', 'button', panel()!)).toBeTruthy()

    // Start a change, upload and delete there.
    await act(async () => byText('New change')!.click())
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Name of the change"]')!, 'Photos'))
    await act(async () => byText('Start')!.click())
    const upload = await waitFor(() => byText('Upload…'))
    expect(upload).toBeTruthy()
    await pickFiles(library().querySelector<HTMLInputElement>('input[type="file"]')!, [new File([png(7)], 'fresh.png', { type: 'image/png' })])
    await waitFor(() => remote.commits.length === 1)
    expect(remote.commits[0].branch).toBe('cms/photos')
    expect(remote.text('public/images/fresh.png', 'main')).toBeUndefined()

    // The upload is new in the change: a badge on the tile, a count in the sidebar.
    await waitFor(() => tile('fresh.png')?.textContent?.includes('New'))
    await waitFor(() => byText('Media1'))

    await act(async () => tile('unused.png')!.click())
    const remove = await waitFor(() => panel() && !byText('Delete', 'button', panel()!)?.hasAttribute('disabled') && byText('Delete', 'button', panel()!))
    await act(async () => remove.click())
    await waitFor(() => remote.commits.length === 2)
    expect(remote.commits[1].branch).toBe('cms/photos')
    expect(remote.text('public/images/unused.png', 'main')).toBeDefined()

    // The review lists both as media; the upload opens in the library.
    await act(async () => byText('Review & publish2')!.click())
    const added = await waitFor(() => [...container.querySelectorAll<HTMLButtonElement>('.gcms-review-item')].find((item) => item.textContent?.includes('fresh.png')))
    expect(added.textContent).toBe('Newfresh.pngMedia · public/images/fresh.png')
    const removed = [...container.querySelectorAll<HTMLButtonElement>('.gcms-review-item')].find((item) => item.textContent?.includes('unused.png'))!
    expect(removed.disabled).toBe(true)
    await act(async () => added.click())
    await waitFor(() => panel()?.querySelector('h3')?.textContent === 'fresh.png')
  })
})
