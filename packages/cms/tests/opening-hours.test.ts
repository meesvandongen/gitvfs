import { z } from 'zod'
import {
  hoursOn,
  isOpenAt,
  isOvernight,
  openingHours,
  openingHoursIssues,
  toOpeningHoursSpecification,
  toOsmOpeningHours,
  wallClockAt,
  type OpeningHours,
} from '../src'

const office: OpeningHours = {
  mon: [
    { opens: '09:00', closes: '12:30' },
    { opens: '13:30', closes: '17:30' },
  ],
  tue: [
    { opens: '09:00', closes: '12:30' },
    { opens: '13:30', closes: '17:30' },
  ],
  wed: [{ opens: '09:00', closes: '12:30' }],
  thu: [
    { opens: '09:00', closes: '12:30' },
    { opens: '13:30', closes: '17:30' },
  ],
  fri: [
    { opens: '09:00', closes: '12:30' },
    { opens: '13:30', closes: '17:30' },
  ],
  sat: [{ opens: '10:00', closes: '16:00' }],
  sun: [],
  exceptions: [
    { date: '2026-12-24', label: 'Christmas Eve', hours: [{ opens: '09:00', closes: '14:00' }] },
    { date: '2026-12-25', until: '2026-12-26', label: 'Christmas', hours: [] },
  ],
}

const bar: OpeningHours = {
  thu: [{ opens: '17:00', closes: '00:00' }],
  fri: [{ opens: '17:00', closes: '03:00' }],
  sat: [{ opens: '14:00', closes: '04:00' }],
  sun: [{ opens: '14:00', closes: '22:00' }],
  exceptions: [{ date: '2026-12-26', hours: [] }],
}

const AMS = { timeZone: 'Europe/Amsterdam' }

describe('opening hours schema', () => {
  const schema = openingHours({ label: 'Hours' })
  const messages = (value: unknown, s = schema) => s.safeParse(value).error?.issues.map((issue) => issue.message) ?? []

  it('accepts a week with breaks, closed days, past-midnight hours and special dates', () => {
    expect(schema.parse(office)).toEqual(office)
    expect(schema.parse(bar)).toEqual(bar)
    expect(schema.parse({})).toEqual({})
    expect(schema.parse({ mon: [{ opens: '00:00', closes: '24:00' }], tue: [{ opens: '00:00', closes: '00:00' }] })).toBeTruthy()
    expect(z.object({ hours: schema.optional() }).parse({})).toEqual({})
  })

  it('rejects malformed times and dates', () => {
    expect(messages({ mon: [{ opens: '9:00', closes: '17:00' }] })).toEqual(['Use a 24-hour time like 09:00'])
    expect(messages({ mon: [{ opens: '09:00', closes: '24:30' }] })).toEqual(['Use a 24-hour time like 09:00'])
    expect(messages({ mon: [{ opens: '24:00', closes: '02:00' }] })).toEqual(['Use a 24-hour time like 09:00'])
    expect(messages({ exceptions: [{ date: '2026-02-30', hours: [] }] })).toEqual(['Use a date like 2026-12-25'])
  })

  it('finds overlapping intervals, also across midnight', () => {
    const issues = openingHoursIssues({
      mon: [
        { opens: '13:00', closes: '17:00' },
        { opens: '09:00', closes: '14:00' },
      ],
      fri: [{ opens: '22:00', closes: '03:00' }],
      sat: [{ opens: '02:00', closes: '10:00' }],
      sun: [{ opens: '20:00', closes: '02:00' }],
    })
    expect(issues).toEqual([
      { path: ['mon', 0, 'opens'], message: 'Monday: 13:00–17:00 overlaps 09:00–14:00' },
      { path: ['sat', 0, 'opens'], message: "Saturday: 02:00–10:00 starts before Friday's 22:00–03:00 ends" },
    ])
    // Sunday night runs into Monday morning: Monday opens at 09:00, after it ends.
    expect(openingHoursIssues({ sun: [{ opens: '20:00', closes: '02:00' }], mon: [{ opens: '01:00', closes: '05:00' }] })[0].message).toBe(
      "Monday: 01:00–05:00 starts before Sunday's 20:00–02:00 ends",
    )
    // Touching intervals do not overlap.
    expect(openingHoursIssues({ mon: [{ opens: '09:00', closes: '12:00' }, { opens: '12:00', closes: '18:00' }] })).toEqual([])
  })

  it('can forbid hours past midnight', () => {
    const noNights = openingHours({ overnight: false })
    expect(messages({ fri: [{ opens: '18:00', closes: '02:00' }] }, noNights)).toEqual(['Friday: 18:00–02:00 closes before it opens'])
    // Closing at midnight is not past it.
    expect(messages({ fri: [{ opens: '18:00', closes: '00:00' }] }, noNights)).toEqual([])
    expect(messages({ fri: [{ opens: '18:00', closes: '24:00' }] }, noNights)).toEqual([])
  })

  it('checks special dates', () => {
    expect(
      openingHoursIssues({
        exceptions: [
          { date: '2026-12-31', until: '2026-12-30', label: 'New Year', hours: [] },
          { date: '2026-12-24', until: '2026-12-26', label: 'Christmas', hours: [] },
          { date: '2026-12-26', hours: [{ opens: '10:00', closes: '12:00' }, { opens: '11:00', closes: '13:00' }] },
        ],
      }).map((issue) => issue.message),
    ).toEqual([
      'New Year: the last day is before the first',
      '2026-12-26: 11:00–13:00 overlaps 10:00–12:00',
      'Special dates overlap: Christmas and 2026-12-26',
    ])
  })
})

describe('isOpenAt', () => {
  const at = (iso: string) => new Date(iso)

  it('follows the week, lunch breaks and closed days', () => {
    // 2 Nov 2026 is a Monday; Amsterdam is at UTC+1.
    expect(isOpenAt(office, at('2026-11-02T07:59:00Z'), AMS)).toBe(false) // 08:59
    expect(isOpenAt(office, at('2026-11-02T08:00:00Z'), AMS)).toBe(true) // 09:00, opening minute
    expect(isOpenAt(office, at('2026-11-02T11:45:00Z'), AMS)).toBe(false) // 12:45, lunch
    expect(isOpenAt(office, at('2026-11-02T16:29:00Z'), AMS)).toBe(true) // 17:29
    expect(isOpenAt(office, at('2026-11-02T16:30:00Z'), AMS)).toBe(false) // 17:30, closing minute
    expect(isOpenAt(office, at('2026-11-08T12:00:00Z'), AMS)).toBe(false) // Sunday
  })

  it('uses special dates instead of the week', () => {
    expect(isOpenAt(office, at('2026-12-24T12:00:00Z'), AMS)).toBe(true) // Thursday 13:00, short day
    expect(isOpenAt(office, at('2026-12-24T14:00:00Z'), AMS)).toBe(false) // 15:00
    expect(isOpenAt(office, at('2026-12-25T10:00:00Z'), AMS)).toBe(false) // Christmas, a Friday
    expect(isOpenAt(office, at('2026-12-26T10:00:00Z'), AMS)).toBe(false) // Boxing Day, a Saturday
    expect(hoursOn(office, '2026-12-26')).toEqual([])
    expect(hoursOn(office, '2026-12-27')).toEqual([])
    expect(hoursOn(office, '2026-12-28')).toEqual(office.mon)
  })

  it('stays open past midnight', () => {
    // Friday 6 Nov 2026 at 23:00 and Saturday at 02:59 in Amsterdam.
    expect(isOpenAt(bar, at('2026-11-06T22:00:00Z'), AMS)).toBe(true)
    expect(isOpenAt(bar, at('2026-11-07T01:59:00Z'), AMS)).toBe(true)
    expect(isOpenAt(bar, at('2026-11-07T02:00:00Z'), AMS)).toBe(false)
    // Thursday closes at midnight exactly.
    expect(isOpenAt(bar, at('2026-11-05T22:59:00Z'), AMS)).toBe(true)
    expect(isOpenAt(bar, at('2026-11-05T23:00:00Z'), AMS)).toBe(false)
    // Christmas night: Friday 25 Dec runs into Saturday 26 Dec, a closed special date.
    expect(isOpenAt(bar, at('2026-12-26T01:00:00Z'), AMS)).toBe(true)
    expect(isOpenAt(bar, at('2026-12-26T15:00:00Z'), AMS)).toBe(false)
    // ... and Saturday's night does not happen, so Sunday 27 Dec at 01:00 is closed.
    expect(isOpenAt(bar, at('2026-12-27T00:00:00Z'), AMS)).toBe(false)
    expect(isOvernight(bar.fri![0])).toBe(true)
    expect(isOvernight(bar.thu![0])).toBe(false)
  })

  it('reads hours as local times across daylight saving time changes', () => {
    // Clocks go forward in the night of Saturday 27 to Sunday 28 March 2027 (02:00 → 03:00).
    // The bar closes at 04:00 local time, which is 02:00 UTC after the change instead of 03:00.
    expect(isOpenAt(bar, at('2027-03-28T00:59:00Z'), AMS)).toBe(true) // 01:59 CET
    expect(isOpenAt(bar, at('2027-03-28T01:30:00Z'), AMS)).toBe(true) // 03:30 CEST
    expect(isOpenAt(bar, at('2027-03-28T02:00:00Z'), AMS)).toBe(false) // 04:00 CEST
    // Clocks go back in the night of Saturday 24 to Sunday 25 October 2026 (03:00 → 02:00).
    expect(isOpenAt(bar, at('2026-10-25T02:30:00Z'), AMS)).toBe(true) // 03:30 CET, an hour longer
    expect(isOpenAt(bar, at('2026-10-25T03:00:00Z'), AMS)).toBe(false) // 04:00 CET
    // Sunday opens at 14:00 local, 13:00 UTC in winter.
    expect(isOpenAt(bar, at('2026-10-25T12:59:00Z'), AMS)).toBe(false)
    expect(isOpenAt(bar, at('2026-10-25T13:00:00Z'), AMS)).toBe(true)
  })

  it('uses the runtime time zone without a timeZone', () => {
    const now = new Date('2026-11-02T12:00:00Z')
    const local = wallClockAt(now)
    const hours: OpeningHours = { [(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const)[local.weekday]]: [{ opens: local.time, closes: '24:00' }] }
    expect(isOpenAt(hours, now)).toBe(true)
    expect(wallClockAt(now, 'Asia/Tokyo')).toEqual({ date: '2026-11-02', time: '21:00', weekday: 0, minutes: 1260 })
  })
})

describe('toOpeningHoursSpecification', () => {
  it('groups days with the same hours and adds special dates', () => {
    expect(toOpeningHoursSpecification(office)).toEqual([
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '09:00', closes: '12:30' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Thursday', 'Friday'], opens: '13:30', closes: '17:30' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Saturday'], opens: '10:00', closes: '16:00' },
      { '@type': 'OpeningHoursSpecification', opens: '09:00', closes: '14:00', validFrom: '2026-12-24', validThrough: '2026-12-24' },
      { '@type': 'OpeningHoursSpecification', opens: '00:00', closes: '00:00', validFrom: '2026-12-25', validThrough: '2026-12-26' },
    ])
  })

  it('writes the end of the day as 23:59 and keeps past-midnight closing times', () => {
    expect(
      toOpeningHoursSpecification({
        mon: [{ opens: '00:00', closes: '00:00' }],
        tue: [{ opens: '00:00', closes: '24:00' }],
        thu: [{ opens: '17:00', closes: '00:00' }],
        fri: [{ opens: '18:00', closes: '03:00' }],
      }).map(({ dayOfWeek, opens, closes }) => [dayOfWeek?.join(), opens, closes]),
    ).toEqual([
      ['Monday', '00:00', '23:59'],
      ['Tuesday', '00:00', '23:59'],
      ['Thursday', '17:00', '23:59'],
      ['Friday', '18:00', '03:00'],
    ])
  })

  it('can leave out special dates that are over', () => {
    expect(toOpeningHoursSpecification(office, { from: '2026-12-25' }).filter((spec) => spec.validFrom).map((spec) => spec.validFrom)).toEqual(['2026-12-25'])
    expect(toOpeningHoursSpecification(office, { from: '2026-12-27' }).some((spec) => spec.validFrom)).toBe(false)
  })
})

describe('toOsmOpeningHours', () => {
  it('writes the OpenStreetMap syntax', () => {
    expect(toOsmOpeningHours(office)).toBe(
      'Mo,Tu,Th,Fr 09:00-12:30,13:30-17:30; We 09:00-12:30; Sa 10:00-16:00; 2026 Dec 24 09:00-14:00; 2026 Dec 25-26 off',
    )
    expect(toOsmOpeningHours(bar)).toBe('Th 17:00-24:00; Fr 17:00-03:00; Sa 14:00-04:00; Su 14:00-22:00; 2026 Dec 26 off')
    const weekdays = [{ opens: '08:00', closes: '18:00' }]
    expect(toOsmOpeningHours({ mon: weekdays, tue: weekdays, wed: weekdays, thu: weekdays, fri: weekdays, sun: weekdays })).toBe('Mo-Fr,Su 08:00-18:00')
    expect(toOsmOpeningHours({ mon: [{ opens: '00:00', closes: '00:00' }] })).toBe('Mo 00:00-24:00')
    expect(toOsmOpeningHours({})).toBe('off')
    expect(toOsmOpeningHours({ exceptions: [{ date: '2026-12-24', until: '2027-01-02', hours: [] }, { date: '2027-07-20', until: '2027-08-14', hours: [] }] })).toBe(
      'off; 2026 Dec 24-2027 Jan 02 off; 2027 Jul 20-Aug 14 off',
    )
  })
})
