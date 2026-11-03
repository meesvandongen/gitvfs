import { useEffect, useMemo, useState } from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import {
  currencyCodes,
  currencyDecimals,
  decimalPlaces,
  formatMoney,
  parseAmount,
  type Money,
  type MoneyOptions,
} from '../money.js'
import { NestedErrors, fieldOptions, useDraft, useField } from './field-utils.js'

function currencyName(code: string, locale?: string): string | undefined {
  try {
    const name = new Intl.DisplayNames(locale, { type: 'currency' }).of(code)
    return name === code ? undefined : name
  } catch {
    return undefined
  }
}

/** An amount box with a currency picker (or a fixed currency) and the amount as it will be shown. */
export function MoneyField({ id, inputProps, parsedField }: AutoFormFieldProps) {
  const field = useField(id)
  const options = fieldOptions<MoneyOptions>(parsedField, 'money')
  const value = (field.value ?? undefined) as Partial<Money> | undefined
  const fixed = options.currency
  const codes = useMemo(() => (fixed ? [fixed] : (options.currencies ?? currencyCodes())), [fixed, options.currencies])

  // The chosen currency survives clearing the amount, which empties the field.
  const [currency, setCurrency] = useState(value?.currency ?? fixed ?? options.currencies?.[0])
  useEffect(() => {
    if (value?.currency) setCurrency(value.currency)
  }, [value?.currency])

  const decimals = currency ? currencyDecimals(currency) : 2
  const [draft, setDraft] = useDraft(
    value?.amount,
    (amount) => (Number.isFinite(amount) && decimalPlaces(amount) <= decimals ? amount.toFixed(decimals) : String(amount)),
    (text) => parseAmount(text, decimals),
  )

  const setAmount = (text: string) => {
    setDraft(text)
    if (text.trim() === '') field.onChange(null)
    // Unreadable text is kept as NaN, so validation stops it instead of saving the previous amount.
    else field.onChange({ amount: parseAmount(text, decimals) ?? Number.NaN, currency })
  }
  const chooseCurrency = (code: string) => {
    setCurrency(code || undefined)
    if (value?.amount !== undefined) field.onChange({ ...value, currency: code || undefined })
  }

  const complete = value && Number.isFinite(value.amount) && value.currency
  return (
    <div className="gcms-money-field">
      <div className="gcms-money">
        {fixed ? (
          <span className="gcms-money-currency" title={currencyName(fixed, options.locale)}>
            {fixed}
          </span>
        ) : (
          <select
            className="gcms-input gcms-money-select"
            aria-label="Currency"
            value={currency ?? ''}
            onChange={(event) => chooseCurrency(event.target.value)}
          >
            {currency === undefined ? <option value="">Currency</option> : null}
            {codes.map((code) => {
              const name = currencyName(code, options.locale)
              return (
                <option key={code} value={code}>
                  {name ? `${code} · ${name}` : code}
                </option>
              )
            })}
          </select>
        )}
        <input
          className="gcms-input"
          inputMode="decimal"
          autoComplete="off"
          {...inputProps}
          id={id}
          name={field.name}
          ref={field.ref}
          value={draft}
          onChange={(event) => setAmount(event.target.value)}
          onBlur={() => {
            // Pad to the currency's decimals: 19.9 shows as 19.90.
            if (complete && decimalPlaces(value.amount!) <= decimals) setDraft(value.amount!.toFixed(decimals))
            field.onBlur()
          }}
        />
      </div>
      {complete ? (
        <output className="gcms-description" htmlFor={id}>
          {formatMoney(value as Money, options.locale)}
        </output>
      ) : null}
      <NestedErrors name={id} />
    </div>
  )
}
