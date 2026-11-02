import { useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import { useFieldRHF } from '@autoform/react/react-hook-form'
import { formatCell, parseDelimited, pasteCells, rowsToCsv } from '../table.js'
import { ValueInput, blankObject, errorAt, errorMessages, objectFields, summarize, useErrorTree, type FieldColumn } from './cells.js'

// Not imported from ./autoform.js, which imports this module for its field components.
const useField = (name: string) => useFieldRHF({ name }).field

type Row = Record<string, unknown>

/**
 * Stable React keys for rows, so moving or deleting a row moves its inputs (and what is being
 * typed in them) along instead of handing them to the next row.
 */
function useRowKeys(length: number) {
  const state = useRef({ next: 0, keys: [] as number[] }).current
  while (state.keys.length < length) state.keys.push(state.next++)
  state.keys.length = length
  return {
    keys: state.keys,
    insert: (at: number) => state.keys.splice(at, 0, state.next++),
    remove: (at: number) => state.keys.splice(at, 1),
    swap: (a: number, b: number) => ([state.keys[a], state.keys[b]] = [state.keys[b], state.keys[a]]),
  }
}

/** Copy text, with a fallback for pages where the async clipboard is unavailable (plain http). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const copied = document.execCommand?.('copy') ?? false
    area.remove()
    return copied
  }
}

/** Keys that move the caret inside a text input; they only leave the cell from its edges. */
function atEdge(target: HTMLElement, direction: 'start' | 'end'): boolean {
  if (!(target instanceof HTMLInputElement) || target.type === 'checkbox') return true
  const { selectionStart, selectionEnd, value } = target
  if (selectionStart === null || selectionStart !== selectionEnd) return false
  return direction === 'start' ? selectionStart === 0 : selectionEnd === value.length
}

/**
 * A spreadsheet-like editor for a list of objects: one column per key, rows that can be added,
 * moved and deleted, keyboard navigation between cells, paste from spreadsheets and copy as CSV.
 */
export function TableField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const columns = useMemo(() => objectFields(props.parsedField), [props.parsedField])
  const rows: Row[] = Array.isArray(field.value) ? field.value : []
  const rowKeys = useRowKeys(rows.length)
  const errors = useErrorTree(props.id)
  const element = useRef<HTMLDivElement | null>(null)
  const pendingFocus = useRef<{ row: number; column: number } | 'add' | null>(null)
  const [status, setStatus] = useState('')

  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    pendingFocus.current = null
    if (target === 'add') element.current?.querySelector<HTMLElement>('.gcms-table-add')?.focus()
    else focusCell(target.row, target.column)
  })

  if (!columns) {
    return <p className="gcms-error">table() edits a list of objects: z.array(z.object({'{ ... }'})).</p>
  }

  const editable = columns.flatMap((column, index) => (column.type ? [index] : []))
  const firstEditable = editable[0] ?? 0
  const label = typeof props.label === 'string' && props.label ? props.label : 'Table'
  const cellId = (row: number, column: number) => `${props.id}-${row}-${columns[column].key}`

  function focusCell(row: number, column: number, select = false) {
    const cell = element.current?.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${column}"]`)
    cell?.focus()
    if (select && cell instanceof HTMLInputElement && cell.type === 'text') cell.select()
  }

  const set = (next: Row[]) => field.onChange(next)
  const updateCell = (row: number, column: FieldColumn, value: unknown) =>
    // A cleared cell holds null, like other cleared fields: it keeps its place and reads as missing.
    set(rows.map((current, index) => (index === row ? { ...current, [column.key]: value ?? null } : current)))

  const addRow = (at = rows.length, column = firstEditable) => {
    rowKeys.insert(at)
    pendingFocus.current = { row: at, column }
    set([...rows.slice(0, at), blankObject(columns), ...rows.slice(at)])
  }
  const removeRow = (row: number, column = firstEditable) => {
    rowKeys.remove(row)
    const next = rows.filter((_, index) => index !== row)
    pendingFocus.current = next.length === 0 ? 'add' : { row: Math.min(row, next.length - 1), column }
    set(next)
    setStatus(`Row ${row + 1} deleted`)
  }
  const moveRow = (row: number, by: -1 | 1, column?: number) => {
    const to = row + by
    if (to < 0 || to >= rows.length) return
    rowKeys.swap(row, to)
    const next = [...rows]
    ;[next[row], next[to]] = [next[to], next[row]]
    if (column !== undefined) pendingFocus.current = { row: to, column }
    set(next)
    setStatus(`Row ${row + 1} moved to position ${to + 1}`)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const target = event.target as HTMLElement
    const row = Number(target.dataset.row)
    const column = Number(target.dataset.col)
    if (target.dataset.col === undefined || Number.isNaN(row)) return
    const type = columns[column].type
    // Selects and date inputs use the arrow keys themselves (to pick an option or change a part).
    const arrows = type === 'string' || type === 'number' || type === 'boolean'
    const next = (direction: 1 | -1) => editable[editable.indexOf(column) + direction]
    let handled = true
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && type !== 'select') {
      moveRow(row, event.key === 'ArrowUp' ? -1 : 1, column)
    } else if (event.key === 'Enter') {
      if (event.shiftKey) focusCell(row - 1, column, true)
      else if (row === rows.length - 1) addRow(rows.length, column)
      else focusCell(row + 1, column, true)
    } else if (arrows && event.key === 'ArrowUp' && !event.altKey) focusCell(row - 1, column, true)
    else if (arrows && event.key === 'ArrowDown' && !event.altKey) focusCell(row + 1, column, true)
    else if (event.key === 'ArrowLeft' && arrows && atEdge(target, 'start') && next(-1) !== undefined) focusCell(row, next(-1), true)
    else if (event.key === 'ArrowRight' && arrows && atEdge(target, 'end') && next(1) !== undefined) focusCell(row, next(1), true)
    else handled = false
    if (handled) event.preventDefault()
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    // Spreadsheets end a copied block with a line break; a single value pastes into the input as usual.
    const text = event.clipboardData.getData('text/plain').replace(/\r?\n$/, '')
    if (!/[\t\n\r]/.test(text)) return
    event.preventDefault()
    const target = event.target as HTMLElement
    const row = target.dataset.row === undefined ? rows.length : Number(target.dataset.row)
    const column = target.dataset.col === undefined ? 0 : Number(target.dataset.col)
    const result = pasteCells(rows, parseDelimited(text), { row, column }, columns, () => blankObject(columns))
    pendingFocus.current = { row: result.first, column: target.dataset.col === undefined ? firstEditable : column }
    set(result.rows)
    setStatus(`Pasted ${result.pasted} row${result.pasted === 1 ? '' : 's'}`)
  }

  const copy = async (delimiter: ',' | '\t') => {
    const copied = await copyText(rowsToCsv(rows, columns, delimiter))
    setStatus(copied ? `Copied ${rows.length} row${rows.length === 1 ? '' : 's'} as ${delimiter === ',' ? 'CSV' : 'TSV'}` : 'Copying is not available in this browser')
  }

  const readOnly = columns.filter((column) => !column.type)
  const rowProblems = rows.flatMap((_, row) => {
    // Messages for the row itself or read-only cells; editable cells show their own.
    const messages = errorMessages(errorAt(errors, [row]), editable.map((index) => columns[index].key))
    return messages.length > 0 ? [{ row, messages }] : []
  })

  return (
    <div className="gcms-table" ref={(node) => {
        element.current = node
        ;(field.ref as (instance: HTMLElement | null) => void)(node)
      }} tabIndex={-1} onPaste={onPaste}>
      <div className="gcms-table-scroll">
        <table className="gcms-table-grid" aria-label={label} onKeyDown={onKeyDown}>
          <thead>
            <tr>
              <th scope="col" className="gcms-table-index">
                <span className="gcms-visually-hidden">Row</span>
              </th>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={`gcms-table-col--${column.type ?? 'readonly'}`}>
                  {column.label}
                  {column.required && column.type && column.type !== 'boolean' ? <span className="gcms-required"> *</span> : null}
                  {column.type ? null : <span className="gcms-table-note"> (read-only)</span>}
                </th>
              ))}
              <th scope="col" className="gcms-table-actions">
                <span className="gcms-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} className="gcms-table-empty" tabIndex={0} id={props.id}>
                  No rows yet. Add one, or paste cells copied from a spreadsheet here.
                </td>
              </tr>
            ) : null}
            {rows.map((row, rowIndex) => (
              <tr key={rowKeys.keys[rowIndex]}>
                <th scope="row" className="gcms-table-index">
                  {rowIndex + 1}
                </th>
                {columns.map((column, columnIndex) => {
                  const value = row?.[column.key]
                  if (!column.type) {
                    return (
                      <td key={column.key} className="gcms-table-static" title={formatCell(value)}>
                        {summarize(value)}
                      </td>
                    )
                  }
                  const message = errorMessages(errorAt(errors, [rowIndex, column.key]))[0]
                  const id = cellId(rowIndex, columnIndex)
                  return (
                    <td key={column.key} className={message ? 'gcms-table-invalid' : undefined}>
                      <ValueInput
                        type={column.type}
                        value={value}
                        onChange={(next) => updateCell(rowIndex, column, next)}
                        options={column.options}
                        required={column.required}
                        id={rowIndex === 0 && columnIndex === firstEditable ? props.id : id}
                        className="gcms-table-input"
                        aria-label={`${column.label}, row ${rowIndex + 1}`}
                        aria-invalid={message ? true : undefined}
                        aria-describedby={message ? `${id}-error` : undefined}
                        data-row={rowIndex}
                        data-col={columnIndex}
                      />
                      {message ? (
                        <span className="gcms-table-error" id={`${id}-error`}>
                          {message}
                        </span>
                      ) : null}
                    </td>
                  )
                })}
                <td className="gcms-table-actions">
                  {/* aria-disabled rather than disabled: focus stays on a button that just moved its row to the end. */}
                  <button
                    type="button"
                    className="gcms-icon-button"
                    aria-label={`Move row ${rowIndex + 1} up`}
                    title="Move up (Alt+↑)"
                    aria-disabled={rowIndex === 0 || undefined}
                    onClick={() => moveRow(rowIndex, -1)}
                    data-row={rowIndex}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="gcms-icon-button"
                    aria-label={`Move row ${rowIndex + 1} down`}
                    title="Move down (Alt+↓)"
                    aria-disabled={rowIndex === rows.length - 1 || undefined}
                    onClick={() => moveRow(rowIndex, 1)}
                    data-row={rowIndex}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="gcms-icon-button gcms-icon-button--danger"
                    aria-label={`Delete row ${rowIndex + 1}`}
                    title="Delete row"
                    onClick={() => removeRow(rowIndex)}
                    data-row={rowIndex}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rowProblems.length > 0 ? (
        <ul className="gcms-error gcms-table-problems" role="alert">
          {rowProblems.map(({ row, messages }) => (
            <li key={row}>
              Row {row + 1}: {messages.join('. ')}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="gcms-table-toolbar">
        <button type="button" className="gcms-button gcms-button--small gcms-table-add" onClick={() => addRow()}>
          Add row
        </button>
        <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" disabled={rows.length === 0} onClick={() => copy(',')}>
          Copy as CSV
        </button>
        <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" disabled={rows.length === 0} onClick={() => copy('\t')}>
          Copy for spreadsheets
        </button>
        <span className="gcms-muted" role="status">
          {status}
        </span>
      </div>
      <p className="gcms-muted">
        Arrow keys and Enter move between cells, Alt+↑ and Alt+↓ move a row. Paste cells copied from a spreadsheet to fill or add rows.
        {readOnly.length > 0
          ? ` ${readOnly.map((column) => column.label).join(', ')} cannot be edited in the table; ${readOnly.length === 1 ? 'its values are' : 'their values are'} kept as they are.`
          : ''}
      </p>
    </div>
  )
}
