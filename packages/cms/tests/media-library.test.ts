import { GitVFS, NotFoundError } from 'gitvfs'
import { z } from 'zod'
import {
  createCms,
  defineCollection,
  defineSingleton,
  describeMediaUsage,
  file,
  gallery,
  image,
  imagePath,
  markdown,
  mediaFolderLabel,
  mediaFolderOf,
  mediaLibraryFolders,
  mediaPattern,
  mediaUsageIn,
  type CmsOptions,
} from '../src'
import { MemoryRepository } from './helpers/memory-repository'

const png = (seed: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed])

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  folder: 'content/posts',
  schema: z.object({
    title: z.string(),
    cover: image({ folder: 'public/images', maxSize: 2000 }).optional(),
    photos: gallery({ folder: 'public/images' }).default([]),
    body: z.string().check(markdown({ media: { folder: 'public/images/inline', publicPath: '/inline' } })).default(''),
  }),
})
const site = defineSingleton({
  name: 'site',
  label: 'Site settings',
  path: 'data/site.json',
  schema: z.object({ logo: imagePath({ folder: 'public/images', accept: '.svg' }).optional(), menu: file({ accept: '.pdf' }).optional() }),
})

function setup(files: Record<string, string | Uint8Array> = {}, options: Partial<CmsOptions> = {}) {
  const remote = new MemoryRepository(files)
  const fs = new GitVFS({ repository: remote, branch: 'main', cache: 'none' })
  return { remote, fs, cms: createCms({ fs, collections: [posts], singletons: [site], ...options }) }
}

describe('media library folders', () => {
  it('collects the folders of all media fields once, with the loosest limits, then the media option’s', () => {
    const folders = mediaLibraryFolders([posts, site], [
      { folder: 'public/downloads/', label: 'Downloads', accept: '.zip' },
      { folder: 'public/files', label: 'PDFs' },
    ])
    expect(folders).toEqual([
      // cover (image/*, 2000 B), photos (image/*, 10 MB) and logo (.svg) share the folder.
      { folder: 'public/images', publicPath: '/images', label: 'Images', accept: 'image/*,.svg', maxSize: 10 * 1024 * 1024 },
      { folder: 'public/images/inline', publicPath: '/inline', label: 'Images › Inline', accept: 'image/*', maxSize: 10 * 1024 * 1024 },
      // The option labels a field's folder, and adds one.
      { folder: 'public/files', publicPath: '/files', label: 'PDFs', accept: '.pdf', maxSize: 10 * 1024 * 1024 },
      { folder: 'public/downloads', publicPath: '/downloads', label: 'Downloads', accept: '.zip', maxSize: 10 * 1024 * 1024 },
    ])
  })

  it('accepts any file when one field of the folder does', () => {
    const docs = defineCollection({
      name: 'docs',
      folder: 'docs',
      schema: z.object({ a: file({ folder: 'public/media', accept: '.pdf', maxSize: 100 }), b: file({ folder: 'public/media', maxSize: 50 }) }),
    })
    expect(mediaLibraryFolders([docs])).toEqual([{ folder: 'public/media', publicPath: '/media', label: 'Media', accept: '', maxSize: 100 }])
  })

  it('labels folders and finds the folder a file lies in directly', () => {
    expect(mediaFolderLabel('public/images/posts')).toBe('Images › Posts')
    expect(mediaFolderLabel('static')).toBe('Static')
    expect(mediaFolderLabel('assets')).toBe('Assets')
    expect(mediaFolderLabel('')).toBe('Repository root')
    const folders = [{ folder: 'public/images' }, { folder: '' }]
    expect(mediaFolderOf(folders, 'public/images/a.png')).toEqual({ folder: 'public/images' })
    expect(mediaFolderOf(folders, 'public/images/posts/a.png')).toBeUndefined()
    expect(mediaFolderOf(folders, 'logo.svg')).toEqual({ folder: '' })
  })
})

describe('media usage', () => {
  const pattern = mediaPattern('public/images/my photo.png', '/images/my%20photo.png')

  it('finds a file by its URL or repository path, in any value', () => {
    const data = {
      title: 'Hello',
      cover: { src: '/images/my%20photo.png', alt: 'Me' },
      photos: [{ src: '/images/other.png' }, { src: '/images/my photo.png?v=2' }],
      seo: { image: 'https://example.com/elsewhere.png' },
      body: 'Text ![Me](../../public/images/my photo.png) and <img src="/images/my%20photo.png#top">',
      count: 3,
    }
    expect(mediaUsageIn(data, pattern)).toEqual(['cover.src', 'photos.*.src', 'body'])
  })

  it('does not match other files that share part of the name or path', () => {
    for (const text of ['/images/my%20photo.png.webp', '/media/images/my%20photo.png', '/images/my%20photo.pngx', 'xpublic/images/my photo.png']) {
      expect(mediaUsageIn({ text }, pattern)).toEqual([])
    }
    // At the repository root, `/a.png` is another folder's file.
    const root = mediaPattern('a.png', '/a.png')
    expect(mediaUsageIn({ a: 'images/a.png', b: '/a.png', c: 'a.png' }, root)).toEqual(['b', 'c'])
  })

  it('describes the documents for a confirmation', () => {
    const source = (label: string) => ({ type: 'collection' as const, name: 'posts', slug: label, label, path: `${label}.md`, fields: ['cover'] })
    expect(describeMediaUsage([])).toBe('')
    expect(describeMediaUsage([source('A')])).toBe('Used in 1 document: “A”.')
    expect(describeMediaUsage([source('A'), source('B')])).toBe('Used in 2 documents: “A” and “B”.')
    expect(describeMediaUsage(['A', 'B', 'C', 'D', 'E'].map(source))).toBe('Used in 5 documents: “A”, “B”, “C” and 2 more.')
  })
})

describe('GitCms media library', () => {
  it('lists the files of a folder, one level, with sizes from the listing', async () => {
    const { cms, remote } = setup({
      'public/images/b.png': png(1),
      'public/images/a.svg': '<svg/>',
      'public/images/inline/nested.png': png(2),
    })
    const getFile = vi.spyOn(remote, 'getFile')
    expect(cms.mediaFolders().map((folder) => folder.folder)).toEqual(['public/images', 'public/images/inline', 'public/files'])
    expect(await cms.listMedia('public/images')).toEqual([
      { path: 'public/images/a.svg', name: 'a.svg', publicPath: '/images/a.svg', size: 6 },
      { path: 'public/images/b.png', name: 'b.png', publicPath: '/images/b.png', size: 9 },
    ])
    // Sizes come from the tree: no file was downloaded.
    expect(getFile).not.toHaveBeenCalled()
    expect(await cms.listMedia('public/files')).toEqual([])
    await expect(cms.listMedia('content/posts')).rejects.toThrow('Unknown media folder: content/posts')
  })

  it('uploads files without an entry, in one commit, under free names', async () => {
    const { cms, remote } = setup({ 'public/images/team.png': png(1) })
    const result = await cms.uploadMedia('public/images', [
      { name: 'Team.PNG', content: png(2) },
      { name: 'team.png', content: png(3) },
      { name: 'Logo.svg', content: new TextEncoder().encode('<svg/>') },
    ])
    expect(result.paths).toEqual(['public/images/team-2.png', 'public/images/team-3.png', 'public/images/logo.svg'])
    expect(remote.commits).toHaveLength(1)
    expect(remote.commits[0].message).toBe('Upload 3 files to public/images')
    expect([...(await cms.readAsset('public/images/team-3.png'))]).toEqual([...png(3)])
    expect([...(await cms.readAsset('public/images/team.png'))]).toEqual([...png(1)])

    await cms.uploadMedia('public/files', [{ name: 'Menu.pdf', content: png(4) }], { message: 'Add the menu' })
    expect(remote.commits.map((commit) => commit.message)).toEqual(['Upload 3 files to public/images', 'Add the menu'])
    expect((await cms.uploadMedia('public/images/inline', [{ name: 'a.png', content: png(5) }])).paths).toEqual(['public/images/inline/a.png'])
    expect(remote.commits[2].message).toBe('Upload public/images/inline/a.png')
  })

  it('checks uploads against the folder and leaves nothing staged when one fails', async () => {
    const { cms, fs, remote } = setup()
    await expect(cms.uploadMedia('public/files', [{ name: 'notes.txt', content: png(1) }])).rejects.toThrow('notes.txt is not an accepted type of file (.pdf)')
    await expect(cms.uploadMedia('public/images/inline', [{ name: 'big.png', content: new Uint8Array(11 * 1024 * 1024) }])).rejects.toThrow('files can be up to 10 MB')
    await expect(cms.uploadMedia('content/posts', [{ name: 'a.md', content: png(1) }])).rejects.toThrow('Unknown media folder')
    await expect(cms.uploadMedia('public/images', [])).rejects.toThrow('Choose at least one file')

    remote.commit = async () => {
      throw new Error('Network down')
    }
    await expect(cms.uploadMedia('public/images', [{ name: 'a.png', content: png(1) }])).rejects.toThrow('Network down')
    expect(fs.status()).toEqual([])
  })

  it('deletes a file of a media folder in one commit, and only those', async () => {
    const { cms, remote } = setup({ 'public/images/old.png': png(1), 'content/posts/a.md': '---\ntitle: A\n---\n' })
    const result = await cms.deleteMedia('public/images/old.png')
    expect(result.path).toBe('public/images/old.png')
    expect(remote.commits).toHaveLength(1)
    expect(remote.commits[0].message).toBe('Delete public/images/old.png')
    expect(remote.text('public/images/old.png')).toBeUndefined()
    expect(await cms.listMedia('public/images')).toEqual([])

    await expect(cms.deleteMedia('public/images/old.png')).rejects.toBeInstanceOf(NotFoundError)
    await expect(cms.deleteMedia('content/posts/a.md')).rejects.toThrow('content/posts/a.md is not in a media folder')
    expect(remote.commits).toHaveLength(1)
  })

  it('finds the entries and singletons that use a file', async () => {
    const { cms } = setup({
      'public/images/team.png': png(1),
      'content/posts/a.md': '---\ntitle: Alpha\ncover:\n  src: /images/team.png\nphotos:\n  - src: /images/team.png\n---\n',
      'content/posts/b.md': '---\ntitle: Beta\n---\nSee ![the team](/images/team.png).\n',
      'content/posts/c.md': '---\ntitle: Gamma\ncover:\n  src: /images/team.png.webp\n---\n',
      'data/site.json': '{ "logo": "/images/team.png" }',
    })
    expect(await cms.findMediaUsage('public/images/team.png')).toEqual([
      { type: 'collection', name: 'posts', slug: 'a', label: 'Alpha', path: 'content/posts/a.md', fields: ['cover.src', 'photos.*.src'] },
      { type: 'collection', name: 'posts', slug: 'b', label: 'Beta', path: 'content/posts/b.md', fields: ['body'] },
      { type: 'singleton', name: 'site', label: 'Site settings', path: 'data/site.json', fields: ['logo'] },
    ])
    expect(await cms.findMediaUsage('public/images/unused.png')).toEqual([])
  })

  it('adds folders from the media option', async () => {
    const { cms } = setup({ 'public/downloads/kit.zip': 'zip' }, { media: [{ folder: 'public/downloads', label: 'Downloads' }] })
    expect(cms.mediaFolders().at(-1)).toEqual({ folder: 'public/downloads', publicPath: '/downloads', label: 'Downloads', accept: '', maxSize: 10 * 1024 * 1024 })
    expect(await cms.listMedia('public/downloads')).toEqual([{ path: 'public/downloads/kit.zip', name: 'kit.zip', publicPath: '/downloads/kit.zip', size: 3 }])
  })

  it('uploads and deletes on the change branch, and lists the files as media in the change', async () => {
    const remote = new MemoryRepository({ 'public/images/old.png': png(1), 'README.md': '# Site' })
    const fs = new GitVFS({ repository: remote, branch: 'main', cache: 'none' })
    const cms = createCms({ fs, collections: [posts], singletons: [site], changes: { required: true } })

    await expect(cms.uploadMedia('public/images', [{ name: 'a.png', content: png(2) }])).rejects.toThrow('Start a change')
    await expect(cms.deleteMedia('public/images/old.png')).rejects.toThrow('Start a change')
    expect(fs.status()).toEqual([])

    await cms.startChange('New photos')
    await cms.uploadMedia('public/images', [{ name: 'a.png', content: png(2) }])
    await cms.deleteMedia('public/images/old.png')
    expect(remote.commits.map((commit) => commit.branch)).toEqual(['cms/new-photos', 'cms/new-photos'])
    expect(remote.text('public/images/old.png', 'main')).toBeDefined()
    expect((await cms.listMedia('public/images')).map((media) => media.name)).toEqual(['a.png'])

    expect((await cms.changedContent()).map(({ path, status, label, mediaFolder }) => ({ path, status, label, mediaFolder }))).toEqual([
      { path: 'public/images/a.png', status: 'added', label: 'a.png', mediaFolder: 'public/images' },
      { path: 'public/images/old.png', status: 'removed', label: 'old.png', mediaFolder: 'public/images' },
    ])
  })
})
