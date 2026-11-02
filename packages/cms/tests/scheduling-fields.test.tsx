import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS } from 'gitvfs'
import { z } from 'zod'
import { createCms, dateRange, defineCollection, openingHours, recurrence } from '../src'
import { CmsApp } from '../src/react'
import { MemoryRepository } from './helpers/memory-repository'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function waitFor<T>(find: () => T | null | undefined, timeout = 2000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for element')
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
}

function byText(text: string, selector = 'button'): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text)
}

const byLabel = <T extends HTMLElement = HTMLInputElement>(label: string) => container.querySelector<T>(`[aria-label="${label}"]`)!
const input = (id: string) => container.querySelector<HTMLInputElement>(`[id="${id}"]`)!

function typeInto(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function choose(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

const events = defineCollection({
  name: 'events',
  label: 'Events',
  folder: 'events',
  format: 'yaml',
  schema: z.object({
    title: z.string().min(1),
    dates: dateRange({ label: 'Dates', locale: 'en-GB', maxLength: 7 }).optional(),
    repeats: recurrence({ label: 'Repeats', time: true, locale: 'en-GB' }).optional(),
    hours: openingHours({ label: 'Hours' }).optional(),
  }),
})

function setup(file: string) {
  const remote = new MemoryRepository({ 'events/camp.yml': file })
  const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [events] })
  act(() => root.render(<CmsApp cms={cms} title="Test CMS" />))
  return remote
}

async function open() {
  const entry = await waitFor(() => byText('Campcamp'))
  await act(async () => entry.click())
  await waitFor(() => container.querySelector('input[name="title"]'))
}

async function save(remote: MemoryRepository, commits = 1) {
  await act(async () => byText('Save')!.click())
  await waitFor(() => remote.commits.length === commits)
  return remote.text('events/camp.yml')!
}

describe('date range field', () => {
  it('shows the range in words, keeps the length when the start moves, and validates the end', async () => {
    const remote = setup('title: Camp\ndates:\n  start: 2027-07-19\n  end: 2027-07-23\n')
    await open()
    const [start, end] = [input('dates'), input('dates-end')]
    expect(start.value).toBe('2027-07-19')
    expect(end.min).toBe('2027-07-19')
    const help = () => container.querySelector('.gcms-daterange .gcms-sched-help')?.textContent?.replace(/[  ]/g, ' ')
    expect(help()).toMatch(/^19 ?– ?23 Jul 2027 · 5 days$/)
    // Untouched optional fields stay absent.
    expect(byText('Unsaved', 'span')).toBeUndefined()

    await act(async () => typeInto(start, '2027-07-26'))
    expect(end.value).toBe('2027-07-30')

    await act(async () => typeInto(end, '2027-07-20'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('The end is before the start', 'p'))
    expect(remote.commits).toHaveLength(0)

    await act(async () => typeInto(end, '2027-08-10'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Choose at most 7 days', 'p'))
    await act(async () => typeInto(end, '2027-07-28'))
    expect(await save(remote)).toBe('title: Camp\ndates:\n  start: 2027-07-26\n  end: 2027-07-28\n')
  })
})

describe('opening hours field', () => {
  const file = `title: Camp
hours:
  mon: []
  tue:
    - opens: 10:00
      closes: 18:00
  fri:
    - opens: 18:00
      closes: 02:00
`

  it('opens, closes, adds and copies hours per day', async () => {
    const remote = setup(file)
    await open()
    const mondayClosed = byLabel('Monday closed')
    expect(mondayClosed.checked).toBe(true)
    expect(byLabel('Friday closes').value).toBe('02:00')
    expect(byText('next day', 'span')).toBeTruthy()

    // Opening Monday gives it the default hours; closing and reopening Tuesday brings its hours back.
    await act(async () => mondayClosed.click())
    expect(input('hours').value).toBe('09:00')
    await act(async () => byLabel('Tuesday closed').click())
    expect(container.querySelector('[aria-label="Tuesday opens"]')).toBeNull()
    await act(async () => byLabel('Tuesday closed').click())
    expect(byLabel('Tuesday closes').value).toBe('18:00')

    // A second interval on Tuesday, for an evening opening.
    await act(async () => byLabel('Add hours on Tuesday').click())
    expect(byLabel('Tuesday opens (2)').value).toBe('19:00')
    expect(byLabel('Tuesday closes (2)').value).toBe('22:00')

    await act(async () => byLabel("Copy Monday's hours to all days").click())
    expect(byLabel('Sunday opens').value).toBe('09:00')
    expect(container.querySelector('[aria-label="Tuesday opens (2)"]')).toBeNull()
    await act(async () => byLabel('Saturday closed').click())
    await act(async () => byLabel('Sunday closed').click())

    await act(async () => byText('Add special date')!.click())
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('.gcms-hours-exception input[type="date"]')!, '2026-12-25'))
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('.gcms-hours-exception input[placeholder="Christmas"]')!, 'Christmas'))

    const saved = await save(remote)
    expect(saved).toContain('hours:\n  mon:\n    - opens: 09:00\n      closes: 17:00\n  tue:\n')
    expect(saved).toContain('  sat: []\n  sun: []\n  exceptions:\n    - date: 2026-12-25\n      label: Christmas\n      hours: []\n')
  })

  it('flags overlapping hours', async () => {
    const remote = setup(file)
    await open()
    await act(async () => byLabel('Add hours on Tuesday').click())
    await act(async () => typeInto(byLabel('Tuesday opens (2)'), '17:00'))
    // Saturday 01:00 is still Friday night.
    await act(async () => byLabel('Saturday closed').click())
    await act(async () => typeInto(byLabel('Saturday opens'), '01:00'))
    await act(async () => byText('Save')!.click())
    const error = await waitFor(() => container.querySelector('.gcms-hours .gcms-error'))
    expect(error.textContent).toContain('Tuesday: 17:00–22:00 overlaps 10:00–18:00')
    expect(error.textContent).toContain("Saturday: 01:00–17:00 starts before Friday's 18:00–02:00 ends")
    expect(remote.commits).toHaveLength(0)
  })

  it('clears optional hours', async () => {
    const remote = setup(file)
    await open()
    await act(async () => byText('Clear opening hours')!.click())
    expect(byLabel<HTMLInputElement>('Monday closed').checked).toBe(true)
    expect(await save(remote)).toBe('title: Camp\n')
  })
})

describe('recurrence field', () => {
  const file = 'title: Camp\nrepeats:\n  start: 2030-01-04T16:00\n  rule: FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;UNTIL=20300301T235959\n'
  const summary = () => container.querySelector('.gcms-recurrence-summary strong')?.textContent
  const rule = () => container.querySelector<HTMLInputElement>('.gcms-recurrence-rule')!.value
  const dates = () => [...container.querySelectorAll('.gcms-recurrence-dates time')].map((time) => time.getAttribute('datetime'))

  it('edits the rule with controls and lists the next dates', async () => {
    const remote = setup(file)
    await open()
    expect(input('repeats').value).toBe('2030-01-04T16:00')
    expect(summary()).toBe('Every 2 weeks on Friday, until 1 Mar 2030')
    expect(dates()).toEqual(['2030-01-04T16:00', '2030-01-18T16:00', '2030-02-01T16:00', '2030-02-15T16:00', '2030-03-01T16:00'])
    expect(byLabel('Friday').getAttribute('aria-pressed')).toBe('true')

    // Moving the start to a Tuesday moves a single weekday along.
    await act(async () => typeInto(input('repeats'), '2030-01-08T16:00'))
    expect(rule()).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20300301T235959')
    await act(async () => byLabel('Friday').click())
    expect(rule()).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,FR;UNTIL=20300301T235959')
    await act(async () => byLabel('Tuesday').click())
    // The only remaining day cannot be switched off.
    await act(async () => byLabel('Friday').click())
    expect(rule()).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;UNTIL=20300301T235959')
    await act(async () => byLabel('Tuesday').click())
    await act(async () => byLabel('Friday').click())

    await act(async () => choose(container.querySelector<HTMLSelectElement>('[id="repeats-freq"]')!, 'MONTHLY'))
    expect(rule()).toBe('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=8;UNTIL=20300301T235959')
    await act(async () => typeInto(input('repeats-interval'), ''))
    await act(async () => typeInto(input('repeats-interval'), '1'))
    // "On the 2nd Tuesday", from the start date.
    const radios = container.querySelectorAll<HTMLInputElement>('input[name="repeats-monthly"]')
    await act(async () => radios[1].click())
    expect(rule()).toBe('FREQ=MONTHLY;BYDAY=2TU;UNTIL=20300301T235959')
    expect(summary()).toBe('Every month on the 2nd Tuesday, until 1 Mar 2030')
    await act(async () => choose(byLabel<HTMLSelectElement>('Which week of the month'), '-1'))
    expect(summary()).toBe('Every month on the last Tuesday, until 1 Mar 2030')

    const ends = container.querySelectorAll<HTMLInputElement>('input[name="repeats-ends"]')
    await act(async () => ends[2].click())
    await act(async () => typeInto(input('repeats-count'), '3'))
    expect(rule()).toBe('FREQ=MONTHLY;BYDAY=-1TU;COUNT=3')
    expect(dates()).toEqual(['2030-01-29T16:00', '2030-02-26T16:00', '2030-03-26T16:00'])
    expect(byText('The start does not match the rule, so the series begins on Tue, 29 Jan 2030, 16:00.', 'p')).toBeTruthy()

    expect(await save(remote)).toBe('title: Camp\nrepeats:\n  start: 2030-01-08T16:00\n  rule: FREQ=MONTHLY;BYDAY=-1TU;COUNT=3\n')
  })

  it('keeps rule parts the controls do not know', async () => {
    const remote = setup('title: Camp\nrepeats:\n  start: 2030-01-04T16:00\n  rule: BYDAY=FR;FREQ=WEEKLY;BYHOUR=10,16;X-NOTE=hand written\n')
    await open()
    expect(summary()).toBe('Every week on Friday (with BYHOUR=10,16)')
    expect(container.querySelector('.gcms-recurrence-summary')!.textContent).toContain('Not supported: BYHOUR=10,16')
    await act(async () => typeInto(input('repeats-interval'), '3'))
    expect(await save(remote)).toContain('rule: INTERVAL=3;BYDAY=FR;FREQ=WEEKLY;BYHOUR=10,16;X-NOTE=hand written\n')
  })

  it('shows rules it cannot read and starts and stops a series', async () => {
    const remote = setup('title: Camp\nrepeats:\n  start: 2030-01-04T16:00\n  rule: FREQ=WEEKLY;BYDAY=XX\n')
    await open()
    expect(byText('The rule cannot be read: BYDAY must be a weekday (MO to SU), not XX.', 'p')).toBeTruthy()
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('.gcms-recurrence-rule')!, 'RRULE:FREQ=DAILY;COUNT=2'))
    expect(summary()).toBe('Every day, 2 times')
    expect(rule()).toBe('FREQ=DAILY;COUNT=2')

    await act(async () => choose(container.querySelector<HTMLSelectElement>('[id="repeats-freq"]')!, ''))
    expect(container.querySelector('.gcms-recurrence-summary')).toBeNull()
    expect(await save(remote)).toBe('title: Camp\n')

    // A new series starts today and repeats on today's weekday.
    await act(async () => choose(container.querySelector<HTMLSelectElement>('[id="repeats"]')!, 'WEEKLY'))
    expect(input('repeats').value).toMatch(/^\d{4}-\d{2}-\d{2}T09:00$/)
    expect(rule()).toMatch(/^FREQ=WEEKLY;BYDAY=(MO|TU|WE|TH|FR|SA|SU)$/)
  })
})
