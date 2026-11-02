import { z } from 'zod'
import { dateRange, describeRangeLength, formatDateRange, isDateRange, rangeLength } from '../src'

// Intl puts thin or narrow no-break spaces around range dashes; compare with plain spaces.
const plain = (text: string) => text.replace(/[   ]/g, ' ')

describe('dateRange schema', () => {
  it('stores dates and checks that the end is not before the start', () => {
    const schema = dateRange({ label: 'Dates' })
    expect(schema.parse({ start: '2026-11-20', end: '2026-11-22' })).toEqual({ start: '2026-11-20', end: '2026-11-22' })
    expect(schema.parse({ start: '2026-11-20', end: '2026-11-20' }).end).toBe('2026-11-20')
    const issue = schema.safeParse({ start: '2026-11-22', end: '2026-11-20' }).error!.issues[0]
    expect(issue).toMatchObject({ path: ['end'], message: 'The end is before the start' })
    expect(schema.safeParse({ start: '2026-02-30', end: '2026-03-01' }).error?.issues[0].message).toBe('Use a date like 2026-11-20')
    expect(schema.safeParse({ start: '2026-11-20T10:00', end: '2026-11-21' }).error?.issues[0].message).toBe('Use a date like 2026-11-20')
    expect(z.object({ dates: schema.optional() }).parse({})).toEqual({})
  })

  it('stores local date-times with `time`', () => {
    const schema = dateRange({ time: true })
    expect(schema.parse({ start: '2026-11-20T19:30', end: '2026-11-20T22:00' }).start).toBe('2026-11-20T19:30')
    expect(schema.safeParse({ start: '2026-11-20T19:30', end: '2026-11-20T19:00' }).error?.issues[0].path).toEqual(['end'])
    expect(schema.safeParse({ start: '2026-11-20', end: '2026-11-21' }).error?.issues[0].message).toBe('Use a date and time like 2026-11-20T19:30')
    expect(schema.safeParse({ start: '2026-11-20T19:30Z', end: '2026-11-21T10:00' }).success).toBe(false)
  })

  it('bounds the length in days or nights', () => {
    const nights = dateRange({ unit: 'nights', minLength: 2, maxLength: 14 })
    expect(nights.safeParse({ start: '2026-11-20', end: '2026-11-21' }).error?.issues[0]).toMatchObject({ path: ['end'], message: 'Choose at least 2 nights' })
    expect(nights.safeParse({ start: '2026-11-20', end: '2026-11-22' }).success).toBe(true)
    expect(nights.safeParse({ start: '2026-11-20', end: '2026-12-05' }).error?.issues[0].message).toBe('Choose at most 14 nights')
    const days = dateRange({ maxLength: 1 })
    expect(days.safeParse({ start: '2026-11-20', end: '2026-11-20' }).success).toBe(true)
    expect(days.safeParse({ start: '2026-11-20', end: '2026-11-21' }).error?.issues[0].message).toBe('Choose at most 1 day')
  })
})

describe('date range helpers', () => {
  it('measures ranges across month and year ends', () => {
    expect(rangeLength({ start: '2026-11-20', end: '2026-11-22' })).toBe(3)
    expect(rangeLength({ start: '2026-11-20', end: '2026-11-22' }, 'nights')).toBe(2)
    expect(rangeLength({ start: '2028-02-28', end: '2028-03-01' })).toBe(3) // leap day
    expect(rangeLength({ start: '2026-12-30', end: '2027-01-02' }, 'nights')).toBe(3)
    // Wall-clock dates: the night clocks change is still one night.
    expect(rangeLength({ start: '2026-10-24', end: '2026-10-26' }, 'nights')).toBe(2)
    expect(rangeLength({ start: 'x', end: '2026-10-26' })).toBeUndefined()
  })

  it('describes the length', () => {
    expect(describeRangeLength({ start: '2026-11-20', end: '2026-11-22' })).toBe('3 days')
    expect(describeRangeLength({ start: '2026-11-20', end: '2026-11-21' }, 'nights')).toBe('1 night')
    expect(describeRangeLength({ start: '2026-11-20T19:30', end: '2026-11-20T22:00' })).toBe('2 h 30 min')
    expect(describeRangeLength({ start: '2026-11-20T19:30', end: '2026-11-20T20:00' })).toBe('30 min')
    expect(describeRangeLength({ start: '2026-11-20T10:00', end: '2026-11-22T18:00' })).toBe('3 days')
    expect(describeRangeLength({ start: '2026-11-20T15:00', end: '2026-11-22T11:00' }, 'nights')).toBe('2 nights')
    expect(describeRangeLength({ start: '2026-11-22', end: '2026-11-20' })).toBe('')
  })

  it('formats the range with shared parts once', () => {
    expect(plain(formatDateRange({ start: '2026-11-20', end: '2026-11-22' }, 'en-GB'))).toMatch(/^20 ?– ?22 Nov 2026$/)
    expect(plain(formatDateRange({ start: '2026-11-30', end: '2026-12-02' }, 'en-GB'))).toBe('30 Nov – 2 Dec 2026')
    expect(plain(formatDateRange({ start: '2026-12-28', end: '2027-01-03' }, 'en-GB'))).toBe('28 Dec 2026 – 3 Jan 2027')
    expect(plain(formatDateRange({ start: '2026-11-20', end: '2026-11-20' }, 'en-GB'))).toBe('20 Nov 2026')
    expect(plain(formatDateRange({ start: '2026-11-20T19:30', end: '2026-11-20T22:00' }, 'en-GB'))).toMatch(/^20 Nov 2026, 19:30 ?– ?22:00$/)
    expect(formatDateRange({ start: '', end: '2026-11-20' })).toBe('')
  })

  it('recognizes range values', () => {
    expect(isDateRange({ start: '2026-11-20', end: '2026-11-22' })).toBe(true)
    expect(isDateRange({ start: '2026-11-20' })).toBe(false)
    expect(isDateRange(null)).toBe(false)
  })
})
