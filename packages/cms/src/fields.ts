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

export type CmsFieldConfig = FieldConfig<null, CmsFieldType | (string & {})>

/** A zod check carrying editor metadata; pass it to `.check()`. */
export type FieldConfigCheck = ReturnType<typeof autoFormFieldConfig>

/**
 * Attach editor metadata (label, description, field type, order, ...) to a zod schema:
 * `z.string().check(field({ label: 'Title' }))`.
 */
export function field(config: CmsFieldConfig): FieldConfigCheck {
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
