import { fieldConfig as autoFormFieldConfig } from '@autoform/zod'
import type { FieldConfig } from '@autoform/core'
import type { UploadOptions } from './media.js'

/** Field types the bundled editor renders, on top of the ones AutoForm infers from zod. */
export type CmsFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'textarea'
  | 'markdown'
  | 'geopoint'
  | 'geocircle'
  | 'geoline'
  | 'geopolygon'
  | 'image'
  | 'gallery'
  | 'file'
  | 'embed'
  | 'code'
  | 'mermaid'
  | 'graph'
  | 'geopoints'
  | 'daterange'
  | 'openinghours'
  | 'recurrence'
  | 'datetime'
  | 'time'
  | 'slider'
  | 'money'
  | 'duration'
  | 'phone'
  | 'table'
  | 'tree'
  | 'reference'
  | 'references'

export type CmsFieldConfig = FieldConfig<null, CmsFieldType | (string & {})> & {
  /** Show the value without letting it be edited, such as an id or a computed value. */
  readOnly?: boolean
  /** Do not render the field; its value is kept on save, such as import metadata. */
  hidden?: boolean
}

/** A zod check carrying editor metadata; pass it to `.check()`. */
export type FieldConfigCheck = ReturnType<typeof autoFormFieldConfig>

/**
 * Attach editor metadata (label, description, field type, order, ...) to a zod schema:
 * `z.string().check(field({ label: 'Title' }))`.
 */
export function field({ readOnly, hidden, ...config }: CmsFieldConfig): FieldConfigCheck {
  // AutoForm has no such flags; the editor's field wrapper reads them from `customData`.
  if (readOnly || hidden) config.customData = { ...config.customData, readOnly, hidden }
  return autoFormFieldConfig(config) as FieldConfigCheck
}

export type MarkdownFieldConfig = Omit<CmsFieldConfig, 'fieldType'> & {
  /** Adds an image button to the toolbar that uploads into this folder: `{ folder, publicPath }`. */
  media?: UploadOptions
}

/** Edit a string as markdown with a live preview: `z.string().check(markdown())`. */
export function markdown(config: MarkdownFieldConfig = {}): FieldConfigCheck {
  const { media, ...rest } = config
  return field({ ...rest, fieldType: 'markdown', ...(media ? { customData: { ...rest.customData, media } } : {}) })
}

/** Edit a string in a multi-line plain text area: `z.string().check(textarea())`. */
export function textarea(config: Omit<CmsFieldConfig, 'fieldType'> = {}): FieldConfigCheck {
  return field({ ...config, fieldType: 'textarea' })
}
