import { field, type CmsFieldConfig, type FieldConfigCheck } from './fields.js'

// A table field is an ordinary `z.array(z.object({...}))`: each row is stored as an object, so the
// file reads the same as with the default list editor and switching editors never migrates data.
// Only the editor changes, to a grid that suits many short rows (prices, tickets, specs).

/**
 * Edit a list of objects as a spreadsheet-like grid: one column per key, rows that can be added,
 * moved and deleted, and paste from / copy to spreadsheets.
 *
 * ```ts
 * plans: z.array(z.object({ name: z.string(), price: z.number() })).check(table({ label: 'Plans' }))
 * ```
 *
 * Columns of type string, number, boolean, date and enum are editable; other columns (objects,
 * lists, markdown, custom field types) are shown read-only, and their values are kept as they are.
 */
export function table(config: Omit<CmsFieldConfig, 'fieldType'> = {}): FieldConfigCheck {
  return field({ ...config, fieldType: 'table' })
}

/** How a table column is edited, or `undefined` for a read-only column. */
export type TableCellType = 'string' | 'number' | 'boolean' | 'date' | 'select'

export interface TableColumn {
  key: string
  label: string
  type: TableCellType | undefined
  required: boolean
  /** `[value, label]` pairs of a select column. */
  options?: ReadonlyArray<readonly [string, string]>
}

const CELL_TYPES: readonly string[] = ['string', 'number', 'boolean', 'date', 'select']

/** The cell editor for an AutoForm field type, or `undefined` when the column is read-only. */
export function cellType(fieldType: string): TableCellType | undefined {
  return CELL_TYPES.includes(fieldType) ? (fieldType as TableCellType) : undefined
}

// --- CSV and TSV ---------------------------------------------------------------------------------

/**
 * The delimiter of pasted or imported text: a tab (what spreadsheets copy), a semicolon (CSV in
 * locales that write decimal commas) or a comma. Decided by the first line, outside quotes.
 */
export function detectDelimiter(text: string): '\t' | ';' | ',' {
  const counts = { '\t': 0, ';': 0, ',': 0 }
  let quoted = false
  for (const char of text) {
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === '\n' || char === '\r')) break
    else if (!quoted && char in counts) counts[char as keyof typeof counts]++
  }
  if (counts['\t'] > 0) return '\t'
  return counts[';'] > counts[','] ? ';' : ','
}

/**
 * Parse CSV or TSV (RFC 4180): quoted fields may hold delimiters, `""` for a quote and line
 * breaks. Accepts `\n` and `\r\n`, ignores one trailing line break, and detects the delimiter
 * unless one is given.
 */
export function parseDelimited(text: string, delimiter: string = detectDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  // Whether the current row has begun: `""` alone is a row with one empty field.
  let started = false
  let index = 0
  const endRow = () => {
    row.push(value)
    rows.push(row)
    row = []
    value = ''
    started = false
  }
  while (index < text.length) {
    const char = text[index]
    started = true
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"'
        index += 2
        continue
      }
      if (char === '"') quoted = false
      else value += char
      index++
      continue
    }
    if (char === '"' && value === '') quoted = true
    else if (char === delimiter) {
      row.push(value)
      value = ''
    } else if (char === '\r' && text[index + 1] === '\n') {
      endRow()
      index++
    } else if (char === '\n' || char === '\r') endRow()
    else value += char
    index++
  }
  if (started) endRow()
  return rows
}

/**
 * Write rows as CSV (or TSV with `'\t'`). Fields holding the delimiter, a quote, a line break or
 * leading/trailing spaces are quoted, so `parseDelimited` reads them back unchanged.
 */
export function serializeDelimited(rows: ReadonlyArray<ReadonlyArray<string>>, delimiter = ','): string {
  const quote = (value: string) =>
    value.includes(delimiter) || /["\r\n]/.test(value) || value !== value.trim() ? `"${value.replaceAll('"', '""')}"` : value
  return rows.map((row) => row.map(quote).join(delimiter)).join('\n')
}

// --- Cells ---------------------------------------------------------------------------------------

const TRUE = /^(true|yes|y|1|x|✓|✔|on)$/i
const FALSE = /^(false|no|n|0|off|)$/i

function pad(value: number) {
  return String(value).padStart(2, '0')
}

/**
 * Read text from a spreadsheet as the value of a cell. Text that does not fit the column (`abc` in
 * a number column) is kept as is, so validation points at it instead of it silently disappearing.
 */
export function parseCell(text: string, column: Pick<TableColumn, 'type' | 'required' | 'options'>): unknown {
  const trimmed = text.trim()
  if (trimmed === '' && column.type !== 'boolean') return column.required && column.type === 'string' ? '' : undefined
  switch (column.type) {
    case 'number': {
      const number = Number(trimmed)
      return Number.isFinite(number) ? number : trimmed
    }
    case 'boolean':
      return TRUE.test(trimmed) ? true : FALSE.test(trimmed) ? false : trimmed
    case 'date': {
      if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
      const date = new Date(trimmed)
      return Number.isNaN(date.getTime()) ? trimmed : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }
    case 'select': {
      const lower = trimmed.toLowerCase()
      const option =
        column.options?.find(([value]) => value === trimmed) ??
        column.options?.find(([value, label]) => value.toLowerCase() === lower || label.toLowerCase() === lower)
      return option ? option[0] : trimmed
    }
    default:
      return text
  }
}

/** A cell value as text for CSV: dates as `YYYY-MM-DD`, objects and lists as JSON. */
export function formatCell(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value as string | number | boolean | bigint)
}

/** Rows as CSV, with a header row of column keys so the text pastes back into the same table. */
export function rowsToCsv(rows: ReadonlyArray<Record<string, unknown>>, columns: ReadonlyArray<Pick<TableColumn, 'key'>>, delimiter = ','): string {
  return serializeDelimited(
    [columns.map((column) => column.key), ...rows.map((row) => columns.map((column) => formatCell(row?.[column.key])))],
    delimiter,
  )
}

/**
 * Which column each cell of a header row names (by key or label, ignoring case), or `undefined`
 * when the row is not a header: every non-empty cell must name a column.
 */
export function matchHeader(row: readonly string[], columns: ReadonlyArray<Pick<TableColumn, 'key' | 'label'>>): Array<number | undefined> | undefined {
  const find = (cell: string) => {
    const name = cell.trim().toLowerCase()
    const index = columns.findIndex((column) => column.key.toLowerCase() === name || column.label.toLowerCase() === name)
    return index === -1 ? undefined : index
  }
  const mapping = row.map((cell) => (cell.trim() === '' ? undefined : find(cell)))
  const named = row.filter((cell) => cell.trim() !== '').length
  if (named === 0 || mapping.filter((index) => index !== undefined).length !== named) return undefined
  return mapping
}

/**
 * Paste a block of cells (from `parseDelimited`) into rows, the way spreadsheets do: starting at
 * `start`, overwriting cells and adding rows past the end. A first row naming the columns is used
 * as a header: columns are then matched by name, wherever the paste started. Values for read-only
 * columns are ignored.
 */
export function pasteCells(
  rows: ReadonlyArray<Record<string, unknown>>,
  cells: readonly string[][],
  start: { row: number; column: number },
  columns: readonly TableColumn[],
  newRow: () => Record<string, unknown> = () => ({}),
): { rows: Array<Record<string, unknown>>; first: number; pasted: number } {
  const header = cells.length > 0 ? matchHeader(cells[0], columns) : undefined
  const body = header ? cells.slice(1) : cells
  const columnAt = (index: number) => (header ? header[index] : start.column + index)
  const first = Math.min(Math.max(0, start.row), rows.length)
  const result = [...rows]
  body.forEach((line, offset) => {
    const at = first + offset
    const row = { ...(result[at] ?? newRow()) }
    line.forEach((text, index) => {
      const target = columnAt(index)
      const column = target === undefined ? undefined : columns[target]
      if (!column?.type) return
      const value = parseCell(text, column)
      if (value === undefined) delete row[column.key]
      else row[column.key] = value
    })
    result[at] = row
  })
  return { rows: result, first, pasted: body.length }
}
