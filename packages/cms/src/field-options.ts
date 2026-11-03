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

/**
 * Split the config of a field helper into AutoForm's field config and the editor options, which
 * travel to the component in `customData[key]`.
 */
export function splitFieldConfig<O extends object>(
  config: object,
  optionKeys: readonly string[],
  fieldType: string,
  key: string,
): { check: FieldConfigCheck; options: O } {
  const fieldConfig: Record<string, unknown> = {}
  const options: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(config)) {
    if (optionKeys.includes(name)) options[name] = value
    else fieldConfig[name] = value
  }
  return {
    check: field({ ...(fieldConfig as CmsFieldConfig), fieldType, customData: { [key]: options } }),
    options: options as O,
  }
}
