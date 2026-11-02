import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import { useFieldRHF } from '@autoform/react/react-hook-form'
import {
  countDescendants,
  flattenTree,
  getNode,
  indentNode,
  insertNode,
  moveDown,
  moveNode,
  moveUp,
  outdentNode,
  pathKey,
  remapPath,
  removeNode,
  updateNode,
  type TreeChange,
  type TreeCustomData,
  type TreePath,
} from '../tree.js'
import { ValueInput, blankObject, errorAt, errorMessages, objectFields, summarize, useErrorTree } from './cells.js'

// Not imported from ./autoform.js, which imports this module for its field components.
const useField = (name: string) => useFieldRHF({ name }).field

type Node = Record<string, unknown>
type DropPosition = 'before' | 'inside' | 'after'

const toPath = (key: string): number[] => (key === '' ? [] : key.split('.').map(Number))

/** `collapsed` without the ancestors of `path`, so the item at `path` is visible. */
function expandTo(collapsed: ReadonlySet<string>, path: TreePath): Set<string> {
  const next = new Set(collapsed)
  for (let depth = 1; depth < path.length; depth++) next.delete(pathKey(path.slice(0, depth)))
  return next
}

/** Where a dragged row would land: the top and bottom quarters of a row mean before and after it. */
function dropPosition(event: DragEvent<HTMLElement>): DropPosition {
  const rect = event.currentTarget.getBoundingClientRect()
  if (!(rect.height > 0)) return 'after'
  const y = (event.clientY - rect.top) / rect.height
  return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside'
}

/**
 * An outline editor for nested lists (menus, page hierarchies), following the ARIA tree pattern:
 * arrow keys move between items and expand or collapse them, Enter edits an item's fields inline,
 * Alt+arrows move and indent items, and rows can be dragged.
 */
export function TreeField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const config = (props.parsedField.fieldConfig?.customData as TreeCustomData | undefined)?.tree
  const childrenKey = config?.childrenKey ?? 'children'
  const options = { childrenKey, maxDepth: config?.maxDepth }
  const fields = useMemo(
    () => objectFields(props.parsedField)?.filter((column) => column.key !== childrenKey) ?? [],
    [props.parsedField, childrenKey],
  )
  const nodes: Node[] = Array.isArray(field.value) ? field.value : []
  const errors = useErrorTree(props.id)
  const element = useRef<HTMLDivElement | null>(null)

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ key: string; position: DropPosition } | null>(null)
  const [status, setStatus] = useState('')
  const pendingFocus = useRef<{ key: string; field?: boolean } | null>(null)

  useEffect(() => {
    const request = pendingFocus.current
    if (!request) return
    pendingFocus.current = null
    // No item to focus (the last one was deleted): go to the Add button.
    if (request.key === '') return element.current?.querySelector<HTMLElement>('.gcms-tree-add')?.focus()
    const item = element.current?.querySelector<HTMLElement>(`[data-path="${request.key}"]`)
    const input = request.field ? item?.querySelector<HTMLElement>(':scope > .gcms-tree-editor input, :scope > .gcms-tree-editor select') : null
    ;(input ?? item)?.focus()
  })

  const labelKey =
    config?.labelField ??
    fields.find((column) => ['label', 'title', 'name'].includes(column.key))?.key ??
    fields.find((column) => column.type === 'string')?.key ??
    fields[0]?.key
  const detailKey = fields.find((column) => column.key !== labelKey && column.type === 'string')?.key
  const titleOf = (node: Node | undefined) => {
    const title = labelKey === undefined ? undefined : node?.[labelKey]
    return typeof title === 'string' && title.trim() !== '' ? title : 'Untitled'
  }

  const visible = flattenTree(nodes, { childrenKey, isCollapsed: (path) => collapsed.has(pathKey(path)) })
  const all = flattenTree(nodes, { childrenKey })
  // The one item that takes Tab focus (roving tabindex): the selected one while it exists.
  const active = selected !== null && visible.some((item) => pathKey(item.path) === selected) ? selected : visible[0] ? pathKey(visible[0].path) : null

  const focusItem = (key: string, field = false) => {
    setSelected(key)
    pendingFocus.current = { key, field }
    // Focus right away too when the item is already rendered, for quick arrow key presses.
    if (!field) element.current?.querySelector<HTMLElement>(`[data-path="${key}"]`)?.focus()
  }

  /** Commit a structural change, keeping expanded state, editing and focus on the same nodes. */
  const apply = (change: TreeChange | undefined, focus?: { path?: TreePath; edit?: boolean }) => {
    if (!change) return
    const remap = (key: string) => {
      const path = remapPath(toPath(key), change)
      return path ? pathKey(path) : undefined
    }
    const target = focus?.path ?? change.to
    const targetKey = target ? pathKey(target) : null
    setCollapsed((current) => {
      const next = new Set([...current].map(remap).filter((key): key is string => key !== undefined))
      return target ? expandTo(next, target) : next
    })
    setEditing((current) => (focus?.edit && targetKey ? targetKey : current === null ? null : (remap(current) ?? null)))
    setConfirming(null)
    field.onChange(change.nodes)
    setSelected(targetKey)
    pendingFocus.current = { key: targetKey ?? '', field: focus?.edit }
  }

  /** Show an item with its editor open, such as one with errors. */
  const reveal = (path: TreePath) => {
    const key = pathKey(path)
    setCollapsed((current) => expandTo(current, path))
    setEditing(key)
    setSelected(key)
    pendingFocus.current = { key, field: true }
  }

  const fits = (level: number) => options.maxDepth === undefined || level <= options.maxDepth
  const add = (parent: TreePath, index: number) => apply(insertNode(nodes, parent, index, blankObject(fields), options), { edit: true })
  const childrenOf = (node: Node | undefined) => (Array.isArray(node?.[childrenKey]) ? (node[childrenKey] as Node[]) : [])

  const remove = (path: TreePath) => {
    const key = pathKey(path)
    const node = getNode(nodes, path, options)
    if (!node) return
    if (countDescendants(node, options) > 0 && confirming !== key) {
      setConfirming(key)
      return
    }
    const change = removeNode(nodes, path, options)
    // Select the next item, else the previous one, else the parent.
    const index = path[path.length - 1]
    const candidates = [path, [...path.slice(0, -1), index - 1], path.slice(0, -1)]
    const next = candidates.find((candidate) => candidate.length > 0 && candidate[candidate.length - 1] >= 0 && getNode(change.nodes, candidate, options))
    setStatus(`Deleted ${titleOf(node)}`)
    apply(change, { path: next })
  }

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const dropChange = (from: string, target: TreePath, position: DropPosition) => {
    const parent = target.slice(0, -1)
    const index = target[target.length - 1]
    const change =
      position === 'inside'
        ? moveNode(nodes, toPath(from), target, childrenOf(getNode(nodes, target, options)).length, options)
        : moveNode(nodes, toPath(from), parent, position === 'before' ? index : index + 1, options)
    // Dropping a row where it already is changes nothing.
    return change && pathKey(change.to ?? []) !== from ? change : undefined
  }

  const onItemKeyDown = (event: KeyboardEvent<HTMLLIElement>, path: number[], position: number) => {
    if (event.defaultPrevented) return
    const key = pathKey(path)
    if (event.target !== event.currentTarget) {
      // In the inline editor: Enter and Escape finish editing (Enter would otherwise submit the form).
      const finish = event.key === 'Escape' || (event.key === 'Enter' && event.target instanceof HTMLInputElement)
      if (finish && (editing === key || (event.key === 'Escape' && confirming === key))) {
        event.preventDefault()
        if (editing === key) setEditing(null)
        setConfirming(null)
        focusItem(key)
      }
      return
    }
    const item = visible[position]
    const expanded = item.hasChildren && !collapsed.has(key)
    const go = (index: number) => {
      const target = visible[index]
      if (target) focusItem(pathKey(target.path))
    }
    const actions: Record<string, (() => void) | undefined> = event.altKey
      ? {
          ArrowUp: () => apply(moveUp(nodes, path, options)),
          ArrowDown: () => apply(moveDown(nodes, path, options)),
          ArrowLeft: () => apply(outdentNode(nodes, path, options)),
          ArrowRight: () => apply(indentNode(nodes, path, options)),
        }
      : {
          ArrowDown: () => go(position + 1),
          ArrowUp: () => go(position - 1),
          Home: () => go(0),
          End: () => go(visible.length - 1),
          ArrowRight: () => (item.hasChildren ? (expanded ? go(position + 1) : toggle(key)) : undefined),
          ArrowLeft: () => (expanded ? toggle(key) : path.length > 1 ? focusItem(pathKey(path.slice(0, -1))) : undefined),
          Enter: () => {
            setEditing(editing === key ? null : key)
            if (editing !== key) pendingFocus.current = { key, field: true }
          },
          F2: () => {
            setEditing(key)
            pendingFocus.current = { key, field: true }
          },
          Delete: () => remove(path),
        }
    const action = actions[event.key]
    if (action) {
      event.preventDefault()
      action()
    }
  }

  const problems = all.flatMap(({ node, path }) => {
    const messages = errorMessages(errorAt(errors, path.flatMap((index, at) => (at === 0 ? [index] : [childrenKey, index]))), [childrenKey])
    return messages.length > 0 ? [{ node, path, messages }] : []
  })
  const invalid = new Set(problems.map((problem) => pathKey(problem.path)))
  const trail = (path: TreePath) => path.map((_, depth) => titleOf(getNode(nodes, path.slice(0, depth + 1), options))).join(' › ')

  const nodeErrors = (path: TreePath) => errorAt(errors, path.flatMap((index, at) => (at === 0 ? [index] : [childrenKey, index])))

  const renderEditor = (node: Node, path: number[]) => {
    const key = pathKey(path)
    const own = nodeErrors(path)
    return (
      <fieldset className="gcms-tree-editor">
        <legend className="gcms-visually-hidden">Edit {titleOf(node)}</legend>
        {fields.map((column) => {
          const id = `${props.id}-${key}-${column.key}`
          const message = errorMessages(errorAt(own, [column.key]))[0]
          const error = message ? (
            <p className="gcms-error" id={`${id}-error`}>
              {message}
            </p>
          ) : null
          if (!column.type) {
            return (
              <div key={column.key} className="gcms-field">
                <span className="gcms-label">{column.label}</span>
                <span className="gcms-muted">{summarize(node[column.key])} (not editable here; kept as is)</span>
                {error}
              </div>
            )
          }
          const input = (
            <ValueInput
              type={column.type}
              id={id}
              value={node[column.key]}
              options={column.options}
              required={column.required}
              aria-invalid={message ? true : undefined}
              aria-describedby={message ? `${id}-error` : undefined}
              onChange={(value) =>
                field.onChange(
                  updateNode(nodes, path, (current) => ({ ...current, [column.key]: value ?? null }), options),
                )}
            />
          )
          return column.type === 'boolean' ? (
            <div key={column.key} className="gcms-field">
              <label className="gcms-checkbox" htmlFor={id}>
                {input}
                <span>{column.label}</span>
              </label>
              {error}
            </div>
          ) : (
            <div key={column.key} className="gcms-field">
              <label className="gcms-label" htmlFor={id}>
                {column.label}
                {column.required ? <span className="gcms-required"> *</span> : null}
              </label>
              {input}
              {error}
            </div>
          )
        })}
        <button
          type="button"
          className="gcms-button gcms-button--small gcms-tree-done"
          onClick={() => {
            setEditing(null)
            focusItem(key)
          }}
        >
          Done
        </button>
      </fieldset>
    )
  }

  const renderToolbar = (node: Node, path: number[]) => {
    const key = pathKey(path)
    const title = titleOf(node)
    if (confirming === key) {
      const count = countDescendants(node, options)
      return (
        <span className="gcms-tree-actions" role="group" aria-label={`Delete ${title}?`}>
          <span className="gcms-tree-confirm">
            Delete with {count} nested item{count === 1 ? '' : 's'}?
          </span>
          <button type="button" className="gcms-button gcms-button--danger gcms-button--small" autoFocus onClick={() => remove(path)}>
            Delete
          </button>
          <button
            type="button"
            className="gcms-button gcms-button--ghost gcms-button--small"
            onClick={() => {
              setConfirming(null)
              focusItem(key)
            }}
          >
            Cancel
          </button>
        </span>
      )
    }
    const button = (label: string, symbol: ReactNode, shortcut: string, onClick: () => void, enabled = true) => (
      <button
        type="button"
        className="gcms-icon-button"
        aria-label={`${label}: ${title}`}
        title={shortcut ? `${label} (${shortcut})` : label}
        aria-disabled={enabled ? undefined : true}
        onClick={enabled ? onClick : undefined}
      >
        {symbol}
      </button>
    )
    const parent = path.slice(0, -1)
    const index = path[path.length - 1]
    return (
      <span className="gcms-tree-actions" role="group" aria-label={`Actions for ${title}`}>
        <button
          type="button"
          className="gcms-button gcms-button--ghost gcms-button--small"
          aria-expanded={editing === key}
          onClick={() => {
            setEditing(editing === key ? null : key)
            if (editing !== key) pendingFocus.current = { key, field: true }
          }}
        >
          {editing === key ? 'Close' : 'Edit'}
        </button>
        {button('Add item after', '+', '', () => add(parent, index + 1))}
        {button('Add child', '↳', '', () => add(path, childrenOf(node).length), fits(path.length + 1))}
        {button('Move up', '↑', 'Alt+↑', () => apply(moveUp(nodes, path, options)), Boolean(moveUp(nodes, path, options)))}
        {button('Move down', '↓', 'Alt+↓', () => apply(moveDown(nodes, path, options)), Boolean(moveDown(nodes, path, options)))}
        {button('Outdent', '←', 'Alt+←', () => apply(outdentNode(nodes, path, options)), Boolean(outdentNode(nodes, path, options)))}
        {button('Indent', '→', 'Alt+→', () => apply(indentNode(nodes, path, options)), Boolean(indentNode(nodes, path, options)))}
        {button('Delete', '✕', 'Delete', () => remove(path))}
      </span>
    )
  }

  let position = -1
  const renderNodes = (list: Node[], parent: number[]): ReactNode =>
    list.map((node, index) => {
      const path = [...parent, index]
      const key = pathKey(path)
      const at = ++position
      const children = childrenOf(node)
      const expanded = children.length > 0 && !collapsed.has(key)
      const isActive = active === key
      const detail = detailKey === undefined ? undefined : node[detailKey]
      const labelId = `${props.id}-item-${key}`
      const dropHere = drop?.key === key ? ` gcms-tree-drop--${drop.position}` : ''
      return (
        <li
          key={key}
          role="treeitem"
          aria-level={path.length}
          aria-setsize={list.length}
          aria-posinset={index + 1}
          aria-expanded={children.length > 0 ? expanded : undefined}
          aria-selected={isActive}
          aria-labelledby={labelId}
          tabIndex={isActive ? 0 : -1}
          data-path={key}
          className="gcms-tree-item"
          onKeyDown={(event) => onItemKeyDown(event, path, at)}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setSelected(key)
          }}
        >
          <div
            className={`gcms-tree-row${isActive ? ' gcms-tree-row--active' : ''}${invalid.has(key) ? ' gcms-tree-row--invalid' : ''}${dragging === key ? ' gcms-tree-row--dragging' : ''}${dropHere}`}
            draggable
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('button')) return
              focusItem(key)
            }}
            onDragStart={(event) => {
              event.dataTransfer?.setData('text/plain', titleOf(node))
              if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
              setDragging(key)
            }}
            onDragOver={(event) => {
              if (dragging === null) return
              let where = dropPosition(event)
              // Too deep to nest here: offer the spot after the row instead.
              if (where === 'inside' && !dropChange(dragging, path, 'inside')) where = 'after'
              if (!dropChange(dragging, path, where)) {
                setDrop(null)
                return
              }
              event.preventDefault()
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
              if (drop?.key !== key || drop.position !== where) setDrop({ key, position: where })
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dragging !== null && drop) {
                const target = getNode(nodes, toPath(dragging), options)
                setStatus(`Moved ${titleOf(target)}`)
                apply(dropChange(dragging, toPath(drop.key), drop.position))
              }
              setDragging(null)
              setDrop(null)
            }}
            onDragEnd={() => {
              setDragging(null)
              setDrop(null)
            }}
          >
            <span className="gcms-tree-handle" aria-hidden>
              ⋮⋮
            </span>
            {children.length > 0 ? (
              <button type="button" className="gcms-tree-toggle" tabIndex={-1} aria-hidden onClick={() => toggle(key)}>
                {expanded ? '▾' : '▸'}
              </button>
            ) : (
              <span className="gcms-tree-toggle" aria-hidden />
            )}
            <span className="gcms-tree-text" id={labelId}>
              <span className="gcms-tree-label">{titleOf(node)}</span>
              {typeof detail === 'string' && detail !== '' ? <span className="gcms-tree-detail"> {detail}</span> : null}
              {invalid.has(key) ? <span className="gcms-tree-flag"> (has errors)</span> : null}
            </span>
            {isActive ? renderToolbar(node, path) : null}
          </div>
          {editing === key ? renderEditor(node, path) : null}
          {expanded ? <ul role="group">{renderNodes(children, path)}</ul> : null}
        </li>
      )
    })

  const parents = all.filter((item) => item.hasChildren).map((item) => pathKey(item.path))
  const label = typeof props.label === 'string' && props.label ? props.label : 'Tree'

  return (
    <div className="gcms-tree" ref={(node) => {
        element.current = node
        ;(field.ref as (instance: HTMLElement | null) => void)(node)
      }} tabIndex={-1}>
      <div className="gcms-tree-toolbar">
        <button type="button" className="gcms-button gcms-button--small gcms-tree-add" id={props.id} onClick={() => add([], nodes.length)}>
          Add item
        </button>
        <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" disabled={collapsed.size === 0} onClick={() => setCollapsed(new Set())}>
          Expand all
        </button>
        <button
          type="button"
          className="gcms-button gcms-button--ghost gcms-button--small"
          disabled={parents.every((key) => collapsed.has(key))}
          onClick={() => {
            setCollapsed(new Set(parents))
            // Keep focus on a visible item.
            if (active && active.includes('.')) setSelected(active.split('.')[0])
          }}
        >
          Collapse all
        </button>
        <span className="gcms-muted" role="status">
          {status}
        </span>
      </div>
      {nodes.length === 0 ? (
        <p className="gcms-tree-empty">No items yet.</p>
      ) : (
        <ul className="gcms-tree-list" role="tree" aria-label={label} aria-describedby={`${props.id}-help`}>
          {renderNodes(nodes, [])}
        </ul>
      )}
      {problems.length > 0 ? (
        <ul className="gcms-error gcms-tree-problems" role="alert">
          {problems.map(({ path, messages }) => (
            <li key={pathKey(path)}>
              <button type="button" className="gcms-link" onClick={() => reveal(path)}>
                {trail(path)}
              </button>
              : {messages.join('. ')}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="gcms-muted" id={`${props.id}-help`}>
        Arrow keys move through the items, Enter edits one, Alt+arrows move and indent it, Delete removes it. Rows can also be dragged:
        onto the middle of a row to nest under it.
        {options.maxDepth ? ` At most ${options.maxDepth} level${options.maxDepth === 1 ? '' : 's'} deep.` : ''}
      </p>
    </div>
  )
}
