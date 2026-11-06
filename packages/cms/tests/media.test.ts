import { GitVFS } from 'gitvfs'
import { z } from 'zod'
import {
  assetFileName,
  createCms,
  defaultPublicPath,
  defineCollection,
  defineSingleton,
  embed,
  file,
  focusToObjectPosition,
  formatBytes,
  gallery,
  image,
  imagePath,
  isSafeAssetPath,
  markdown,
  matchesAccept,
  mediaConfig,
  mediaFolders,
  mimeType,
  parseEmbedUrl,
  roundFocus,
  toDataUrl,
  toPublicPath,
  toRepoPath,
  uniqueAssetPath,
  uploadError,
} from '../src'
import { MemoryRepository } from './helpers/memory-repository'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255])

describe('media paths', () => {
  const media = mediaConfig('image', { folder: 'public/images/posts', publicPath: '/images/posts' })

  it('defaults the public path to the folder without public/ or static/', () => {
    expect(defaultPublicPath('public/images')).toBe('/images')
    expect(defaultPublicPath('static/uploads/')).toBe('/uploads')
    expect(defaultPublicPath('public')).toBe('/')
    expect(defaultPublicPath('assets/img')).toBe('/assets/img')
    expect(mediaConfig('image')).toMatchObject({ folder: 'public/images', publicPath: '/images', accept: 'image/*' })
    expect(mediaConfig('file')).toMatchObject({ folder: 'public/files', publicPath: '/files', accept: '' })
  })

  it('maps repository paths and public URLs both ways', () => {
    expect(toPublicPath(media, 'public/images/posts/team.jpg')).toBe('/images/posts/team.jpg')
    expect(toPublicPath(media, 'public/images/posts/my photo.jpg')).toBe('/images/posts/my%20photo.jpg')
    expect(toPublicPath(media, 'content/posts/a.md')).toBeUndefined()
    expect(toRepoPath(media, '/images/posts/team.jpg')).toBe('public/images/posts/team.jpg')
    expect(toRepoPath(media, '/images/posts/my%20photo.jpg?v=2#x')).toBe('public/images/posts/my photo.jpg')
    expect(toRepoPath(media, '/images/posts/../../secrets')).toBeUndefined()
    expect(toRepoPath(media, 'https://example.com/images/posts/team.jpg')).toBeUndefined()
    expect(toRepoPath(media, '/images/other/team.jpg')).toBeUndefined()

    const root = mediaConfig('image', { folder: 'public' })
    expect(toPublicPath(root, 'public/logo.svg')).toBe('/logo.svg')
    expect(toRepoPath(root, '/logo.svg')).toBe('public/logo.svg')
    const cdn = mediaConfig('image', { folder: 'media', publicPath: 'https://cdn.example.com/media/' })
    expect(toPublicPath(cdn, 'media/a.png')).toBe('https://cdn.example.com/media/a.png')
    expect(toRepoPath(cdn, 'https://cdn.example.com/media/a.png')).toBe('media/a.png')
  })

  it('makes safe, unique file names', async () => {
    expect(assetFileName('Team Photo (1).JPG')).toBe('team-photo-1.jpg')
    expect(assetFileName('Ünïcode café.png')).toBe('unicode-cafe.png')
    expect(assetFileName('../../etc/passwd')).toBe('passwd')
    expect(assetFileName('.png')).toBe('file.png')
    const taken = new Set(['public/images/team.jpg', 'public/images/team-2.jpg'])
    expect(await uniqueAssetPath('public/images', 'Team.jpg', (path) => taken.has(path))).toBe('public/images/team-3.jpg')
    expect(await uniqueAssetPath('', 'a.png', () => false)).toBe('a.png')
    expect(isSafeAssetPath('public/images/a.png')).toBe(true)
    expect(isSafeAssetPath('/etc/passwd')).toBe(false)
    expect(isSafeAssetPath('public/../a.png')).toBe(false)
    expect(isSafeAssetPath('.git/config')).toBe(false)
  })

  it('checks types and sizes', () => {
    expect(matchesAccept({ name: 'a.PNG', type: 'image/png' }, 'image/*')).toBe(true)
    expect(matchesAccept({ name: 'a.pdf', type: '' }, 'image/*,.pdf')).toBe(true)
    expect(matchesAccept({ name: 'a.svg' }, 'image/*')).toBe(true)
    expect(matchesAccept({ name: 'a.txt', type: 'text/plain' }, 'image/*')).toBe(false)
    expect(matchesAccept({ name: 'a.txt' }, '')).toBe(true)
    expect(matchesAccept({ name: 'a.pdf', type: 'application/pdf' }, 'application/pdf')).toBe(true)
    expect(uploadError({ accept: 'image/*', maxSize: 1000 }, { name: 'a.png', type: 'image/png', size: 2048 })).toBe('a.png is 2 KB; files can be up to 1000 B')
    expect(uploadError({ accept: 'image/*', maxSize: 1000 }, { name: 'a.zip', size: 1 })).toMatch(/not an accepted type/)
    expect(uploadError({ accept: 'image/*', maxSize: 1000 }, { name: 'a.gif', size: 10 })).toBeUndefined()
    expect(mimeType('x/a.svg')).toBe('image/svg+xml')
    expect(mimeType('a.unknown')).toBe('application/octet-stream')
  })

  it('formats sizes, focal points and data URLs', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB')
    expect(roundFocus({ x: 0.3333, y: 1.2 })).toEqual({ x: 0.33, y: 1 })
    expect(focusToObjectPosition({ x: 0.25, y: 0.8 })).toBe('25% 80%')
    expect(focusToObjectPosition(undefined)).toBe('50% 50%')
    expect(toDataUrl(new TextEncoder().encode('hi'), 'text/plain')).toBe('data:text/plain;base64,aGk=')
  })
})

describe('media schemas', () => {
  it('validates image values and keeps keys added by hand', () => {
    const schema = image({ label: 'Cover', folder: 'public/img' })
    expect(schema.parse({ src: '/img/a.png', alt: 'A', focus: { x: 0.5, y: 0.25 }, caption: 'Hi' }))
      .toEqual({ src: '/img/a.png', alt: 'A', focus: { x: 0.5, y: 0.25 }, caption: 'Hi' })
    expect(schema.safeParse({ src: '' }).error?.issues[0].message).toBe('Choose an image')
    expect(schema.safeParse({ src: '/img/a.png', focus: { x: 2, y: 0 } }).success).toBe(false)
    expect(image({ requireAlt: true }).safeParse({ src: '/a.png', alt: ' ' }).error?.issues[0].message).toBe('Describe the image')
  })

  it('stores plain paths for imagePath() and file()', () => {
    expect(imagePath().parse('/images/a.png')).toBe('/images/a.png')
    expect(imagePath().safeParse('').success).toBe(false)
    expect(file({ accept: '.pdf' }).safeParse(undefined).error?.issues[0].message).toBe('Choose a file')
  })

  it('limits galleries', () => {
    const schema = gallery({ min: 1, max: 2 })
    expect(schema.safeParse([]).error?.issues[0].message).toBe('Add at least 1 image')
    expect(schema.safeParse([{ src: '/a' }, { src: '/b' }, { src: '/c' }]).error?.issues[0].message).toBe('Use at most 2 images')
    expect(schema.parse([{ src: '/a', alt: 'A' }])).toEqual([{ src: '/a', alt: 'A' }])
  })

  it('finds the media folders of a schema, including markdown with media', () => {
    const schema = z.object({
      cover: image({ folder: 'public/images/posts' }).optional(),
      photos: gallery({ folder: 'public/images/posts' }).default([]),
      menu: file({ folder: 'public/files' }).optional(),
      seo: z.object({ image: imagePath({ folder: 'public/seo', publicPath: '/s' }) }).optional(),
      body: z.string().check(markdown({ media: { folder: 'public/images/inline' } })),
      plain: z.string().check(markdown()),
    })
    expect(mediaFolders(schema).map((media) => [media.folder, media.publicPath, media.value])).toEqual([
      ['public/images/posts', '/images/posts', 'object'],
      ['public/files', '/files', 'path'],
      ['public/seo', '/s', 'path'],
      ['public/images/inline', '/images/inline', 'path'],
    ])
  })

  it('validates embed links by provider', () => {
    expect(embed().parse('https://example.com/talk')).toBe('https://example.com/talk')
    expect(embed().safeParse('not a url').success).toBe(false)
    const videos = embed({ providers: ['youtube', 'vimeo'] })
    expect(videos.safeParse('https://youtu.be/dQw4w9WgXcQ').success).toBe(true)
    expect(videos.safeParse('https://example.com/talk').error?.issues[0].message).toBe('Enter a YouTube or Vimeo link')
  })
})

describe('parseEmbedUrl', () => {
  const id = 'dQw4w9WgXcQ'
  const nocookie = `https://www.youtube-nocookie.com/embed/${id}`

  it.each([
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?feature=share&v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `  https://youtu.be/${id}  `,
  ])('recognizes YouTube: %s', (url) => {
    expect(parseEmbedUrl(url)).toEqual({ provider: 'youtube', url: url.trim(), id, embedUrl: nocookie })
  })

  it('keeps YouTube start times', () => {
    expect(parseEmbedUrl(`https://youtu.be/${id}?t=90`)).toMatchObject({ start: 90, embedUrl: `${nocookie}?start=90` })
    expect(parseEmbedUrl(`https://www.youtube.com/watch?v=${id}&t=1m30s`)?.start).toBe(90)
    expect(parseEmbedUrl(`https://www.youtube.com/watch?v=${id}&t=1h0m5s`)?.start).toBe(3605)
    expect(parseEmbedUrl(`https://www.youtube.com/embed/${id}?start=42`)?.start).toBe(42)
  })

  it('recognizes Vimeo, including unlisted videos', () => {
    expect(parseEmbedUrl('https://vimeo.com/76979871')).toEqual({
      provider: 'vimeo',
      url: 'https://vimeo.com/76979871',
      id: '76979871',
      embedUrl: 'https://player.vimeo.com/video/76979871?dnt=1',
    })
    expect(parseEmbedUrl('https://vimeo.com/76979871/abc123def4')?.embedUrl).toBe('https://player.vimeo.com/video/76979871?dnt=1&h=abc123def4')
    expect(parseEmbedUrl('https://player.vimeo.com/video/76979871?h=abc123def4')?.embedUrl).toBe('https://player.vimeo.com/video/76979871?dnt=1&h=abc123def4')
    expect(parseEmbedUrl('https://vimeo.com/channels/staffpicks/76979871')?.id).toBe('76979871')
    expect(parseEmbedUrl('https://vimeo.com/76979871#t=1m2s')).toMatchObject({ start: 62, embedUrl: 'https://player.vimeo.com/video/76979871?dnt=1#t=62s' })
  })

  it('treats other links as plain URLs and rejects the rest', () => {
    expect(parseEmbedUrl('https://www.youtube.com/@channel')).toEqual({ provider: 'url', url: 'https://www.youtube.com/@channel' })
    expect(parseEmbedUrl('https://www.youtube.com/watch?v=short')?.provider).toBe('url')
    expect(parseEmbedUrl('https://vimeo.com/about')?.provider).toBe('url')
    expect(parseEmbedUrl('https://example.com/video.mp4')).toEqual({ provider: 'url', url: 'https://example.com/video.mp4' })
    expect(parseEmbedUrl('javascript:alert(1)')).toBeUndefined()
    expect(parseEmbedUrl('ftp://example.com/a')).toBeUndefined()
    expect(parseEmbedUrl('youtube.com/watch?v=dQw4w9WgXcQ')).toBeUndefined()
    expect(parseEmbedUrl('')).toBeUndefined()
  })
})

describe('GitCms assets', () => {
  const posts = defineCollection({
    name: 'posts',
    folder: 'content/posts',
    format: 'yaml',
    schema: z.object({ title: z.string(), cover: image().optional() }),
  })
  const site = defineSingleton({ name: 'site', path: 'data/site.json', schema: z.object({ logo: imagePath() }) })

  function setup(files: Record<string, string | Uint8Array> = {}) {
    const remote = new MemoryRepository(files)
    const fs = new GitVFS({ repository: remote, branch: 'main', cache: 'none' })
    return { remote, fs, cms: createCms({ fs, collections: [posts], singletons: [site] }) }
  }

  it('commits an entry and its uploads in one commit', async () => {
    const { remote, cms } = setup()
    await cms.saveEntry('posts', {
      slug: 'hello',
      data: { title: 'Hello', cover: { src: '/images/team.png', alt: 'The team' } },
      assets: [{ path: 'public/images/team.png', content: png }],
    })
    expect(remote.commits).toHaveLength(1)
    expect(remote.commits[0].changes.map((change) => change.path).sort()).toEqual(['content/posts/hello.yml', 'public/images/team.png'])
    expect(await remote.getFile('main', 'public/images/team.png').then((f) => [...f.content])).toEqual([...png])
    expect([...(await cms.readAsset('public/images/team.png'))]).toEqual([...png])
  })

  it('commits a singleton with its uploads', async () => {
    const { remote, cms } = setup()
    await cms.saveSingleton('site', { logo: '/images/logo.png' }, { assets: [{ path: 'public/images/logo.png', content: png }] })
    expect(remote.commits).toHaveLength(1)
    expect(remote.commits[0].changes).toHaveLength(2)
  })

  it('never overwrites a file and leaves nothing staged when a save fails', async () => {
    const { remote, fs, cms } = setup({ 'public/images/team.png': png })
    await expect(
      cms.saveEntry('posts', { slug: 'a', data: { title: 'A' }, assets: [{ path: 'public/images/team.png', content: png }] }),
    ).rejects.toThrow('A file already exists at public/images/team.png')
    await expect(
      cms.saveEntry('posts', { slug: 'a', data: { title: 'A' }, assets: [{ path: '../outside.png', content: png }] }),
    ).rejects.toThrow('Invalid file path')
    await expect(
      cms.saveEntry('posts', { slug: 'a', data: { title: 'A' }, assets: [{ path: 'content/posts/a.yml', content: png }] }),
    ).rejects.toThrow('Two files would be written')
    expect(fs.status()).toEqual([])

    // The commit itself fails: the staged upload must not ride along with the next save.
    remote.commit = async () => {
      throw new Error('Network down')
    }
    await expect(
      cms.saveEntry('posts', { slug: 'a', data: { title: 'A' }, assets: [{ path: 'public/images/new.png', content: png }] }),
    ).rejects.toThrow('Network down')
    expect(fs.status()).toEqual([])
    expect(remote.commits).toHaveLength(0)
  })

  it('commits uploads on the change branch when editing in a change', async () => {
    const remote = new MemoryRepository({ 'content/posts/hello.yml': 'title: Hello\n' })
    const fs = new GitVFS({ repository: remote, branch: 'main', cache: 'none' })
    const cms = createCms({ fs, collections: [posts], changes: { required: true } })

    // Required changes: main is read-only, and a refused save leaves nothing staged.
    await expect(
      cms.saveEntry('posts', { slug: 'hello', previousSlug: 'hello', data: { title: 'Hi' }, assets: [{ path: 'public/images/a.png', content: png }] }),
    ).rejects.toThrow('Start a change')
    expect(fs.status()).toEqual([])

    await cms.startChange('Photos')
    expect(await cms.availableAssetPath('public/images', 'a.png')).toBe('public/images/a.png')
    await cms.saveEntry('posts', {
      slug: 'hello',
      previousSlug: 'hello',
      data: { title: 'Hello', cover: { src: '/images/a.png' } },
      assets: [{ path: 'public/images/a.png', content: png }],
    })
    expect(remote.commits).toHaveLength(1)
    expect(remote.commits[0].branch).toBe('cms/photos')
    expect(remote.commits[0].changes.map((change) => change.path).sort()).toEqual(['content/posts/hello.yml', 'public/images/a.png'])
    expect([...(await remote.getFile('cms/photos', 'public/images/a.png')).content]).toEqual([...png])
    await expect(remote.getFile('main', 'public/images/a.png')).rejects.toThrow()
    expect([...(await cms.readAsset('public/images/a.png'))]).toEqual([...png])
    // The upload is part of what the change changes, and the name is taken on its branch.
    expect((await cms.changedContent()).map((change) => [change.path, change.status])).toContainEqual(['public/images/a.png', 'added'])
    expect(await cms.availableAssetPath('public/images', 'a.png')).toBe('public/images/a-2.png')
  })

  it('suggests free paths for uploads', async () => {
    const { cms } = setup({ 'public/images/team.png': png })
    expect(await cms.availableAssetPath('public/images', 'Team.PNG')).toBe('public/images/team-2.png')
    expect(await cms.availableAssetPath('public/images', 'team.png', ['public/images/team-2.png'])).toBe('public/images/team-3.png')
    expect(await cms.availableAssetPath('public/images', 'new.png')).toBe('public/images/new.png')
  })
})
