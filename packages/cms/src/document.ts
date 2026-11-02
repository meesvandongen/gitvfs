import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ContentFormat } from './config.js'

export interface ParsedDocument {
  /** Frontmatter for markdown, the whole file for JSON and YAML. */
  data: Record<string, unknown>
  /** Markdown body. Always empty for JSON and YAML. */
  body: string
}

/**
 * YAML 1.1 loaders (PyYAML, Ruby, js-yaml 3 behind gray-matter) read an unquoted `19:30` as the
 * base-60 number 1170. Declaring that YAML 1.1 rule as `compat` makes `yaml` quote such strings,
 * so times stay strings everywhere; nothing else changes.
 */
const STRINGIFY_OPTIONS = {
  compat: [
    {
      tag: 'tag:yaml.org,2002:int',
      default: true,
      test: /^[-+]?\d[\d_]*(?::[0-5]?\d)+(?:\.[\d_]*)?$/,
      resolve: (source: string) => source,
    },
  ],
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?^---[ \t]*(?:\r?\n|$)/m

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${what} to be an object`)
  }
  return value as Record<string, unknown>
}

/** Split a markdown file into YAML frontmatter and body. */
export function parseMarkdown(source: string): ParsedDocument {
  const match = source.startsWith('---') ? FRONTMATTER.exec(source) : null
  if (!match || match.index !== 0) {
    return { data: {}, body: source }
  }
  const body = source.slice(match[0].length).replace(/^\r?\n/, '')
  return { data: asRecord(parseYaml(match[1]), 'frontmatter'), body }
}

/** Make values YAML/JSON friendly: dates become ISO strings, undefined is dropped. */
export function toPlainData(value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString()
    // Keep date-only values (the common frontmatter case) short: 2024-05-01.
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  }
  if (Array.isArray(value)) return value.map(toPlainData)
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) result[key] = toPlainData(entry)
    }
    return result
  }
  return value
}

export function serializeMarkdown(data: Record<string, unknown>, body: string): string {
  const frontmatter = toPlainData(data) as Record<string, unknown>
  const content = body.endsWith('\n') || body === '' ? body : `${body}\n`
  if (Object.keys(frontmatter).length === 0) return content
  return `---\n${stringifyYaml(frontmatter, STRINGIFY_OPTIONS)}---\n${content ? `\n${content}` : ''}`
}

export function parseDocument(format: ContentFormat, source: string): ParsedDocument {
  switch (format) {
    case 'markdown':
      return parseMarkdown(source)
    case 'json':
      return { data: asRecord(source.trim() ? JSON.parse(source) : {}, 'JSON document'), body: '' }
    case 'yaml':
      return { data: asRecord(parseYaml(source), 'YAML document'), body: '' }
  }
}

export function serializeDocument(format: ContentFormat, document: ParsedDocument): string {
  switch (format) {
    case 'markdown':
      return serializeMarkdown(document.data, document.body)
    case 'json':
      return `${JSON.stringify(toPlainData(document.data), null, 2)}\n`
    case 'yaml':
      return stringifyYaml(toPlainData(document.data), STRINGIFY_OPTIONS)
  }
}
