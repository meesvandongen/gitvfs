import { z } from 'zod'
import { fieldWithOptions, type FieldOptions } from './field-options.js'

// Money is stored as `{ amount, currency }`: the amount a number in major units (19.99 euros), the
// currency an ISO 4217 code. That is what people expect to read and type in a content file, unlike
// Stripe-style minor units (1999) whose scale depends on the currency. A decimal number in a file is
// exact as text, and JSON and YAML parsers return the closest double, which prints back the same;
// float trouble only starts with arithmetic. The schema allows only as many decimals as the
// currency has, so `toMinorUnits` gives exact integers (cents) to calculate with.

/** An amount in major units (`19.99`) and an ISO 4217 currency code (`'EUR'`). */
export interface Money {
  amount: number
  currency: string
}

export interface MoneyOptions {
  /** Fix the currency: no currency picker is shown and other currencies are rejected. */
  currency?: string
  /** Currencies to choose from; the first is preselected. Default: every ISO 4217 code the browser knows. */
  currencies?: string[]
  /** Smallest amount. Default: 0. */
  min?: number
  /** Largest amount. */
  max?: number
  /** Locale for the formatted amount and currency names. Default: the browser's. */
  locale?: string
}

/** Where money fields keep their options in AutoForm's `customData`. */
export interface MoneyCustomData {
  money?: MoneyOptions
}

const CURRENCY = /^[A-Z]{3}$/

/** The most used currencies, for runtimes without `Intl.supportedValuesOf`. */
const COMMON_CURRENCIES = ['AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'DKK', 'EUR', 'GBP', 'HKD', 'INR', 'JPY', 'KRW', 'MXN', 'NOK', 'NZD', 'PLN', 'SEK', 'SGD', 'USD', 'ZAR']

/** ISO 4217 codes known to this runtime, sorted. */
export function currencyCodes(): string[] {
  try {
    return Intl.supportedValuesOf('currency')
  } catch {
    return COMMON_CURRENCIES
  }
}

/** Number of decimals a currency uses: 2 for EUR, 0 for JPY, 3 for BHD. */
export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** Number of decimals of `value` as written: 19.99 → 2, 1e-7 → 7. */
export function decimalPlaces(value: number): number {
  const [digits, exponent] = String(value).split('e')
  const fraction = digits.split('.')[1]?.length ?? 0
  return Math.max(0, fraction - Number(exponent ?? 0))
}

/** `€19.99`, `¥1,500`. */
export function formatMoney(value: Money, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: value.currency }).format(value.amount)
  } catch {
    return `${value.amount} ${value.currency}`
  }
}

/** The amount in the currency's minor units, as an exact integer: `{ amount: 19.99, currency: 'EUR' }` → 1999. */
export function toMinorUnits(value: Money): number {
  return Math.round(value.amount * 10 ** currencyDecimals(value.currency))
}

/** From minor units back to a money value: `fromMinorUnits(1999, 'EUR')` → `{ amount: 19.99, currency: 'EUR' }`. */
export function fromMinorUnits(minor: number, currency: string): Money {
  const decimals = currencyDecimals(currency)
  return { amount: Number((minor / 10 ** decimals).toFixed(decimals)), currency }
}

/**
 * Read an amount as people type it: `19.99`, `19,99`, `1,299.50`, `1.299,50`, `€ 5`. The last `.` or
 * `,` is the decimal separator when other separators come before it, or when it is not followed by
 * exactly three digits: `1,000` is a thousand, unless the currency has three `decimals` (`1.500` BHD).
 * Returns `undefined` when the text is not a number.
 */
export function parseAmount(text: string, decimals = 2): number | undefined {
  // Spaces and apostrophes group digits (`1 000`, Swiss `1'000`); a currency sign or code may surround it.
  let cleaned = text.replace(/[\s'’]/g, '').replace(/^(?:\p{Sc}|[A-Z]{3})|(?:\p{Sc}|[A-Z]{3})$/gu, '')
  const separators = cleaned.match(/[.,]/g) ?? []
  if (separators.length > 0) {
    const last = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','))
    const digitsAfter = cleaned.length - last - 1
    const isDecimal = separators.length === 1 ? digitsAfter !== 3 || decimals >= 3 : cleaned[last] !== separators[0]
    const integer = cleaned.slice(0, last).replace(/[.,]/g, '')
    cleaned = isDecimal ? `${integer}.${cleaned.slice(last + 1)}` : integer + cleaned.slice(last + 1)
  }
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return undefined
  return Number(cleaned)
}

/**
 * An amount of money: `{ amount: 19.99, currency: 'EUR' }`.
 *
 * ```ts
 * price: money({ label: 'Price', currencies: ['EUR', 'USD', 'GBP'] })
 * fee: money({ label: 'Fee', currency: 'EUR' })
 * ```
 */
export function money(config: FieldOptions<MoneyOptions> = {}) {
  const min = config.min ?? 0
  let amount = z.number({ error: 'Enter an amount' }).min(min, `Use at least ${min}`)
  if (config.max !== undefined) amount = amount.max(config.max, `Use at most ${config.max}`)

  const allowed = config.currency ? [config.currency] : config.currencies
  let currency = z.string({ error: 'Choose a currency' }).regex(CURRENCY, 'Use a three-letter ISO 4217 code like EUR')
  if (allowed) currency = currency.refine((code) => allowed.includes(code), `Use ${allowed.join(', ')}`)

  return z
    .object({ amount, currency })
    .superRefine((value, context) => {
      const decimals = currencyDecimals(value.currency)
      if (decimalPlaces(value.amount) <= decimals) return
      const message = decimals === 0 ? `${value.currency} amounts have no decimals` : `Use at most ${decimals} decimals`
      context.addIssue({ code: 'custom', path: ['amount'], message })
    })
    .check(fieldWithOptions(config, ['currency', 'currencies', 'min', 'max', 'locale'], 'money'))
}
