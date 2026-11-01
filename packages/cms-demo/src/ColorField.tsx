import { useField, type FieldProps } from 'gitvfs-cms/react'

/**
 * A custom field type. Schemas opt in with `field({ fieldType: 'color' })`, and the app registers
 * the component with `<CmsApp formComponents={{ color: ColorField }} />`.
 */
export function ColorField({ id, inputProps }: FieldProps) {
  const field = useField(id)
  const value = typeof field.value === 'string' ? field.value : ''
  return (
    <div className="demo-color">
      <input
        type="color"
        aria-label="Pick a color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
        onChange={(event) => field.onChange(event.target.value)}
      />
      <input
        className="gcms-input"
        {...inputProps}
        id={id}
        name={field.name}
        ref={field.ref}
        value={value}
        placeholder="#2f6feb"
        onChange={(event) => field.onChange(event.target.value)}
        onBlur={field.onBlur}
      />
    </div>
  )
}
