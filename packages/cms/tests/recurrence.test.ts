import { z } from 'zod'
import {
  describeRecurrence,
  expandRecurrence,
  formatRule,
  parseRule,
  recurrence,
  toICalendar,
  unsupportedParts,
  wallClockToDate,
} from '../src'

const expand = (start: string, rule: string, options?: Parameters<typeof expandRecurrence>[1]) =>
  expandRecurrence({ start, rule }, { limit: 10, ...options })

describe('parseRule', () => {
  it('reads the supported parts', () => {
    expect(parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU;UNTIL=20270301')).toEqual({
      freq: 'WEEKLY',
      interval: 2,
      byDay: [{ day: 'TU' }, { day: 'TH' }],
      wkst: 'SU',
      until: '2027-03-01',
    })
    expect(parseRule('RRULE:freq=monthly;byday=-1fr;count=3;')).toEqual({ freq: 'MONTHLY', byDay: [{ day: 'FR', n: -1 }], count: 3 })
    expect(parseRule('FREQ=YEARLY;BYMONTH=3;BYDAY=SU;BYSETPOS=-1;UNTIL=20300101T120000Z')).toEqual({
      freq: 'YEARLY',
      byMonth: [3],
      byDay: [{ day: 'SU' }],
      bySetPos: [-1],
      until: '2030-01-01T12:00:00Z',
    })
  })

  it('keeps parts it does not interpret, as written', () => {
    const rule = parseRule('FREQ=DAILY;BYHOUR=9,17;X-Acme-Note=yes')
    expect(rule.other).toEqual([
      ['BYHOUR', '9,17'],
      ['X-Acme-Note', 'yes'],
    ])
    expect(unsupportedParts(rule)).toEqual(['BYHOUR=9,17'])
    expect(unsupportedParts(parseRule('FREQ=HOURLY'))).toEqual(['FREQ=HOURLY'])
    expect(unsupportedParts(parseRule('FREQ=DAILY;X-NOTE=1'))).toEqual([])
  })

  it('explains what is wrong', () => {
    const message = (text: string) => {
      try {
        parseRule(text)
      } catch (error) {
        return (error as Error).message
      }
      return 'valid'
    }
    expect(message('')).toBe('The rule is empty')
    expect(message('INTERVAL=2')).toBe('The rule needs a FREQ, such as FREQ=WEEKLY')
    expect(message('FREQ=FORTNIGHTLY')).toBe('FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY, not FORTNIGHTLY')
    expect(message('FREQ=WEEKLY;INTERVAL=0')).toBe('INTERVAL must be 1 to 10000, not 0')
    expect(message('FREQ=WEEKLY;BYDAY=XX')).toBe('BYDAY must be a weekday (MO to SU), not XX')
    expect(message('FREQ=WEEKLY;BYDAY=2TU')).toBe('Numbered weekdays (2TU) only work in monthly and yearly rules')
    expect(message('FREQ=MONTHLY;BYMONTHDAY=32')).toBe('BYMONTHDAY must be ±1 to ±31, not 32')
    expect(message('FREQ=DAILY;COUNT=3;UNTIL=20270101')).toBe('Use COUNT or UNTIL, not both')
    expect(message('FREQ=DAILY;FREQ=WEEKLY')).toBe('FREQ appears twice')
    expect(message('FREQ=DAILY;UNTIL=2027-01-01')).toMatch(/^UNTIL must be a date/)
    expect(message('FREQ=DAILY;UNTIL=20270230')).toMatch(/^UNTIL must be a date/)
    expect(message('FREQ=MONTHLY;BYSETPOS=1')).toBe('BYSETPOS needs another BY… part to pick from')
    expect(message('FREQ=DAILY;BYHOUR')).toBe('Expected NAME=VALUE, not BYHOUR')
  })
})

describe('formatRule', () => {
  it('writes new rules in a conventional order and leaves out defaults', () => {
    expect(formatRule({ freq: 'WEEKLY', interval: 1, until: '2027-03-01', byDay: [{ day: 'TU' }] })).toBe('FREQ=WEEKLY;BYDAY=TU;UNTIL=20270301')
    expect(formatRule({ freq: 'MONTHLY', interval: 2, byDay: [{ day: 'TU', n: 2 }], count: 6 })).toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU;COUNT=6')
    expect(formatRule({ freq: 'DAILY', until: '2027-03-01T23:59:59Z' })).toBe('FREQ=DAILY;UNTIL=20270301T235959Z')
  })

  it('round-trips hand-written rules, keeping their order and unknown parts', () => {
    for (const text of [
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
      'BYDAY=MO,WE;FREQ=WEEKLY;WKST=SU',
      'FREQ=DAILY;BYHOUR=9,17;X-Acme-Note=keep me;COUNT=4',
      'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;UNTIL=20300101T120000Z',
    ]) {
      expect(formatRule(parseRule(text), text)).toBe(text)
    }
  })

  it('edits a hand-written rule in place', () => {
    expect(formatRule({ ...parseRule('FREQ=WEEKLY;BYDAY=TU;COUNT=4'), interval: 2 }, 'FREQ=WEEKLY;BYDAY=TU;COUNT=4')).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=4')
    const text = 'BYDAY=TU;FREQ=WEEKLY;X-NOTE=hi;COUNT=4'
    const rule = parseRule(text)
    expect(formatRule({ ...rule, count: undefined, until: '2027-01-01', interval: 3 }, text)).toBe('INTERVAL=3;BYDAY=TU;FREQ=WEEKLY;X-NOTE=hi;UNTIL=20270101')
    expect(formatRule({ ...rule, byDay: [{ day: 'TU' }, { day: 'FR' }] }, text)).toBe('BYDAY=TU,FR;FREQ=WEEKLY;X-NOTE=hi;COUNT=4')
  })
})

describe('expandRecurrence', () => {
  it('repeats daily and weekly', () => {
    expect(expand('2026-11-03', 'FREQ=DAILY;INTERVAL=3;COUNT=4')).toEqual(['2026-11-03', '2026-11-06', '2026-11-09', '2026-11-12'])
    expect(expand('2026-11-03', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', { limit: 3 })).toEqual(['2026-11-03', '2026-11-17', '2026-12-01'])
    expect(expand('2026-11-02', 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5')).toEqual(['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-09', '2026-11-11'])
    // Weekdays only: Friday, then Monday.
    expect(expand('2026-11-06', 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=2')).toEqual(['2026-11-06', '2026-11-09'])
  })

  it('skips a start that does not match the rule', () => {
    // 2026-11-02 is a Monday.
    expect(expand('2026-11-02', 'FREQ=WEEKLY;BYDAY=TU;COUNT=2')).toEqual(['2026-11-03', '2026-11-10'])
  })

  it('stops at UNTIL, inclusive, also for date-times', () => {
    expect(expand('2026-11-03', 'FREQ=WEEKLY;UNTIL=20261117')).toEqual(['2026-11-03', '2026-11-10', '2026-11-17'])
    expect(expand('2026-11-03T19:30', 'FREQ=WEEKLY;UNTIL=20261117')).toEqual(['2026-11-03T19:30', '2026-11-10T19:30', '2026-11-17T19:30'])
    expect(expand('2026-11-03T19:30', 'FREQ=WEEKLY;UNTIL=20261117T190000')).toEqual(['2026-11-03T19:30', '2026-11-10T19:30'])
  })

  it('counts COUNT from the start even when listing from a later date', () => {
    expect(expand('2026-11-01', 'FREQ=DAILY;COUNT=5', { from: '2026-11-04' })).toEqual(['2026-11-04', '2026-11-05'])
    expect(expand('2026-11-01T10:00', 'FREQ=DAILY', { from: '2026-11-04T10:01', limit: 2 })).toEqual(['2026-11-05T10:00', '2026-11-06T10:00'])
    expect(expand('2026-11-01', 'FREQ=DAILY', { from: '2026-11-04', to: '2026-11-06' })).toEqual(['2026-11-04', '2026-11-05', '2026-11-06'])
  })

  it('handles month ends: skips months without the day, or counts from the end', () => {
    expect(expand('2027-01-31', 'FREQ=MONTHLY;COUNT=4')).toEqual(['2027-01-31', '2027-03-31', '2027-05-31', '2027-07-31'])
    expect(expand('2027-01-31', 'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'])
    expect(expand('2028-01-30', 'FREQ=MONTHLY;BYMONTHDAY=30;COUNT=3')).toEqual(['2028-01-30', '2028-03-30', '2028-04-30'])
    // Leap years: February has a 29th, and the last day moves with it.
    expect(expand('2028-01-31', 'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=2')).toEqual(['2028-01-31', '2028-02-29'])
    expect(expand('2028-02-29', 'FREQ=YEARLY;COUNT=3')).toEqual(['2028-02-29', '2032-02-29', '2036-02-29'])
    // The last workday of the month.
    expect(expand('2026-10-30', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4')).toEqual([
      '2026-10-30',
      '2026-11-30',
      '2026-12-31',
      '2027-01-29',
    ])
  })

  it('picks numbered weekdays in a month', () => {
    expect(expand('2026-11-10', 'FREQ=MONTHLY;BYDAY=2TU;COUNT=4')).toEqual(['2026-11-10', '2026-12-08', '2027-01-12', '2027-02-09'])
    expect(expand('2026-11-27', 'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3')).toEqual(['2026-11-27', '2026-12-25', '2027-01-29'])
    expect(expand('2026-11-10', 'FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;COUNT=2')).toEqual(['2026-11-10', '2026-12-08'])
    // A 5th Monday only exists in some months.
    expect(expand('2026-11-30', 'FREQ=MONTHLY;BYDAY=5MO;COUNT=3')).toEqual(['2026-11-30', '2027-03-29', '2027-05-31'])
    // Friday the 13th.
    expect(expand('2026-11-13', 'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13;COUNT=3')).toEqual(['2026-11-13', '2027-08-13', '2028-10-13'])
  })

  it('repeats yearly by month and weekday', () => {
    // Daylight saving time in the EU ends on the last Sunday of October.
    expect(expand('2026-10-25', 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;COUNT=3')).toEqual(['2026-10-25', '2027-10-31', '2028-10-29'])
    // US Thanksgiving: the 4th Thursday of November.
    expect(expand('2026-11-26', 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=2')).toEqual(['2026-11-26', '2027-11-25'])
    // Without BYMONTH, ordinals count within the year: the first Monday of the year.
    expect(expand('2027-01-04', 'FREQ=YEARLY;BYDAY=1MO;COUNT=2')).toEqual(['2027-01-04', '2028-01-03'])
    expect(expand('2026-12-01', 'FREQ=YEARLY;BYMONTH=6,12;COUNT=3')).toEqual(['2026-12-01', '2027-06-01', '2027-12-01'])
  })

  it('uses WKST to group weeks for intervals', () => {
    // RFC 5545's example: the week start changes which Sundays an every-other-week rule picks.
    expect(expand('1997-08-05', 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO')).toEqual(['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24'])
    expect(expand('1997-08-05', 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU')).toEqual(['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31'])
  })

  it('keeps wall-clock times across daylight saving time changes', () => {
    const dates = expand('2027-03-20T09:00', 'FREQ=WEEKLY;COUNT=3')
    expect(dates).toEqual(['2027-03-20T09:00', '2027-03-27T09:00', '2027-04-03T09:00'])
    // Europe/Amsterdam moves from UTC+1 to UTC+2 on 28 March 2027.
    expect(dates.map((date) => wallClockToDate(date, 'Europe/Amsterdam').toISOString())).toEqual([
      '2027-03-20T08:00:00.000Z',
      '2027-03-27T08:00:00.000Z',
      '2027-04-03T07:00:00.000Z',
    ])
    // A daily 02:30 does not exist on the day clocks go forward; it happens at 03:30 instead.
    const nights = expand('2027-03-27T02:30', 'FREQ=DAILY;COUNT=3').map((date) => wallClockToDate(date, 'Europe/Amsterdam').toISOString())
    expect(nights).toEqual(['2027-03-27T01:30:00.000Z', '2027-03-28T01:30:00.000Z', '2027-03-29T00:30:00.000Z'])
    // On the day clocks go back, 02:30 happens twice; the first is used.
    expect(wallClockToDate('2026-10-25T02:30', 'Europe/Amsterdam').toISOString()).toBe('2026-10-25T00:30:00.000Z')
    expect(wallClockToDate('2026-11-01T01:30', 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('gives up on rules that never match and refuses unsupported parts', () => {
    expect(expand('2026-01-01', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30')).toEqual([])
    expect(expand('2026-01-01', 'FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=31')).toEqual([])
    expect(() => expand('2026-01-01', 'FREQ=DAILY;BYHOUR=9')).toThrow('Not supported: BYHOUR=9')
    expect(() => expand('2026-01-01', 'FREQ=HOURLY')).toThrow('Not supported: FREQ=HOURLY')
    expect(() => expand('2026-02-30', 'FREQ=DAILY')).toThrow('Not a date: 2026-02-30')
    expect(expand('2026-01-01', 'FREQ=DAILY;X-NOTE=ok', { limit: 2 })).toEqual(['2026-01-01', '2026-01-02'])
  })

  it('stops at the end of the year 9999', () => {
    expect(expand('9999-12-30', 'FREQ=DAILY')).toEqual(['9999-12-30', '9999-12-31'])
  })
})

describe('describeRecurrence', () => {
  const describe_ = (start: string, rule: string) => describeRecurrence({ start, rule }, { locale: 'en-GB' })

  it('says the series in words', () => {
    expect(describe_('2026-11-03', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20270301')).toBe('Every 2 weeks on Tuesday, until 1 Mar 2027')
    expect(describe_('2026-11-03', 'FREQ=WEEKLY')).toBe('Every week on Tuesday')
    expect(describe_('2026-11-03', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Every week on weekdays')
    expect(describe_('2026-11-03', 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10')).toBe('Every week on Monday, Wednesday and Friday, 10 times')
    expect(describe_('2026-11-03', 'FREQ=DAILY')).toBe('Every day')
    expect(describe_('2026-11-03', 'FREQ=DAILY;INTERVAL=3;COUNT=1')).toBe('Every 3 days, once')
    expect(describe_('2026-11-10', 'FREQ=MONTHLY;BYDAY=2TU')).toBe('Every month on the 2nd Tuesday')
    expect(describe_('2026-11-10', 'FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2')).toBe('Every month on the 2nd Tuesday')
    expect(describe_('2026-11-27', 'FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR')).toBe('Every 3 months on the last Friday')
    expect(describe_('2026-11-20', 'FREQ=MONTHLY')).toBe('Every month on day 20')
    expect(describe_('2026-11-30', 'FREQ=MONTHLY;BYMONTHDAY=-1')).toBe('Every month on the last day')
    expect(describe_('2026-11-13', 'FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR')).toBe('Every month on day 13 if it is Friday')
    expect(describe_('2026-11-20', 'FREQ=YEARLY')).toBe('Every year on 20 November')
    expect(describe_('2026-10-25', 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU')).toBe('Every year in October on the last Sunday')
    expect(describe_('2026-10-30', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')).toBe('Every month on weekdays, only the last of each month')
    expect(describe_('2026-11-03', 'FREQ=DAILY;BYHOUR=9,17')).toBe('Every day (with BYHOUR=9,17)')
    expect(describe_('2026-11-03', 'nonsense')).toBe('')
  })
})

describe('recurrence schema', () => {
  it('validates the start and the rule', () => {
    const schema = recurrence({ label: 'Repeats' })
    expect(schema.parse({ start: '2026-11-03', rule: 'FREQ=WEEKLY' })).toEqual({ start: '2026-11-03', rule: 'FREQ=WEEKLY' })
    expect(schema.safeParse({ start: '2026-11-03T10:00', rule: 'FREQ=WEEKLY' }).error?.issues[0].message).toBe('Use a date like 2026-11-03')
    const bad = schema.safeParse({ start: '2026-11-03', rule: 'FREQ=WEEKLY;BYDAY=XX' }).error!.issues[0]
    expect(bad.path).toEqual(['rule'])
    expect(bad.message).toBe('BYDAY must be a weekday (MO to SU), not XX')
    expect(schema.safeParse({ start: '2026-11-03', rule: 'FREQ=WEEKLY;UNTIL=20261101' }).error?.issues[0].message).toBe('The series ends before it starts')
    expect(z.object({ repeats: schema.optional() }).parse({})).toEqual({})
    expect(recurrence({ time: true }).safeParse({ start: '2026-11-03T19:30', rule: 'FREQ=DAILY' }).success).toBe(true)
  })
})

describe('toICalendar', () => {
  it('writes DTSTART and RRULE lines', () => {
    expect(toICalendar({ start: '2026-11-03', rule: 'FREQ=WEEKLY;UNTIL=20270301' })).toBe('DTSTART;VALUE=DATE:20261103\r\nRRULE:FREQ=WEEKLY;UNTIL=20270301')
    expect(toICalendar({ start: '2026-11-03T19:30', rule: 'FREQ=WEEKLY;COUNT=3' })).toBe('DTSTART:20261103T193000\r\nRRULE:FREQ=WEEKLY;COUNT=3')
    // With a time zone, a local UNTIL becomes UTC (the end of 1 March in Amsterdam is 22:59:59Z).
    expect(toICalendar({ start: '2026-11-03T19:30', rule: 'FREQ=WEEKLY;UNTIL=20270301' }, { timeZone: 'Europe/Amsterdam' })).toBe(
      'DTSTART;TZID=Europe/Amsterdam:20261103T193000\r\nRRULE:FREQ=WEEKLY;UNTIL=20270301T225959Z',
    )
    expect(toICalendar({ start: '2026-11-03T19:30', rule: 'FREQ=WEEKLY;UNTIL=20270301' })).toBe('DTSTART:20261103T193000\r\nRRULE:FREQ=WEEKLY;UNTIL=20270301T235959')
  })
})
