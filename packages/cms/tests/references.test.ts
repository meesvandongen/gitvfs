import { getFieldConfigInZodStack } from '@autoform/zod'
import { GitVFS } from 'gitvfs'
import { z } from 'zod'
import {
  createCms,
  defineCollection,
  defineSingleton,
  describeReferences,
  displayText,
  matchesQuery,
  reference,
  referenceFields,
  referencesIn,
  references,
  toReferenceValues,
  type EntrySummary,
} from '../src'
import { MemoryRepository } from './helpers/memory-repository'


describe('reference schemas', () => {
  it('stores a slug and keeps the options for the editor', () => {
    const schema = reference({ collection: 'authors', label: 'Author', display: ['role'] })
    expect(schema.parse('ada-lovelace')).toBe('ada-lovelace')
    expect(schema.safeParse('../secrets').success).toBe(false)
    expect(schema.safeParse('').error?.issues[0].message).toMatch(/Not a valid slug/)
    expect(schema.optional().parse(undefined)).toBeUndefined()

    const config = getFieldConfigInZodStack(schema.optional() as never)!
    expect(config.fieldType).toBe('reference')
    expect(config.customData).toEqual({
      reference: { collections: ['authors'], polymorphic: false, multiple: false, display: ['role'], min: undefined, max: undefined },
    })
  })

  it('stores { collection, slug } for several collections', () => {
    const schema = reference({ collection: ['posts', 'docs'] })
    expect(schema.parse({ collection: 'docs', slug: 'intro' })).toEqual({ collection: 'docs', slug: 'intro' })
    expect(schema.safeParse({ collection: 'authors', slug: 'ada' }).error?.issues[0].message).toBe('Pick an entry of posts, docs')
    const missing = schema.safeParse({}).error?.issues.map((issue) => issue.message)
    expect(missing).toEqual(['Required', 'Required'])
  })

  it('validates lists: bounds, slugs and duplicates', () => {
    const schema = references({ collection: 'posts', min: 1, max: 2 })
    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b'])
    expect(schema.safeParse([]).error?.issues[0].message).toBe('Pick at least 1 entry')
    expect(schema.safeParse(['a', 'b', 'c']).error?.issues[0].message).toBe('Pick at most 2 entries')
    expect(schema.safeParse(['a', 'a']).error?.issues[0].message).toBe('Each entry can be picked once')
    expect(schema.safeParse(['a', 'no/slashes']).error?.issues[0].path).toEqual([1])

    const mixed = references({ collection: ['posts', 'docs'] })
    expect(mixed.parse([{ collection: 'posts', slug: 'a' }, { collection: 'docs', slug: 'a' }])).toHaveLength(2)
    expect(mixed.safeParse([{ collection: 'posts', slug: 'a' }, { collection: 'posts', slug: 'a' }]).success).toBe(false)
  })
})

describe('reference helpers', () => {
  const entry: EntrySummary = { slug: 'ada', path: 'authors/ada.json', label: 'Ada', data: { role: 'editor', joined: new Date('2024-01-02'), age: 36, bio: '' } }

  it('normalizes stored values', () => {
    expect(toReferenceValues('ada', 'authors')).toEqual([{ collection: 'authors', slug: 'ada' }])
    expect(toReferenceValues(['a', { collection: 'docs', slug: 'b' }, '', 3, {}], 'posts')).toEqual([
      { collection: 'posts', slug: 'a' },
      { collection: 'docs', slug: 'b' },
    ])
    expect(toReferenceValues(undefined, 'posts')).toEqual([])
  })

  it('builds display text from fields or a function', () => {
    expect(displayText(entry, ['role', 'joined', 'age', 'bio', 'missing'])).toBe('editor · 2024-01-02 · 36')
    expect(displayText(entry, (e) => e.slug.toUpperCase())).toBe('ADA')
    expect(displayText(entry, undefined)).toBe('')
  })

  it('matches every word, ignoring case and accents', () => {
    expect(matchesQuery(['Ada Lovelace', 'ada-lovelace'], 'love ADA')).toBe(true)
    expect(matchesQuery(['Café Society'], 'cafe')).toBe(true)
    expect(matchesQuery(['Ada Lovelace'], 'grace')).toBe(false)
    expect(matchesQuery(['anything'], '  ')).toBe(true)
  })

  it('finds reference fields in nested schemas and reads their values', () => {
    const schema = z.object({
      title: z.string(),
      author: reference({ collection: 'authors' }).optional(),
      sections: z.array(z.object({ heading: z.string(), quotes: references({ collection: 'authors' }) })).default([]),
      related: references({ collection: ['posts', 'docs'] }).default([]),
    })
    const fields = referenceFields(schema)
    expect(fields.map((field) => field.path.join('.'))).toEqual(['author', 'sections.*.quotes', 'related'])

    const data = {
      author: 'ada',
      sections: [{ quotes: ['grace', 'ada'] }, { quotes: ['alan'] }],
      related: [{ collection: 'docs', slug: 'intro' }],
    }
    expect(referencesIn(data, fields)).toEqual([
      { collection: 'authors', slug: 'ada', field: 'author' },
      { collection: 'authors', slug: 'grace', field: 'sections.*.quotes' },
      { collection: 'authors', slug: 'ada', field: 'sections.*.quotes' },
      { collection: 'authors', slug: 'alan', field: 'sections.*.quotes' },
      { collection: 'docs', slug: 'intro', field: 'related' },
    ])
  })

  it('describes who references an entry', () => {
    const source = (label: string) => ({ type: 'collection' as const, name: 'posts', label, path: '', fields: ['author'] })
    expect(describeReferences([])).toBe('')
    expect(describeReferences([source('A')])).toBe('Referenced by 1 entry: “A”.')
    expect(describeReferences([source('A'), source('B')])).toBe('Referenced by 2 entries: “A” and “B”.')
    expect(describeReferences(['A', 'B', 'C', 'D', 'E'].map(source))).toBe('Referenced by 5 entries: “A”, “B”, “C” and 2 more.')
  })
})

describe('findReferences', () => {
  const authors = defineCollection({ name: 'authors', folder: 'authors', format: 'json', labelField: 'name', schema: z.object({ name: z.string() }) })
  const posts = defineCollection({
    name: 'posts',
    folder: 'posts',
    format: 'yaml',
    schema: z.object({
      title: z.string(),
      author: reference({ collection: 'authors' }),
      related: references({ collection: 'posts' }).default([]),
    }),
  })
  const home = defineSingleton({
    name: 'home',
    label: 'Homepage',
    path: 'home.yml',
    schema: z.object({ highlight: reference({ collection: ['posts', 'authors'] }).optional() }),
  })

  function cms() {
    const remote = new MemoryRepository({
      'authors/ada.json': '{ "name": "Ada" }\n',
      'authors/grace.json': '{ "name": "Grace" }\n',
      'posts/one.yml': 'title: One\nauthor: ada\nrelated: [two, one]\n',
      'posts/two.yml': 'title: Two\nauthor: grace\nrelated: [one]\n',
      'posts/broken.yml': 'title: [unclosed\n',
      'home.yml': 'highlight:\n  collection: authors\n  slug: ada\n',
    })
    return createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [authors, posts], singletons: [home] })
  }

  it('lists entries and singletons that point at an entry', async () => {
    const found = await cms().findReferences('authors', 'ada')
    expect(found).toEqual([
      { type: 'collection', name: 'posts', slug: 'one', label: 'One', path: 'posts/one.yml', fields: ['author'] },
      { type: 'singleton', name: 'home', label: 'Homepage', path: 'home.yml', fields: ['highlight'] },
    ])
  })

  it('skips the entry itself and content that cannot reference the collection', async () => {
    const found = await cms().findReferences('posts', 'one')
    expect(found.map((source) => source.slug)).toEqual(['two'])
    expect(await cms().findReferences('authors', 'nobody')).toEqual([])
  })
})
