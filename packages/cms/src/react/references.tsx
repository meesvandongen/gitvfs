import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { useFieldRHF } from '@autoform/react/react-hook-form'
import type { AutoFormFieldProps } from '@autoform/react'
import type { GitCms } from '../cms.js'
import type { EntrySummary } from '../config.js'
import {
  displayText,
  matchesQuery,
  referenceKey,
  toReferenceValues,
  type ReferenceCustomData,
  type ReferenceValue,
} from '../references.js'
import { useCms } from './context.js'
import { NestedErrors } from './field-utils.js'
import { useCmsNavigate } from './navigation.js'
import { errorMessage } from './use-async.js'

// Not imported from ./autoform.js, which imports this module for its field components.
const useField = (name: string) => useFieldRHF({ name }).field

/** Options rendered at once; more are reached by typing. Keeps huge collections responsive. */
const VISIBLE_OPTIONS = 50

// --- Entries -------------------------------------------------------------------------------------

interface CachedList {
  promise: Promise<EntrySummary[]>
  users: number
}

const lists = new WeakMap<GitCms, Map<string, CachedList>>()

/**
 * One `listEntries` call per collection, shared by every reference field on screen. The list is
 * dropped once no field uses it, so the next form (after creating or renaming an entry) is fresh.
 */
function acquireEntries(cms: GitCms, name: string): { promise: Promise<EntrySummary[]>; release: () => void } {
  let byName = lists.get(cms)
  if (!byName) lists.set(cms, (byName = new Map()))
  const cache = byName
  let cached = cache.get(name)
  if (!cached) cache.set(name, (cached = { promise: cms.listEntries(name), users: 0 }))
  const list = cached
  list.users++
  let released = false
  return {
    promise: list.promise,
    release: () => {
      if (released) return
      released = true
      list.users--
      // A tick later: React re-runs effects right away in development, which should not refetch.
      setTimeout(() => {
        if (list.users === 0 && cache.get(name) === list) cache.delete(name)
      }, 0)
    },
  }
}

/** An entry the field can point at. */
interface ReferenceOption {
  key: string
  ref: ReferenceValue
  label: string
  /** The `display` text, if any. */
  detail: string
  collectionLabel: string
}

function useReferenceOptions(options: ReferenceCustomData['reference']) {
  const cms = useCms()
  const names = options.collections
  const labels = names.map((name) => cms.collections.find((collection) => collection.name === name)?.label ?? name)
  const [state, setState] = useState<{ lists?: EntrySummary[][]; error?: unknown }>({})
  const namesKey = names.join('\n')

  useEffect(() => {
    let cancelled = false
    const leases = namesKey.split('\n').map((name) => acquireEntries(cms, name))
    Promise.all(leases.map((lease) => lease.promise)).then(
      (loaded) => !cancelled && setState({ lists: loaded }),
      (error: unknown) => !cancelled && setState({ error }),
    )
    return () => {
      cancelled = true
      for (const lease of leases) lease.release()
    }
  }, [cms, namesKey])

  const entries = useMemo(
    () =>
      state.lists?.flatMap((list, index) =>
        list.map((entry): ReferenceOption => {
          const ref = { collection: names[index], slug: entry.slug }
          return { key: referenceKey(ref, ''), ref, label: entry.label, detail: displayText(entry, options.display), collectionLabel: labels[index] }
        }),
      ),
    // `names` and `labels` follow from `state.lists`, which is loaded for them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.lists, options.display],
  )
  return { entries, error: state.error, labels }
}

function referenceOptions(props: AutoFormFieldProps): ReferenceCustomData['reference'] {
  const options = (props.parsedField.fieldConfig?.customData as ReferenceCustomData | undefined)?.reference
  if (!options) throw new Error(`Field "${props.id}" has no reference options; create it with reference() or references()`)
  return options
}

/** Opens a referenced entry in `CmsApp`; `DocumentEditor` asks first when there are unsaved changes. */
function useOpenEntry(): ((ref: ReferenceValue) => void) | undefined {
  const navigate = useCmsNavigate()
  return navigate && ((ref) => navigate({ type: 'collection', name: ref.collection, slug: ref.slug }))
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as { current: T | null }).current = node
    }
  }
}

function optionMeta(option: ReferenceOption, polymorphic: boolean): string {
  return [option.detail, polymorphic ? option.collectionLabel : '', option.ref.slug].filter(Boolean).join(' · ')
}

// --- Combobox ------------------------------------------------------------------------------------

interface EntryComboboxProps {
  id: string
  /** `undefined` while loading. */
  options: ReferenceOption[] | undefined
  /** Shown when the user is not typing: the picked entry for one reference, empty for a list. */
  text: string
  /** Option marked as the current value. */
  currentKey?: string
  placeholder: string
  /** Shown instead of options, e.g. when the list is full. */
  notice?: string
  polymorphic: boolean
  failed: boolean
  inputRef?: Ref<HTMLInputElement>
  inputProps?: Record<string, unknown>
  onSelect: (option: ReferenceOption) => void
  onBlur?: () => void
}

/**
 * A text box that filters a list of entries, following the WAI-ARIA combobox pattern: arrow keys
 * move through the options, Enter picks one, Escape closes the list and then restores the text.
 */
function EntryCombobox(props: EntryComboboxProps) {
  const listId = useId()
  const [query, setQuery] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const matches = useMemo(
    () =>
      props.notice || !props.options
        ? []
        : props.options.filter((option) => matchesQuery([option.label, option.ref.slug, option.detail, option.collectionLabel], query ?? '')),
    [props.options, props.notice, query],
  )
  const shown = matches.slice(0, VISIBLE_OPTIONS)
  const activeIndex = Math.min(active, shown.length - 1)
  const optionId = (index: number) => `${listId}-option-${index}`

  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex])

  const show = (index?: number) => {
    setOpen(true)
    const current = shown.findIndex((option) => option.key === props.currentKey)
    setActive(index ?? Math.max(current, 0))
  }
  const choose = (option: ReferenceOption) => {
    props.onSelect(option)
    setQuery(null)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = shown.length
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) show()
        else if (count > 0) setActive((activeIndex + 1) % count)
        break
      case 'ArrowUp':
        event.preventDefault()
        if (!open) show(Math.max(count - 1, 0))
        else if (count > 0) setActive((activeIndex - 1 + count) % count)
        break
      case 'Enter':
        // Pick the option instead of submitting the form.
        if (open && shown[activeIndex]) {
          event.preventDefault()
          choose(shown[activeIndex])
        }
        break
      case 'Escape':
        if (open) {
          event.preventDefault()
          setOpen(false)
        } else if (query !== null) {
          event.preventDefault()
          setQuery(null)
        }
        break
    }
  }

  let status: string | null = null
  if (props.notice) status = props.notice
  else if (props.failed) status = 'Entries could not be loaded.'
  else if (!props.options) status = 'Loading…'
  else if (shown.length === 0) status = query ? 'No matching entries.' : 'No entries to pick.'
  else if (matches.length > shown.length) status = `Showing ${shown.length} of ${matches.length}; type to narrow down.`

  return (
    <div className="gcms-ref-combobox">
      <input
        type="text"
        className="gcms-input"
        autoComplete="off"
        {...props.inputProps}
        id={props.id}
        ref={props.inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        placeholder={props.placeholder}
        value={query ?? props.text}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={(event) => event.target.select()}
        onClick={() => (open ? undefined : show())}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setOpen(false)
          setQuery(null)
          props.onBlur?.()
        }}
      />
      <div className="gcms-ref-popup" hidden={!open}>
        <ul className="gcms-ref-listbox" role="listbox" id={listId} aria-label="Entries">
          {shown.map((option, index) => (
            <li
              key={option.key}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={`gcms-ref-option${index === activeIndex ? ' gcms-ref-option--active' : ''}`}
              // Keep focus in the text box, so the list does not close before the click lands.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => index !== activeIndex && setActive(index)}
              onClick={() => choose(option)}
            >
              <span className="gcms-ref-option-label">
                {option.label}
                {option.key === props.currentKey ? <span className="gcms-ref-current"> (current)</span> : null}
              </span>
              <span className="gcms-ref-meta">{optionMeta(option, props.polymorphic)}</span>
            </li>
          ))}
        </ul>
        {status ? <p className="gcms-ref-status">{status}</p> : null}
      </div>
    </div>
  )
}

// --- Fields --------------------------------------------------------------------------------------

function MissingWarning({ id, children }: { id?: string; children: string }) {
  return (
    <p id={id} className="gcms-warning" role="status">
      {children}
    </p>
  )
}

function LoadError({ error, labels }: { error: unknown; labels: string[] }) {
  if (!error) return null
  return (
    <p className="gcms-error" role="alert">
      Could not load {labels.join(' and ')}: {errorMessage(error)}
    </p>
  )
}

/** One entry of another collection: a searchable list, with Open and Clear buttons. */
export function ReferenceField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const options = referenceOptions(props)
  const { entries, error, labels } = useReferenceOptions(options)
  const openEntry = useOpenEntry()
  const ref = toReferenceValues(field.value, options.collections[0])[0] as ReferenceValue | undefined
  const key = ref && referenceKey(ref, '')
  const entry = key === undefined ? undefined : entries?.find((option) => option.key === key)
  const missing = ref !== undefined && entries !== undefined && entry === undefined
  const warningId = `${props.id}-missing`
  const collectionLabel = ref && (labels[options.collections.indexOf(ref.collection)] ?? ref.collection)

  return (
    <div className="gcms-ref">
      <div className="gcms-ref-row">
        <EntryCombobox
          id={props.id}
          options={entries}
          failed={Boolean(error)}
          text={entry?.label ?? ref?.slug ?? ''}
          currentKey={key}
          polymorphic={options.polymorphic}
          placeholder={`Search ${labels.join(' and ')}…`}
          inputRef={field.ref}
          inputProps={{ ...props.inputProps, 'aria-describedby': missing ? warningId : undefined }}
          onSelect={(option) => field.onChange(options.polymorphic ? option.ref : option.ref.slug)}
          onBlur={field.onBlur}
        />
        {entry && openEntry ? (
          <button type="button" className="gcms-button gcms-button--small" aria-label={`Open ${entry.label}`} onClick={() => openEntry(entry.ref)}>
            Open
          </button>
        ) : null}
        {/* null, not undefined: react-hook-form shows the default value again for undefined. AutoForm
            treats null as empty, so an optional field is saved as absent and a required one is flagged. */}
        {ref ? (
          <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={() => field.onChange(null)}>
            Clear
          </button>
        ) : null}
      </div>
      {entry ? <p className="gcms-ref-meta">{optionMeta(entry, options.polymorphic)}</p> : null}
      {missing ? (
        <MissingWarning id={warningId}>
          {`${collectionLabel} has no entry “${ref.slug}”. It may have been renamed, deleted or not created yet: pick another entry or clear the field.`}
        </MissingWarning>
      ) : null}
      <LoadError error={error} labels={labels} />
      <NestedErrors name={props.id} />
    </div>
  )
}

type Pending = { key: string; action: 'up' | 'down' | 'remove' } | { key: null } | null

/** An ordered list of entries: add from a searchable list, reorder and remove with buttons. */
export function ReferencesField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const options = referenceOptions(props)
  const { entries, error, labels } = useReferenceOptions(options)
  const openEntry = useOpenEntry()
  const values: unknown[] = Array.isArray(field.value) ? field.value : []
  const itemElements = useRef(new Map<string, HTMLLIElement>())
  const input = useRef<HTMLInputElement | null>(null)
  const pendingFocus = useRef<Pending>(null)
  const [announcement, setAnnouncement] = useState('')

  const seen = new Map<string, number>()
  const items = values.map((value, index) => {
    const ref = toReferenceValues(value, options.collections[0])[0] as ReferenceValue | undefined
    const refKey = ref ? referenceKey(ref, '') : `invalid:${index}`
    const count = seen.get(refKey) ?? 0
    seen.set(refKey, count + 1)
    const entry = ref && entries?.find((option) => option.key === refKey)
    const label = entry?.label ?? ref?.slug ?? 'Invalid item'
    return { value, ref, key: count === 0 ? refKey : `${refKey}#${count}`, refKey, entry, label, missing: ref !== undefined && entries !== undefined && !entry }
  })
  const picked = new Set(items.map((item) => item.refKey))
  const available = entries?.filter((option) => !picked.has(option.key))
  const full = options.max !== undefined && values.length >= options.max
  const missingCount = items.filter((item) => item.missing).length

  // Keep focus on the button that was used, now that its item moved or is gone.
  useEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    pendingFocus.current = null
    const element = pending.key === null ? undefined : itemElements.current.get(pending.key)
    if (!element || pending.key === null) {
      input.current?.focus()
      return
    }
    const button = (action: string) => element.querySelector<HTMLButtonElement>(`[data-action="${action}"]:not(:disabled)`)
    const fallback = pending.action === 'up' ? 'down' : pending.action === 'down' ? 'up' : 'remove'
    ;(button(pending.action) ?? button(fallback))?.focus()
  })

  const set = (next: unknown[]) => field.onChange(next)
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta
    const next = [...values]
    ;[next[index], next[target]] = [next[target], next[index]]
    pendingFocus.current = { key: items[index].key, action: delta < 0 ? 'up' : 'down' }
    setAnnouncement(`Moved ${items[index].label} to position ${target + 1} of ${values.length}.`)
    set(next)
  }
  const remove = (index: number) => {
    const neighbour = items[index + 1] ?? items[index - 1]
    pendingFocus.current = neighbour ? { key: neighbour.key, action: 'remove' } : { key: null }
    setAnnouncement(`Removed ${items[index].label}.`)
    set(values.filter((_, at) => at !== index))
  }

  return (
    <div className="gcms-ref">
      {items.length > 0 ? (
        <ol className="gcms-ref-list">
          {items.map((item, index) => (
            <li
              key={item.key}
              className={`gcms-ref-item${item.missing || !item.ref ? ' gcms-ref-item--missing' : ''}`}
              ref={(element) => {
                if (element) itemElements.current.set(item.key, element)
                else itemElements.current.delete(item.key)
              }}
            >
              <span className="gcms-ref-item-text">
                <span className="gcms-ref-item-label">{item.label}</span>
                <span className="gcms-ref-meta">
                  {item.entry ? optionMeta(item.entry, options.polymorphic) : item.ref ? `${options.polymorphic ? `${item.ref.collection} · ` : ''}not found` : JSON.stringify(item.value)}
                </span>
              </span>
              <span className="gcms-ref-item-actions">
                {item.entry && openEntry ? (
                  <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" aria-label={`Open ${item.label}`} onClick={() => openEntry(item.entry!.ref)}>
                    Open
                  </button>
                ) : null}
                <button type="button" className="gcms-ref-icon" data-action="up" aria-label={`Move ${item.label} up`} title="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                  ↑
                </button>
                <button type="button" className="gcms-ref-icon" data-action="down" aria-label={`Move ${item.label} down`} title="Move down" disabled={index === items.length - 1} onClick={() => move(index, 1)}>
                  ↓
                </button>
                <button type="button" className="gcms-ref-icon" data-action="remove" aria-label={`Remove ${item.label}`} title="Remove" onClick={() => remove(index)}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <EntryCombobox
        id={props.id}
        options={available}
        failed={Boolean(error)}
        text=""
        polymorphic={options.polymorphic}
        placeholder={full ? `The maximum of ${options.max} is reached` : `Add from ${labels.join(' and ')}…`}
        notice={full ? `The maximum of ${options.max} is reached; remove one to add another.` : undefined}
        inputRef={mergeRefs(field.ref, input)}
        inputProps={props.inputProps}
        onSelect={(option) => {
          setAnnouncement(`Added ${option.label}.`)
          set([...values, options.polymorphic ? option.ref : option.ref.slug])
        }}
        onBlur={field.onBlur}
      />
      {missingCount > 0 ? (
        <MissingWarning>
          {`${missingCount === 1 ? 'One picked entry no longer exists' : `${missingCount} picked entries no longer exist`}. They may have been renamed or deleted: remove them or pick others.`}
        </MissingWarning>
      ) : null}
      <LoadError error={error} labels={labels} />
      <NestedErrors name={props.id} />
      <p className="gcms-visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
