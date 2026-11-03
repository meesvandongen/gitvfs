import { field, type CmsFieldConfig, type CmsFieldType, type FieldConfigCheck } from './fields.js'

/** Editor options of a field helper, next to the usual ones (`label`, `readOnly`, ...). */
export type FieldOptions<O extends object> = Omit<CmsFieldConfig, 'fieldType' | 'customData'> & O

/**
 * Attach `fieldType`, keeping the helper's own options (those named in `keys`) under
 * `customData[fieldType]`, where its editor component reads them.
 */
export function fieldWithOptions<O extends object>(
  config: FieldOptions<O>,
  keys: ReadonlyArray<keyof O>,
  fieldType: CmsFieldType,
): FieldConfigCheck {
  const fieldConfig: Record<string, unknown> = {}
  const options: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if ((keys as readonly string[]).includes(key)) options[key] = value
    else fieldConfig[key] = value
  }
  return field({ ...(fieldConfig as CmsFieldConfig), fieldType, customData: { [fieldType]: options } })
}
