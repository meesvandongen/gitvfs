import { field, type CmsFieldConfig, type FieldConfigCheck } from './fields.js'

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
