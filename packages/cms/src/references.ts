import { z } from 'zod'
import { getFieldConfigInZodStack } from '@autoform/zod'
import type { GitCms } from './cms.js'
import type { EntrySummary } from './config.js'
import { field, type CmsFieldConfig } from './fields.js'
import { isValidSlug } from './slug.js'

// A reference stores the slug of the entry it points at, as a plain string: `author: ada-lovelace`.
// That is what Keystatic's `fields.relationship` and Astro's `reference()` store, and what Decap's
// `relation` widget stores with `value_field: '{{slug}}'`. The slug is the entry's identity in this
// CMS (its file name), it reads well in a diff, and unlike a path it survives moving the collection
// to another folder or format. Like a path (TinaCMS) it breaks when the entry is renamed; the editor
// warns before renaming or deleting a referenced entry (`findReferences`) and flags slugs that no
// longer exist, without failing validation, so hand-edited and half-migrated content still saves.
//
// A reference to one of several collections stores `{ collection, slug }`, the shape of Payload's
// polymorphic relationships (`{ relationTo, value }`) in the CMS's own words.

/** A reference to an entry of one of several collections. */
export interface ReferenceValue {
  collection: string
  slug: string
}

/** Text shown next to an entry's label in the picker: field names, or a function of the entry. */
export type ReferenceDisplay = readonly string[] | ((entry: EntrySummary) => string | undefined)

export interface ReferenceOptions {
  /** Collection the entry is picked from. A list of collections stores `{ collection, slug }`. */
  collection: string | readonly string[]
  /** Extra text shown next to each entry's label, such as `['role']` or `(entry) => entry.data.date`. */
  display?: ReferenceDisplay
}

export interface ReferencesOptions extends ReferenceOptions {
  /** Fewest entries to pick. */
  min?: number
  /** Most entries to pick. */
  max?: number
}

/** Editor options of a reference field, without `fieldType` (set by the helper). */
export type ReferenceFieldConfig<O extends ReferenceOptions = ReferenceOptions> =
  Omit<CmsFieldConfig, 'fieldType' | 'customData'> & O

/** Where reference fields keep their options in AutoForm's `customData`. */
export interface ReferenceCustomData {
  reference: {
    collections: string[]
    /** Values are `{ collection, slug }` objects rather than slugs. */
    polymorphic: boolean
    multiple: boolean
    display?: ReferenceDisplay
    min?: number
    max?: number
  }
}

const SLUG_MESSAGE = 'Not a valid slug: use letters, digits, dots, dashes and underscores'

const slugSchema = () => z.string().refine(isValidSlug, SLUG_MESSAGE)

function referenceObject(collections: readonly string[]) {
  return z.object({
    collection: z.enum(collections as [string, ...string[]], {
      error: (issue) => (issue.input === undefined ? 'Required' : `Pick an entry of ${collections.join(', ')}`),
    }),
    slug: z.string('Required').refine(isValidSlug, SLUG_MESSAGE),
  })
}

type PolymorphicReference<C extends readonly string[]> = z.ZodObject<{
  collection: z.ZodEnum<{ [K in C[number]]: K }>
  slug: z.ZodString
}>

function splitConfig(config: ReferenceFieldConfig<ReferencesOptions>, multiple: boolean) {
  const { collection, display, min, max, ...fieldConfig } = config
  const collections = typeof collection === 'string' ? [collection] : [...collection]
  if (collections.length === 0) throw new Error('A reference needs at least one collection')
  const reference: ReferenceCustomData['reference'] = {
    collections,
    polymorphic: typeof collection !== 'string',
    multiple,
    display,
    min,
    max,
  }
  return field({ ...fieldConfig, fieldType: multiple ? 'references' : 'reference', customData: { reference } })
}

/**
 * The slug of an entry of another collection, picked from a searchable list.
 *
 * ```ts
 * author: reference({ collection: 'authors', label: 'Author' }),
 * // An entry of one of several collections, stored as { collection, slug }:
 * featured: reference({ collection: ['posts', 'docs'] }).optional(),
 * ```
 */
export function reference(config: ReferenceFieldConfig & { collection: string }): z.ZodString
export function reference<const C extends readonly [string, ...string[]]>(
  config: ReferenceFieldConfig & { collection: C },
): PolymorphicReference<C>
export function reference(config: ReferenceFieldConfig): z.ZodType {
  const check = splitConfig(config, false)
  return typeof config.collection === 'string'
    ? slugSchema().check(check)
    : referenceObject(config.collection).check(check)
}

/**
 * An ordered list of entries of another collection, without duplicates.
 *
 * ```ts
 * relatedPosts: references({ collection: 'posts', max: 3 }).default([]),
 * ```
 */
export function references(config: ReferenceFieldConfig<ReferencesOptions> & { collection: string }): z.ZodArray<z.ZodString>
export function references<const C extends readonly [string, ...string[]]>(
  config: ReferenceFieldConfig<ReferencesOptions> & { collection: C },
): z.ZodArray<PolymorphicReference<C>>
export function references(config: ReferenceFieldConfig<ReferencesOptions>): z.ZodType {
  const item = typeof config.collection === 'string' ? slugSchema() : referenceObject(config.collection)
  let list = z.array(item as z.ZodType<string | ReferenceValue>)
  if (config.min !== undefined) list = list.min(config.min, `Pick at least ${config.min} ${config.min === 1 ? 'entry' : 'entries'}`)
  if (config.max !== undefined) list = list.max(config.max, `Pick at most ${config.max} ${config.max === 1 ? 'entry' : 'entries'}`)
  return list
    .refine((values) => new Set(values.map((value) => referenceKey(value, ''))).size === values.length, 'Each entry can be picked once')
    .check(splitConfig(config, true))
}

// --- Values --------------------------------------------------------------------------------------

/** A string that identifies a reference, `collection/slug`. Slugs fall back to `collection`. */
export function referenceKey(value: string | ReferenceValue, collection: string): string {
  return typeof value === 'string' ? `${collection}/${value}` : `${value.collection}/${value.slug}`
}

/**
 * The references in a stored value of a reference field, as `{ collection, slug }`: a slug or an
 * object for one reference, a list of them for many. Anything else is skipped.
 */
export function toReferenceValues(value: unknown, collection: string): ReferenceValue[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const result: ReferenceValue[] = []
  for (const item of list) {
    if (typeof item === 'string' && item !== '') result.push({ collection, slug: item })
    else if (isReferenceValue(item)) result.push({ collection: item.collection, slug: item.slug })
  }
  return result
}

/** Whether `value` is a `{ collection, slug }` with non-empty strings. */
export function isReferenceValue(value: unknown): value is ReferenceValue {
  if (typeof value !== 'object' || value === null) return false
  const { collection, slug } = value as Partial<ReferenceValue>
  return typeof collection === 'string' && collection !== '' && typeof slug === 'string' && slug !== ''
}

/** The text a reference field shows next to an entry's label, from its `display` option. */
export function displayText(entry: EntrySummary, display: ReferenceDisplay | undefined): string {
  if (!display) return ''
  if (typeof display === 'function') return display(entry) ?? ''
  return display
    .map((key) => entry.data[key])
    .filter((value) => typeof value === 'string' || typeof value === 'number' || value instanceof Date)
    .map((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value)))
    .filter((value) => value !== '')
    .join(' · ')
}

/** Whether every word of `query` occurs in one of `texts`, ignoring case and accents. */
export function matchesQuery(texts: readonly string[], query: string): boolean {
  const fold = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const haystack = fold(texts.join(' '))
  return fold(query).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
}

// --- Finding references --------------------------------------------------------------------------

/** A reference field somewhere in a schema. `path` uses `*` for the items of a list. */
export interface ReferenceField {
  path: string[]
  options: ReferenceCustomData['reference']
}

interface ZodNode {
  _zod: { def: { type: string; innerType?: ZodNode; shape?: Record<string, ZodNode>; element?: ZodNode } }
}

/** The reference fields of a schema, including those inside groups and lists. */
export function referenceFields(schema: unknown, path: string[] = []): ReferenceField[] {
  const node = schema as ZodNode
  const options = (getFieldConfigInZodStack(node as never)?.customData as Partial<ReferenceCustomData> | undefined)?.reference
  if (options) return [{ path, options }]
  const { def } = node._zod
  if (def.innerType) return referenceFields(def.innerType, path)
  if (def.type === 'object' && def.shape) {
    return Object.entries(def.shape).flatMap(([key, child]) => referenceFields(child, [...path, key]))
  }
  if (def.type === 'array' && def.element) return referenceFields(def.element, [...path, '*'])
  return []
}

function valuesAt(data: unknown, path: readonly string[]): unknown[] {
  if (path.length === 0) return [data]
  const [key, ...rest] = path
  if (key === '*') return Array.isArray(data) ? data.flatMap((item) => valuesAt(item, rest)) : []
  if (typeof data !== 'object' || data === null) return []
  return valuesAt((data as Record<string, unknown>)[key], rest)
}

/** The references that a document's data holds in `fields` (from `referenceFields`). */
export function referencesIn(data: unknown, fields: readonly ReferenceField[]): Array<ReferenceValue & { field: string }> {
  return fields.flatMap(({ path, options }) =>
    valuesAt(data, path)
      .flatMap((value) => toReferenceValues(value, options.collections[0]))
      .map((value) => ({ ...value, field: path.join('.') })),
  )
}

/** An entry or singleton that references another entry. */
export interface ReferenceSource {
  type: 'collection' | 'singleton'
  /** Collection or singleton name. */
  name: string
  /** Slug of the referencing entry; absent for singletons. */
  slug?: string
  label: string
  path: string
  /** Fields that hold the reference, such as `author` or `sections.*.author`. */
  fields: string[]
}

/**
 * Entries and singletons whose reference fields point at an entry, to warn before it is renamed or
 * deleted. Reads every document of the content types that can reference the collection.
 */
export async function findReferences(cms: GitCms, collection: string, slug: string): Promise<ReferenceSource[]> {
  const sources: ReferenceSource[] = []
  const targets = (fields: ReferenceField[]) =>
    fields.filter((referenceField) => referenceField.options.collections.includes(collection))
  const match = (data: unknown, fields: ReferenceField[]) => [
    ...new Set(
      referencesIn(data, fields)
        .filter((value) => value.collection === collection && value.slug === slug)
        .map((value) => value.field),
    ),
  ]

  for (const contentType of cms.collections) {
    const fields = targets(referenceFields(contentType.schema))
    if (fields.length === 0) continue
    for (const entry of await cms.listEntries(contentType.name)) {
      if (contentType.name === collection && entry.slug === slug) continue
      const matched = match(entry.data, fields)
      if (matched.length > 0) {
        sources.push({ type: 'collection', name: contentType.name, slug: entry.slug, label: entry.label, path: entry.path, fields: matched })
      }
    }
  }
  for (const contentType of cms.singletons) {
    const fields = targets(referenceFields(contentType.schema))
    if (fields.length === 0) continue
    const document = await cms.readSingleton(contentType.name)
    const matched = match(document.data, fields)
    if (matched.length > 0) {
      sources.push({ type: 'singleton', name: contentType.name, label: contentType.label, path: document.path, fields: matched })
    }
  }
  return sources
}

/** "Referenced by Hello world and 2 others", for confirmations. Empty when nothing references it. */
export function describeReferences(sources: readonly ReferenceSource[]): string {
  if (sources.length === 0) return ''
  const names = sources.slice(0, 3).map((source) => `“${source.label}”`)
  const more = sources.length - names.length
  const list = more > 0 ? `${names.join(', ')} and ${more} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return `Referenced by ${sources.length} ${sources.length === 1 ? 'entry' : 'entries'}: ${list}.`
}
