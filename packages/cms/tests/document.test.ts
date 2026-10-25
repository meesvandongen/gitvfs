import { parseDocument, parseMarkdown, serializeDocument, serializeMarkdown } from '../src/document'
import { isValidSlug, slugify } from '../src/slug'

describe('markdown documents', () => {
  it('splits frontmatter from the body', () => {
    const parsed = parseMarkdown('---\ntitle: Hello\ntags:\n  - a\n---\n\n# Body\n')
    expect(parsed).toEqual({ data: { title: 'Hello', tags: ['a'] }, body: '# Body\n' })
  })

  it('treats files without frontmatter as body only', () => {
    expect(parseMarkdown('# Just text\n')).toEqual({ data: {}, body: '# Just text\n' })
    expect(parseMarkdown('---\nnot closed')).toEqual({ data: {}, body: '---\nnot closed' })
  })

  it('handles empty frontmatter and CRLF line endings', () => {
    expect(parseMarkdown('---\n---\nBody')).toEqual({ data: {}, body: 'Body' })
    expect(parseMarkdown('---\r\ntitle: Win\r\n---\r\nBody')).toEqual({ data: { title: 'Win' }, body: 'Body' })
  })

  it('round-trips through serialize', () => {
    const source = serializeMarkdown({ title: 'Hello', draft: false }, '# Body')
    expect(source).toBe('---\ntitle: Hello\ndraft: false\n---\n\n# Body\n')
    expect(parseMarkdown(source)).toEqual({ data: { title: 'Hello', draft: false }, body: '# Body\n' })
  })

  it('writes dates as YAML-friendly strings and drops undefined', () => {
    const source = serializeMarkdown(
      { date: new Date('2024-05-01T00:00:00Z'), at: new Date('2024-05-01T10:30:00Z'), skip: undefined },
      '',
    )
    expect(source).toBe('---\ndate: 2024-05-01\nat: 2024-05-01T10:30:00.000Z\n---\n')
  })

  it('omits the frontmatter block when there is no data', () => {
    expect(serializeMarkdown({}, 'Body')).toBe('Body\n')
  })
})

describe('data documents', () => {
  it('parses and serializes JSON', () => {
    expect(parseDocument('json', '{"name":"Site"}').data).toEqual({ name: 'Site' })
    expect(parseDocument('json', '').data).toEqual({})
    expect(serializeDocument('json', { data: { name: 'Site' }, body: '' })).toBe('{\n  "name": "Site"\n}\n')
  })

  it('parses and serializes YAML', () => {
    expect(parseDocument('yaml', 'name: Site\n').data).toEqual({ name: 'Site' })
    expect(serializeDocument('yaml', { data: { name: 'Site' }, body: '' })).toBe('name: Site\n')
  })

  it('rejects documents that are not objects', () => {
    expect(() => parseDocument('json', '[1, 2]')).toThrow(/object/)
  })
})

describe('slugs', () => {
  it('slugifies titles', () => {
    expect(slugify('Hello, Wörld! 2024')).toBe('hello-world-2024')
  })

  it('rejects path traversal', () => {
    expect(isValidSlug('hello-world')).toBe(true)
    expect(isValidSlug('../secrets')).toBe(false)
    expect(isValidSlug('a/b')).toBe(false)
    expect(isValidSlug('')).toBe(false)
  })
})
