import { z } from 'zod'
import { fieldWithOptions, type FieldOptions } from './field-options.js'

// Phone numbers are stored in E.164 (`+31201234567`): one canonical form that `tel:` links, SMS
// APIs and phone libraries all accept, and that compares equal however it was typed. Input is
// lenient (`020 123 4567`, `+31 (0)20-123 4567`, `0031 20 1234567`). Without libphonenumber's
// metadata only the shape is checked: 7 to 15 digits after the `+`, no per-country lengths.

export interface PhoneOptions {
  /** Country calling code for numbers typed without one, such as `'31'` or `'+1'`. */
  defaultCountryCode?: string
}

/** Where phone fields keep their options in AutoForm's `customData`. */
export interface PhoneCustomData {
  phone?: PhoneOptions
}

const E164 = /^\+[1-9]\d{6,14}$/
/** Countries whose national numbers keep their leading 0 after the country code (Italy, San Marino). */
const KEEPS_TRUNK_ZERO = new Set(['39', '378'])

/** Whether `value` is an E.164 number: `+` and 7 to 15 digits. */
export function isPhoneNumber(value: unknown): value is string {
  return typeof value === 'string' && E164.test(value)
}

/**
 * Normalize a phone number to E.164. Accepts spaces, dashes, dots, slashes and parentheses, a `00`
 * international prefix, and `+31 (0)20…`. A national number (`020 123 4567`) needs
 * `defaultCountryCode`; its leading trunk 0 is dropped, or the leading 1 for country code 1.
 * Returns `undefined` when the result is not a valid E.164 number.
 */
export function normalizePhone(input: string, defaultCountryCode?: string): string | undefined {
  let text = input.trim().replace(/^\+\s*(\d+)\s*\(0\)/, '+$1')
  if (!/^\+?[\d\s\-./() ]+$/.test(text)) return undefined
  text = text.replace(/[^\d+]/g, '')
  let number: string | undefined
  if (text.startsWith('+')) number = text
  else if (text.startsWith('00')) number = `+${text.slice(2)}`
  else if (defaultCountryCode) {
    const code = defaultCountryCode.replace(/^\+/, '')
    let national = text
    if (code === '1') national = national.replace(/^1(?=\d{10}$)/, '')
    else if (!KEEPS_TRUNK_ZERO.has(code)) national = national.replace(/^0/, '')
    number = `+${code}${national}`
  }
  return number !== undefined && E164.test(number) ? number : undefined
}

/** A `tel:` link for a stored number: `tel:+31201234567`. */
export function phoneHref(value: string): string {
  return `tel:${normalizePhone(value) ?? value.replace(/[^\d+]/g, '')}`
}

/**
 * A phone number, stored in E.164: `+31201234567`. Typed numbers are normalized on save.
 *
 * ```ts
 * phone: phone({ label: 'Phone', defaultCountryCode: '31' }).optional()
 * ```
 */
export function phone(config: FieldOptions<PhoneOptions> = {}) {
  const example = config.defaultCountryCode ? '' : ', with the country code, like +31 20 123 4567'
  return z
    .string()
    .transform((value, context) => {
      const normalized = normalizePhone(value, config.defaultCountryCode)
      if (normalized === undefined) {
        context.addIssue({ code: 'custom', message: `Enter a valid phone number${example}` })
        return z.NEVER
      }
      return normalized
    })
    .check(fieldWithOptions(config, ['defaultCountryCode'], 'phone'))
}
