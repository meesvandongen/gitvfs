import { fieldConfig as autoFormFieldConfig } from '@autoform/zod'
import type { FieldConfig } from '@autoform/core'

/** Field types the bundled editor renders, on top of the ones AutoForm infers from zod. */
export type CmsFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'textarea'
  | 'markdown'

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

/** Edit a string as markdown with a live preview: `z.string().check(markdown())`. */
export function markdown(config: Omit<CmsFieldConfig, 'fieldType'> = {}): FieldConfigCheck {
  return field({ ...config, fieldType: 'markdown' })
}

/** Edit a string in a multi-line plain text area: `z.string().check(textarea())`. */
export function textarea(config: Omit<CmsFieldConfig, 'fieldType'> = {}): FieldConfigCheck {
  return field({ ...config, fieldType: 'textarea' })
}
