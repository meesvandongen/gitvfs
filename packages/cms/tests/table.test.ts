import { z } from 'zod'
import {
  cellType,
  detectDelimiter,
  formatCell,
  matchHeader,
  parseCell,
  parseDelimited,
  pasteCells,
  rowsToCsv,
  serializeDelimited,
  table,
  type TableColumn,
} from '../src'

describe('CSV and TSV', () => {
  it('parses quotes, escaped quotes, delimiters and line breaks inside quotes', () => {
    expect(parseDelimited('name,note\n"Smith, J.","said ""hi""\nthen left"\n')).toEqual([
      ['name', 'note'],
      ['Smith, J.', 'said "hi"\nthen left'],
    ])
    expect(parseDelimited('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('a,,c\n,\n')).toEqual([['a', '', 'c'], ['', '']])
    expect(parseDelimited('"x"')).toEqual([['x']])
    expect(parseDelimited('""')).toEqual([['']])
    expect(parseDelimited('')).toEqual([])
  })

  it('detects tabs, semicolons and commas from the first line', () => {
    expect(detectDelimiter('a\tb\n1,5\t2')).toBe('\t')
    expect(detectDelimiter('a;b\n1,5;2')).toBe(';')
    expect(detectDelimiter('"x;y",b\n')).toBe(',')
    expect(parseDelimited('Name\tPrice\nRegular\t0\n')).toEqual([['Name', 'Price'], ['Regular', '0']])
    expect(parseDelimited('a;b\n"1;5";2')).toEqual([['a', 'b'], ['1;5', '2']])
  })

  it('round-trips through serialize', () => {
    const rows = [
      ['plain', 'with, comma', 'with "quote"'],
      ['multi\nline', ' padded ', ''],
    ]
    const csv = serializeDelimited(rows)
    expect(csv).toBe('plain,"with, comma","with ""quote"""\n"multi\nline"," padded ",')
    expect(parseDelimited(csv, ',')).toEqual(rows)
    const tsv = serializeDelimited(rows, '\t')
    expect(tsv.split('\n')[0]).toBe('plain\twith, comma\t"with ""quote"""')
    expect(parseDelimited(tsv, '\t')).toEqual(rows)
  })
})

describe('table cells', () => {
  const columns: TableColumn[] = [
    { key: 'name', label: 'Name', type: 'string', required: true },
    { key: 'price', label: 'Price (EUR)', type: 'number', required: true },
    { key: 'available', label: 'Available', type: 'boolean', required: false },
    { key: 'kind', label: 'Kind', type: 'select', required: false, options: [['early', 'Early bird'], ['regular', 'Regular']] },
    { key: 'until', label: 'Until', type: 'date', required: false },
    { key: 'perks', label: 'Perks', type: undefined, required: false },
  ]

  it('marks only primitive field types editable', () => {
    expect(['string', 'number', 'boolean', 'date', 'select'].map(cellType)).toEqual(['string', 'number', 'boolean', 'date', 'select'])
    expect(cellType('array')).toBeUndefined()
    expect(cellType('markdown')).toBeUndefined()
  })

  it('reads text as typed values, keeping what does not fit', () => {
    const [name, price, available, kind, until] = columns
    expect(parseCell(' Regular ', name)).toBe(' Regular ')
    expect(parseCell('', name)).toBe('')
    expect(parseCell(' 12.5 ', price)).toBe(12.5)
    expect(parseCell('', price)).toBeUndefined()
    expect(parseCell('free', price)).toBe('free')
    expect(parseCell('Yes', available)).toBe(true)
    expect(parseCell('0', available)).toBe(false)
    expect(parseCell('', available)).toBe(false)
    expect(parseCell('early bird', kind)).toBe('early')
    expect(parseCell('REGULAR', kind)).toBe('regular')
    expect(parseCell('vip', kind)).toBe('vip')
    expect(parseCell('2026-11-20T10:00:00Z', until)).toBe('2026-11-20')
    expect(parseCell('Nov 20, 2026', until)).toBe('2026-11-20')
    expect(parseCell('soon', until)).toBe('soon')
  })

  it('formats values for CSV', () => {
    expect(formatCell(undefined)).toBe('')
    expect(formatCell(new Date('2026-11-20T00:00:00Z'))).toBe('2026-11-20')
    expect(formatCell(false)).toBe('false')
    expect(formatCell(['a', 'b'])).toBe('["a","b"]')
    expect(rowsToCsv([{ name: 'A, B', price: 5, perks: ['x'] }], columns)).toBe(
      'name,price,available,kind,until,perks\n"A, B",5,,,,"[""x""]"',
    )
  })

  it('recognizes header rows by key or label', () => {
    expect(matchHeader(['Price (EUR)', 'name'], columns)).toEqual([1, 0])
    expect(matchHeader(['Name', ''], columns)).toEqual([0, undefined])
    expect(matchHeader(['Regular', '0'], columns)).toBeUndefined()
    expect(matchHeader(['', ''], columns)).toBeUndefined()
  })

  it('pastes from the focused cell, adding rows past the end', () => {
    const rows = [{ name: 'Regular', price: 0 }, { name: 'Supporter', price: 25 }]
    const result = pasteCells(rows, [['30', 'yes'], ['40', 'no'], ['50', '']], { row: 1, column: 1 }, columns, () => ({ name: '' }))
    expect(result.first).toBe(1)
    expect(result.pasted).toBe(3)
    expect(result.rows).toEqual([
      { name: 'Regular', price: 0 },
      { name: 'Supporter', price: 30, available: true },
      { name: '', price: 40, available: false },
      { name: '', price: 50, available: false },
    ])
    // The original rows are not changed.
    expect(rows[1]).toEqual({ name: 'Supporter', price: 25 })
  })

  it('maps pasted columns by header and ignores read-only columns', () => {
    const result = pasteCells([], parseDelimited('price,perks,Name\n10,"[1]",Early\n'), { row: 0, column: 3 }, columns)
    expect(result.rows).toEqual([{ price: 10, name: 'Early' }])
    // Without a header, values for read-only columns are skipped too.
    expect(pasteCells([], [['2026-01-01', 'x']], { row: 5, column: 4 }, columns).rows).toEqual([{ until: '2026-01-01' }])
  })

  it('reports nested error paths for rows', () => {
    const schema = z.object({
      rows: z.array(z.object({ name: z.string().min(1), price: z.number().min(0) })).check(table({ label: 'Rows' })),
    })
    const result = schema.safeParse({ rows: [{ name: 'A', price: 1 }, { name: '', price: -1 }] })
    expect(result.success).toBe(false)
    expect(result.error!.issues.map((issue) => issue.path.join('.'))).toEqual(['rows.1.name', 'rows.1.price'])
  })
})
