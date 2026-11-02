import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS } from 'gitvfs'
import { z } from 'zod'
import { createCms, defineCollection, embed, file, gallery, image, markdown } from '../src'
import { CmsApp, rewriteImageSources } from '../src/react'
import { MemoryRepository } from './helpers/memory-repository'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// No test may load a video player from the network.
;(window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true

const png = (seed: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1])

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  folder: 'posts',
  schema: z.object({
    title: z.string().min(1),
    cover: image({ label: 'Cover', folder: 'public/images', publicPath: '/images', maxSize: 1000 }).optional(),
    photos: gallery({ label: 'Photos', folder: 'public/images', publicPath: '/images', max: 3 }).default([]),
    menu: file({ label: 'Menu', folder: 'public/files', accept: '.pdf' }).optional(),
    video: embed({ label: 'Video' }).optional(),
    body: z.string().check(markdown({ media: { folder: 'public/images', publicPath: '/images' } })).default(''),
  }),
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

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function pickFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}

const field = (id: string) => container.querySelector<HTMLElement>(`[id="${id}"]`)!
const fileInput = (id: string) => field(id).querySelector<HTMLInputElement>('input[type="file"]')!

async function openPost(files: Record<string, string | Uint8Array>) {
  const remote = new MemoryRepository(files)
  const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [posts] })
  act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
  const entry = await waitFor(() => byText('Postpost'))
  await act(async () => entry.click())
  await waitFor(() => container.querySelector('input[name="title"]'))
  return remote
}

async function save(remote: MemoryRepository, commits = 1) {
  await act(async () => byText('Save')!.click())
  await waitFor(() => remote.commits.length === commits)
}

describe('image field', () => {
  it('uploads a picked file with alt text and a focal point, in the same commit as the entry', async () => {
    const remote = await openPost({ 'posts/post.md': '---\ntitle: Post\n---\n' })
    expect(byText('Drop an image here', 'p', field('cover'))).toBeTruthy()

    await pickFiles(fileInput('cover'), [new File([png(1)], 'Team Photo.PNG', { type: 'image/png' })])
    const preview = await waitFor(() => field('cover').querySelector<HTMLImageElement>('.gcms-media-image'))
    expect(preview.src).toMatch(/^blob:/)
    expect(field('cover').textContent).toContain('team-photo.png')
    expect(byText('New', 'span', field('cover'))).toBeTruthy()

    await act(async () => typeInto(field('cover').querySelector<HTMLInputElement>('.gcms-media-alt input')!, 'The whole team'))

    // happy-dom has no layout: give the picker a size, then click a quarter in and three quarters down.
    const picker = field('cover').querySelector<HTMLElement>('[role="slider"]')!
    picker.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON: () => ({}) })
    await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 60, clientY: 95 })))
    expect(picker.getAttribute('aria-valuetext')).toBe('25% from the left, 75% from the top')
    await act(async () => picker.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', shiftKey: true })))
    expect(picker.getAttribute('aria-valuetext')).toBe('35% from the left, 75% from the top')

    await save(remote)
    const commit = remote.commits[0]
    expect(commit.changes.map((change) => change.path).sort()).toEqual(['posts/post.md', 'public/images/team-photo.png'])
    expect([...(commit.changes.find((change) => change.path === 'public/images/team-photo.png')!.content as Uint8Array)]).toEqual([...png(1)])
    expect(remote.text('posts/post.md')).toBe(
      '---\ntitle: Post\ncover:\n  src: /images/team-photo.png\n  alt: The whole team\n  focus:\n    x: 0.35\n    y: 0.75\nphotos: []\n---\n',
    )
    await waitFor(() => !byText('New', 'span', field('cover')))
  })

  it('shows stored images, rejects files that are too big, and removes the image', async () => {
    const remote = await openPost({
      'posts/post.md': '---\ntitle: Post\ncover:\n  src: /images/old.png\n  alt: Old\n---\n',
      'public/images/old.png': png(5),
    })
    const preview = await waitFor(() => field('cover').querySelector<HTMLImageElement>('img.gcms-media-image'))
    expect(preview.src).toMatch(/^blob:/)
    expect(preview.alt).toBe('Old')
    await waitFor(() => field('cover').textContent?.includes('10 B'))

    await pickFiles(fileInput('cover'), [new File([new Uint8Array(2000)], 'huge.png', { type: 'image/png' })])
    await waitFor(() => byText('huge.png is 2 KB; files can be up to 1000 B', 'p', field('cover')))
    await pickFiles(fileInput('cover'), [new File(['x'], 'notes.txt', { type: 'text/plain' })])
    await waitFor(() => field('cover').querySelector('[role="alert"]')?.textContent?.includes('not an accepted type'))

    // Replace, then remove: neither upload is referenced any more, so neither is committed.
    await pickFiles(fileInput('cover'), [new File([png(2)], 'new.png', { type: 'image/png' })])
    await waitFor(() => field('cover').textContent?.includes('new.png'))
    expect(field('cover').querySelector<HTMLInputElement>('.gcms-media-alt input')!.value).toBe('')
    await act(async () => byText('Remove', 'button', field('cover'))!.click())
    expect(byText('Drop an image here', 'p', field('cover'))).toBeTruthy()

    await save(remote)
    expect(remote.commits[0].changes.map((change) => change.path)).toEqual(['posts/post.md'])
    expect(remote.text('posts/post.md')).toBe('---\ntitle: Post\nphotos: []\n---\n')
  })

  it('picks an image that is already in the repository', async () => {
    const remote = await openPost({ 'posts/post.md': '---\ntitle: Post\n---\n', 'public/images/old.png': png(5), 'public/images/readme.txt': 'x' })
    await act(async () => byText('Choose existing', 'button', field('cover'))!.click())
    const item = await waitFor(() => byText('old.png', '.gcms-library-item', field('cover')))
    expect(byText('readme.txt', '.gcms-library-item', field('cover'))).toBeUndefined()
    await act(async () => item.click())
    await save(remote)
    expect(remote.commits[0].changes.map((change) => change.path)).toEqual(['posts/post.md'])
    expect(remote.text('posts/post.md')).toContain('cover:\n  src: /images/old.png\n')
  })
})

describe('gallery field', () => {
  it('adds several images, reorders them with the buttons, edits alt text and removes one', async () => {
    const remote = await openPost({ 'posts/post.md': '---\ntitle: Post\n---\n', 'public/images/a.png': png(9) })
    await pickFiles(fileInput('photos'), [
      new File([png(1)], 'a.png', { type: 'image/png' }),
      new File([png(2)], 'b.png', { type: 'image/png' }),
      new File([png(3)], 'c.png', { type: 'image/png' }),
    ])
    await waitFor(() => field('photos').querySelectorAll('.gcms-gallery-item').length === 3)
    const names = () => [...field('photos').querySelectorAll('.gcms-gallery-item .gcms-media-name')].map((el) => el.textContent)
    // a.png exists in the repository, so the upload gets a new name.
    expect(names()).toEqual(['a-2.png', 'b.png', 'c.png'])
    expect(byText('The maximum of 3 images is reached.', 'p', field('photos'))).toBeTruthy()

    await act(async () => field('photos').querySelector<HTMLButtonElement>('[aria-label="Move image 1 down"]')!.click())
    expect(names()).toEqual(['b.png', 'a-2.png', 'c.png'])
    await act(async () => field('photos').querySelector<HTMLButtonElement>('[aria-label="Move image 3 up"]')!.click())
    expect(names()).toEqual(['b.png', 'c.png', 'a-2.png'])
    expect(field('photos').querySelector<HTMLButtonElement>('[aria-label="Move image 1 up"]')!.disabled).toBe(true)

    await act(async () => typeInto(field('photos').querySelector<HTMLInputElement>('[aria-label="Alt text for image 2"]')!, 'C'))
    await act(async () => field('photos').querySelector<HTMLButtonElement>('[aria-label="Remove image 1"]')!.click())
    expect(names()).toEqual(['c.png', 'a-2.png'])

    await save(remote)
    expect(remote.commits[0].changes.map((change) => change.path).sort()).toEqual(['posts/post.md', 'public/images/a-2.png', 'public/images/c.png'])
    expect(remote.text('posts/post.md')).toBe('---\ntitle: Post\nphotos:\n  - src: /images/c.png\n    alt: C\n  - src: /images/a-2.png\n---\n')
  })
})

describe('file field', () => {
  it('uploads a PDF and shows its name and size', async () => {
    const remote = await openPost({ 'posts/post.md': '---\ntitle: Post\nmenu: /files/old.pdf\n---\n', 'public/files/old.pdf': '%PDF-1.4 old' })
    await waitFor(() => field('menu').textContent?.includes('12 B'))
    expect(byText('Download', 'button', field('menu'))).toBeTruthy()

    await pickFiles(fileInput('menu'), [new File(['%PDF-1.4'], 'Lunch Menu.pdf', { type: 'application/pdf' })])
    await waitFor(() => field('menu').textContent?.includes('lunch-menu.pdf'))
    expect(field('menu').textContent).toContain('8 B')
    await save(remote)
    expect(remote.text('public/files/lunch-menu.pdf')).toBe('%PDF-1.4')
    expect(remote.text('posts/post.md')).toContain('menu: /files/lunch-menu.pdf\n')
  })
})

describe('markdown images', () => {
  it('uploads an image from the toolbar, inserts it at the cursor and shows it in the preview', async () => {
    const remote = await openPost({ 'posts/post.md': '---\ntitle: Post\n---\n\nBefore\n' })
    const body = container.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!
    body.setSelectionRange(7, 7)
    await act(async () => container.querySelector<HTMLButtonElement>('.gcms-tool[aria-label="Image"]')!.click())
    const panel = container.querySelector<HTMLElement>('.gcms-markdown-media')!
    await pickFiles(panel.querySelector<HTMLInputElement>('input[type="file"]')!, [new File([png(4)], 'Diagram_v2.png', { type: 'image/png' })])
    await waitFor(() => body.value.includes('!['))
    expect(body.value).toBe('Before\n![diagram v2](/images/diagram-v2.png)')
    expect(container.querySelector('.gcms-markdown-media')).toBeNull()

    const frame = container.querySelector('iframe')!
    await waitFor(() => frame.getAttribute('srcdoc')?.includes('src="data:image/png;base64,'))

    await save(remote)
    expect(remote.commits[0].changes.map((change) => change.path).sort()).toEqual(['posts/post.md', 'public/images/diagram-v2.png'])
  })

  it('only rewrites image sources that a replacer returns', () => {
    const html = '<p><img src="/images/a.png" alt="A"><img src="https://example.com/b.png"></p>'
    expect(rewriteImageSources(html, (src) => (src === '/images/a.png' ? 'data:image/png;base64,AA==' : undefined)))
      .toBe('<p><img src="data:image/png;base64,AA==" alt="A"><img src="https://example.com/b.png"></p>')
    expect(rewriteImageSources('<p>none</p>', () => 'x')).toBe('<p>none</p>')
  })
})

describe('media in a change', () => {
  it('commits uploads on the change branch and shows images on both sides of the comparison', async () => {
    const remote = new MemoryRepository({
      'posts/post.md': '---\ntitle: Post\n---\n\n![Old](/images/old.png)\n',
      'public/images/old.png': png(5),
    })
    const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [posts], changes: true })
    await cms.startChange('New cover')
    act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
    const entry = await waitFor(() => byText('Postpost'))
    await act(async () => entry.click())
    await waitFor(() => container.querySelector('input[name="title"]'))

    await pickFiles(fileInput('cover'), [new File([png(1)], 'cover.png', { type: 'image/png' })])
    await waitFor(() => field('cover').querySelector('img.gcms-media-image'))
    const body = container.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!
    await act(async () => typeInto(body, `${body.value}![New](/images/cover.png)\n`))

    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.commits[0].branch).toBe('cms/new-cover')
    expect(remote.commits[0].changes.map((change) => change.path).sort()).toEqual(['posts/post.md', 'public/images/cover.png'])
    expect([...(await remote.getFile('cms/new-cover', 'public/images/cover.png')).content]).toEqual([...png(1)])
    await expect(remote.getFile('main', 'public/images/cover.png')).rejects.toThrow()

    // Before and after: both rendered previews inline the repository images as data: URLs.
    await act(async () => byText('Changes')!.click())
    await waitFor(() => container.querySelectorAll('.gcms-compare-side iframe').length === 2)
    const sides = () => [...container.querySelectorAll('.gcms-compare-side iframe')].map((frame) => frame.getAttribute('srcdoc') ?? '')
    await waitFor(() => {
      const [before, after] = sides()
      return before.match(/src="data:image\/png;base64,/g)?.length === 1 && after.match(/src="data:image\/png;base64,/g)?.length === 2
    })
  })
})

describe('embed field', () => {
  it('recognizes a YouTube link and loads the privacy-friendly player only on request', async () => {
    const remote = await openPost({ 'posts/post.md': '---\ntitle: Post\n---\n' })
    const input = field('video') as HTMLInputElement
    await act(async () => typeInto(input, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=75'))
    expect(container.querySelector('.gcms-embed-card')?.textContent).toContain('YouTube video dQw4w9WgXcQ from 1:15')
    expect(container.querySelector('.gcms-embed iframe')).toBeNull()

    // Out of the document, happy-dom does not try to load the player.
    container.remove()
    await act(async () => byText('Load preview')!.click())
    expect(container.querySelector('.gcms-embed iframe')?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=75')
    await act(async () => typeInto(input, 'https://vimeo.com/76979871'))
    expect(container.querySelector('.gcms-embed iframe')).toBeNull()
    document.body.append(container)

    await act(async () => typeInto(input, 'not a link'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Enter a link starting with https://', 'p'))
    expect(remote.commits).toHaveLength(0)
  })
})
