import { z } from 'zod'
import {
  currencyDecimals,
  datetime,
  describeDuration,
  duration,
  durationInUnits,
  durationToSeconds,
  field,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatOffset,
  formatTime,
  fromMinorUnits,
  fromWallClock,
  geoPoint,
  isDateTime,
  money,
  normalizePhone,
  numberBounds,
  parseAmount,
  parseDateTime,
  parseDocument,
  parseDuration,
  phone,
  phoneHref,
  serializeDocument,
  slider,
  splitDuration,
  time,
  timeZoneOffset,
  toMinorUnits,
  toWallClock,
} from '../src'

const messages = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  result.error?.issues.map((issue) => issue.message) ?? []

/** The editor config attached with `.check()`, as AutoForm finds it. */
function configOf(schema: z.ZodType) {
  for (const check of (schema._zod.def.checks ?? []) as unknown as Array<{ _zod: { check: Record<symbol, unknown> } }>) {
    const symbol = Object.getOwnPropertySymbols(check._zod.check)[0]
    if (symbol) return check._zod.check[symbol] as { fieldType?: string; customData?: Record<string, unknown> }
  }
  throw new Error('No field config')
}

describe('datetime', () => {
  it('parses ISO 8601 date-times and rejects impossible ones', () => {
    expect(parseDateTime('2026-11-20T19:30:00+01:00')).toEqual({ year: 2026, month: 11, day: 20, hour: 19, minute: 30, second: 0, offset: 60 })
    expect(parseDateTime('2026-11-20T19:30Z')?.offset).toBe(0)
    expect(parseDateTime('2026-11-20T19:30:15.250-05:30')).toMatchObject({ second: 15, offset: -330 })
    expect(parseDateTime('2026-11-20T19:30')?.offset).toBeUndefined()
    for (const bad of ['2026-02-30T10:00Z', '2026-11-20T24:00Z', '2026-11-20', '2026-11-20 19:30', '19:30']) {
      expect(parseDateTime(bad)).toBeUndefined()
    }
  })

  it('validates the format of each time zone mode', () => {
    expect(isDateTime('2026-11-20T19:30:00+01:00')).toBe(true)
    expect(isDateTime('2026-11-20T19:30:00')).toBe(false)
    expect(isDateTime('2026-11-20T19:30:00', 'floating')).toBe(true)
    expect(isDateTime('2026-11-20T18:30:00Z', 'floating')).toBe(false)

    expect(datetime().parse('2026-11-20T19:30:00+01:00')).toBe('2026-11-20T19:30:00+01:00')
    expect(messages(datetime({ timeZone: 'UTC' }).safeParse('2026-11-20'))).toEqual(['Use a date and time like 2026-11-20T18:30:00Z'])
    expect(() => datetime({ timeZone: 'Mars/Olympus' })).toThrow(RangeError)
  })

  it('converts between stored values and clock time in a zone', () => {
    expect(formatOffset(60)).toBe('+01:00')
    expect(formatOffset(-330)).toBe('-05:30')
    expect(timeZoneOffset('Europe/Amsterdam', Date.UTC(2026, 10, 20))).toBe(60)
    expect(timeZoneOffset('Europe/Amsterdam', Date.UTC(2026, 6, 1))).toBe(120)
    expect(timeZoneOffset('America/St_Johns', Date.UTC(2026, 0, 1))).toBe(-210)

    expect(fromWallClock('2026-11-20T19:30', 'Europe/Amsterdam')).toBe('2026-11-20T19:30:00+01:00')
    expect(fromWallClock('2026-07-01T19:30', 'Europe/Amsterdam')).toBe('2026-07-01T19:30:00+02:00')
    expect(fromWallClock('2026-11-20T19:30', 'UTC')).toBe('2026-11-20T19:30:00Z')
    expect(fromWallClock('2026-11-20T19:30:15', 'floating')).toBe('2026-11-20T19:30:15')
    // 02:30 does not exist on the night clocks go forward; it lands on the moment an hour later.
    expect(fromWallClock('2026-03-29T02:30', 'Europe/Amsterdam')).toBe('2026-03-29T03:30:00+02:00')
    expect(fromWallClock('not a date', 'UTC')).toBeUndefined()

    expect(toWallClock('2026-11-20T18:30:00Z', 'Europe/Amsterdam')).toBe('2026-11-20T19:30')
    expect(toWallClock('2026-11-20T19:30:00+01:00', 'UTC', true)).toBe('2026-11-20T18:30:00')
    expect(toWallClock('2026-11-20T19:30:00+01:00', 'floating')).toBe('2026-11-20T19:30')
    expect(toWallClock('2026-11-20T19:30:00', 'Europe/Amsterdam')).toBe('2026-11-20T19:30')
    expect(toWallClock('2026-11-20', 'UTC')).toBe('2026-11-20T00:00')
    expect(toWallClock(new Date('2026-11-20T18:30:00Z'), 'UTC')).toBe('2026-11-20T18:30')
    expect(toWallClock(undefined)).toBe('')
  })

  it("uses the editor's own offset by default", () => {
    const stored = fromWallClock('2026-11-20T19:30', 'local')!
    expect(new Date(stored).getTime()).toBe(new Date(2026, 10, 20, 19, 30).getTime())
    expect(stored).toBe(formatDateTime(new Date(2026, 10, 20, 19, 30)))
    expect(toWallClock(stored)).toBe('2026-11-20T19:30')
  })

  it('round-trips through frontmatter, YAML and JSON unchanged', () => {
    const data = { starts: '2026-11-20T19:30:00+01:00', utc: '2026-11-20T18:30:00Z', floating: '2026-11-20T19:30:00', doors: '19:30' }
    for (const format of ['markdown', 'yaml', 'json'] as const) {
      const source = serializeDocument(format, { data, body: '' })
      expect(parseDocument(format, source).data).toEqual(data)
    }
    // Quoted, so YAML 1.1 loaders do not read the time as the number 1170.
    expect(serializeDocument('yaml', { data, body: '' })).toBe(
      'starts: 2026-11-20T19:30:00+01:00\nutc: 2026-11-20T18:30:00Z\nfloating: 2026-11-20T19:30:00\ndoors: "19:30"\n',
    )
    // Dates of z.coerce.date() keep their short form.
    expect(serializeDocument('yaml', { data: { date: new Date('2026-11-20') }, body: '' })).toBe('date: 2026-11-20\n')
  })
})

describe('time', () => {
  it('validates times with optional bounds', () => {
    const schema = time({ min: '09:00', max: '17:30' })
    expect(schema.parse('09:00')).toBe('09:00')
    expect(schema.parse('17:30')).toBe('17:30')
    expect(messages(schema.safeParse('08:59'))).toEqual(['Use 09:00 or later'])
    expect(messages(schema.safeParse('17:30:01'))).toEqual(['Use 17:30 or earlier'])
    expect(messages(time().safeParse('7:30'))).toEqual(['Use a time like 19:30'])
    expect(time().safeParse('24:00').success).toBe(false)
    expect(time().parse('19:30:15')).toBe('19:30:15')
  })

  it('normalizes picker values to the stored precision', () => {
    expect(formatTime('19:30:00')).toBe('19:30')
    expect(formatTime('19:30', true)).toBe('19:30:00')
    expect(formatTime('19:3')).toBeUndefined()
    expect(configOf(time({ label: 'Doors', step: 900 }))).toMatchObject({ label: 'Doors', fieldType: 'time', customData: { time: { step: 900 } } })
  })
})

describe('slider', () => {
  it('reads the range from the number schema', () => {
    expect(numberBounds(z.number().min(0).max(100))).toEqual({ min: 0, max: 100 })
    expect(numberBounds(z.number().int().min(12).max(24))).toEqual({ min: 12, max: 24, step: 1 })
    expect(numberBounds(z.number().gte(0).lte(1).multipleOf(0.05))).toEqual({ min: 0, max: 1, step: 0.05 })
    expect(numberBounds(z.int().min(1).max(5))).toEqual({ min: 1, max: 5, step: 1 })
    expect(numberBounds(z.number())).toEqual({})
  })

  it('remembers the final schema it is attached to, whatever the order', () => {
    const schema = z.number().check(slider({ label: 'Volume', unit: '%' })).min(0).max(100).optional()
    const config = configOf(schema.unwrap())
    expect(config).toMatchObject({ label: 'Volume', fieldType: 'slider', customData: { slider: { unit: '%' } } })
    const attached = (config.customData!.slider as { schema: z.core.$ZodType }).schema
    expect(numberBounds(attached)).toEqual({ min: 0, max: 100 })
    expect(schema.parse(40)).toBe(40)
    expect(schema.safeParse(140).success).toBe(false)
  })
})

describe('money', () => {
  it('stores amounts in major units with the currency', () => {
    const price = money({ currencies: ['EUR', 'USD', 'JPY'] })
    expect(price.parse({ amount: 19.99, currency: 'EUR' })).toEqual({ amount: 19.99, currency: 'EUR' })
    expect(price.parse({ amount: 1500, currency: 'JPY' })).toEqual({ amount: 1500, currency: 'JPY' })
    expect(messages(price.safeParse({ amount: 19.999, currency: 'EUR' }))).toEqual(['Use at most 2 decimals'])
    expect(messages(price.safeParse({ amount: 1.5, currency: 'JPY' }))).toEqual(['JPY amounts have no decimals'])
    expect(messages(price.safeParse({ amount: 5, currency: 'GBP' }))).toEqual(['Use EUR, USD, JPY'])
    expect(messages(price.safeParse({ amount: -1, currency: 'EUR' }))).toEqual(['Use at least 0'])
    expect(messages(price.safeParse({ currency: 'EUR' }))).toEqual(['Enter an amount'])
    expect(messages(money().safeParse({ amount: 5, currency: 'euro' }))).toEqual(['Use a three-letter ISO 4217 code like EUR'])
    expect(messages(money({ currency: 'EUR' }).safeParse({ amount: 5, currency: 'USD' }))).toEqual(['Use EUR'])
    expect(configOf(money({ label: 'Price', currency: 'EUR', readOnly: true }))).toMatchObject({
      label: 'Price',
      fieldType: 'money',
      customData: { money: { currency: 'EUR' }, readOnly: true },
    })
  })

  it('converts to exact minor units', () => {
    expect(currencyDecimals('EUR')).toBe(2)
    expect(currencyDecimals('JPY')).toBe(0)
    expect(currencyDecimals('BHD')).toBe(3)
    expect(toMinorUnits({ amount: 19.99, currency: 'EUR' })).toBe(1999)
    expect(toMinorUnits({ amount: 0.29, currency: 'EUR' })).toBe(29)
    expect(fromMinorUnits(1999, 'EUR')).toEqual({ amount: 19.99, currency: 'EUR' })
    expect(fromMinorUnits(1500, 'JPY')).toEqual({ amount: 1500, currency: 'JPY' })
    expect(formatMoney({ amount: 1299.5, currency: 'EUR' }, 'en')).toBe('€1,299.50')
    expect(formatMoney({ amount: 1500, currency: 'JPY' }, 'en')).toBe('¥1,500')
  })

  it('reads amounts as people type them', () => {
    expect(parseAmount('19.99')).toBe(19.99)
    expect(parseAmount('19,99')).toBe(19.99)
    expect(parseAmount('1,299.50')).toBe(1299.5)
    expect(parseAmount('1.299,50')).toBe(1299.5)
    expect(parseAmount('1,000')).toBe(1000)
    expect(parseAmount('1.500', 3)).toBe(1.5)
    expect(parseAmount('1 000 000')).toBe(1_000_000)
    expect(parseAmount('€ 5')).toBe(5)
    expect(parseAmount('5 EUR')).toBe(5)
    expect(parseAmount("1'000")).toBe(1000)
    expect(parseAmount('.5')).toBe(0.5)
    expect(parseAmount('-3')).toBe(-3)
    expect(parseAmount('12abc')).toBeUndefined()
    expect(parseAmount('')).toBeUndefined()
  })
})

describe('duration', () => {
  it('parses and formats ISO 8601 durations', () => {
    expect(parseDuration('PT1H30M')).toEqual({ hours: 1, minutes: 30 })
    expect(parseDuration('P1DT2H')).toEqual({ days: 1, hours: 2 })
    expect(parseDuration('P2W')).toEqual({ days: 14 })
    expect(parseDuration('PT0S')).toEqual({ seconds: 0 })
    for (const bad of ['P', 'PT', 'P1M', 'P1Y', 'PT1.5H', '1h30', 'pt1h']) expect(parseDuration(bad)).toBeUndefined()

    expect(formatDuration({ hours: 1, minutes: 30 })).toBe('PT1H30M')
    expect(formatDuration({ days: 2, minutes: 5 })).toBe('P2DT5M')
    expect(formatDuration({ hours: 0, minutes: 0 })).toBe('PT0S')
    expect(durationToSeconds('P1DT1H30M15S')).toBe(86_400 + 5415)
  })

  it('splits and describes durations', () => {
    expect(splitDuration(5400, ['hours', 'minutes'])).toEqual({ hours: 1, minutes: 30 })
    expect(splitDuration(5430, ['minutes'])).toEqual({ minutes: 91 })
    expect(durationInUnits('PT90M', ['hours', 'minutes'])).toEqual({ minutes: 90 })
    expect(durationInUnits('P1DT1H', ['hours', 'minutes'])).toEqual({ hours: 25, minutes: 0 })
    expect(describeDuration('PT1H30M', 'en')).toBe('1 hour, 30 minutes')
    expect(describeDuration('P2D', 'en')).toBe('2 days')
    expect(describeDuration('PT0S', 'en')).toBe('0 seconds')
  })

  it('validates stored durations', () => {
    expect(duration().parse('PT45M')).toBe('PT45M')
    expect(messages(duration().safeParse('45 minutes'))).toEqual(['Use an ISO 8601 duration like PT1H30M'])
    expect(configOf(duration({ units: ['minutes'] })).customData).toEqual({ duration: { units: ['minutes'] } })
  })
})

describe('phone', () => {
  it('normalizes common notations to E.164', () => {
    expect(normalizePhone('+31 20 123 4567')).toBe('+31201234567')
    expect(normalizePhone('+31 (0)20-123 45 67')).toBe('+31201234567')
    expect(normalizePhone('0031 20 1234567')).toBe('+31201234567')
    expect(normalizePhone('020 123 4567', '31')).toBe('+31201234567')
    expect(normalizePhone('020 123 4567', '+31')).toBe('+31201234567')
    expect(normalizePhone('(212) 555-0123', '1')).toBe('+12125550123')
    expect(normalizePhone('1-212-555-0123', '1')).toBe('+12125550123')
    expect(normalizePhone('06 1234 5678', '39')).toBe('+390612345678')
    expect(normalizePhone('020 123 4567')).toBeUndefined()
    expect(normalizePhone('+31 20 CALL NOW')).toBeUndefined()
    expect(normalizePhone('+123')).toBeUndefined()
    expect(normalizePhone('+1234567890123456')).toBeUndefined()
    expect(phoneHref('+31 20 123 4567')).toBe('tel:+31201234567')
  })

  it('saves the normalized number', () => {
    expect(phone().parse('+31 20 123 4567')).toBe('+31201234567')
    expect(phone({ defaultCountryCode: '31' }).parse('020-1234567')).toBe('+31201234567')
    expect(messages(phone().safeParse('020 123 4567'))).toEqual([
      'Enter a valid phone number, with the country code, like +31 20 123 4567',
    ])
    // Validating a saved value again leaves it as is.
    expect(phone().parse(phone().parse('0031201234567'))).toBe('+31201234567')
  })
})

describe('read-only and hidden fields', () => {
  it('keeps the flags in customData, next to helper options', () => {
    expect(configOf(z.string().check(field({ label: 'ID', readOnly: true })))).toEqual({ label: 'ID', customData: { readOnly: true, hidden: undefined } })
    expect(configOf(z.string().check(field({ hidden: true, customData: { x: 1 } }))).customData).toEqual({ x: 1, readOnly: undefined, hidden: true })
    expect(configOf(z.string().check(field({ label: 'Plain' })))).toEqual({ label: 'Plain' })
    expect(configOf(geoPoint({ readOnly: true, zoom: 4 })).customData).toMatchObject({ map: { zoom: 4 }, readOnly: true })
    expect(configOf(datetime({ hidden: true, timeZone: 'UTC' })).customData).toEqual({ datetime: { timeZone: 'UTC' }, readOnly: undefined, hidden: true })
  })
})
