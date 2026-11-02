import { useEffect, useState } from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import { normalizePhone, phoneHref, type PhoneOptions } from '../phone.js'
import { fieldOptions, useField } from './field-utils.js'

/** A phone number input that accepts any common notation and shows the E.164 number it saves. */
export function PhoneField({ id, inputProps, parsedField }: AutoFormFieldProps) {
  const field = useField(id)
  const options = fieldOptions<PhoneOptions>(parsedField, 'phone')
  const code = options.defaultCountryCode?.replace(/^\+/, '')
  const normalize = (text: string) => normalizePhone(text, code)
  const value = typeof field.value === 'string' ? field.value : ''
  // People keep their own notation while typing; the form holds the normalized number.
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft((current) => (current === value || normalize(current) === value ? current : value))
  }, [value])

  const normalized = normalize(draft)
  const hintId = `${id}-hint`
  return (
    <div className="gcms-phone">
      <input
        type="tel"
        className="gcms-input"
        autoComplete="tel"
        placeholder={code ? undefined : '+31 20 123 4567'}
        aria-describedby={hintId}
        {...inputProps}
        id={id}
        name={field.name}
        ref={field.ref}
        value={draft}
        onChange={(event) => {
          const text = event.target.value
          setDraft(text)
          field.onChange(text.trim() === '' ? null : (normalize(text) ?? text))
        }}
        onBlur={field.onBlur}
      />
      <p className="gcms-description" id={hintId}>
        {normalized ? (
          <>
            Saved as <a href={phoneHref(normalized)}>{normalized}</a>
          </>
        ) : code ? (
          `Numbers without a country code get +${code}.`
        ) : (
          'Include the country code, like +31.'
        )}
      </p>
    </div>
  )
}
