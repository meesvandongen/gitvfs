import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { AutoFormField, useFieldRHF } from '@autoform/react/react-hook-form'
import type { AutoFormFieldProps, ParsedField } from '@autoform/react'
import {
  MAX_LABEL_CHARS,
  autoLayout,
  boundaryPoint,
  canConnect,
  edgeOffsets,
  fitGraph,
  fromScreen,
  graphBounds,
  kindList,
  nodeAt,
  nodeBox,
  routeEdge,
  snap,
  freeSpot,
  toGraph,
  toScreen,
  uniqueId,
  zoomView,
  type Graph,
  type GraphCustomData,
  type GraphEdge,
  type GraphNode,
  type GraphOptions,
  type GraphView,
  type NodeBox,
  type Point,
} from '../graph.js'
import { errorMessages, useErrorTree } from './field-utils.js'

// Not imported from ./autoform.js, which imports this module for its field components.
const useField = (name: string) => useFieldRHF({ name }).field

/** Used until the canvas is measured, and where layout is not available (tests, SSR). */
const FALLBACK_WIDTH = 600
const DRAG_THRESHOLD = 4
const NEW_NODE_LABEL = 'New node'

type Selection = { type: 'node'; id: string } | { type: 'edge'; index: number } | null

type Interaction =
  | { kind: 'pan'; pointer: number; start: Point; view: GraphView; moved: boolean }
  | { kind: 'drag'; pointer: number; id: string; start: Point; offset: Point; moved: boolean }
  | { kind: 'connect'; pointer: number; from: string }
  | { kind: 'edge'; pointer: number }

function graphOptions(props: AutoFormFieldProps): GraphOptions {
  return (props.parsedField.fieldConfig?.customData as GraphCustomData | undefined)?.graph ?? {}
}

/** The parsed fields of a node or edge, minus the ones the editor handles itself. */
function itemFields(parsedField: ParsedField, list: 'nodes' | 'edges', handled: readonly string[]): ParsedField[] {
  const item = parsedField.schema?.find((child) => child.key === list)?.schema?.[0]
  return (item?.schema ?? []).filter((child) => !handled.includes(child.key))
}

const truncate = (label: string) => {
  const characters = Array.from(label)
  return characters.length > MAX_LABEL_CHARS ? `${characters.slice(0, MAX_LABEL_CHARS - 1).join('')}…` : label
}

const nodeName = (node: GraphNode | undefined, fallback = 'missing node') => (node ? String(node.label || node.id) : fallback)

/**
 * Edits `{ nodes, edges }`: a canvas to add, drag and connect nodes (with pan, zoom, fit and auto
 * layout), a list view that does everything with plain inputs, and a panel for the selected node or
 * edge that renders its declared fields with the regular CMS inputs.
 */
export function GraphField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const options = graphOptions(props)
  const directed = options.directed ?? true
  const grid = options.grid ?? 20
  const height = options.height ?? 420
  const kinds = options.nodeKinds
  const kindOptions = kindList(kinds)
  const graph = toGraph(field.value)
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))

  const [selection, setSelection] = useState<Selection>(null)
  // Changes whenever the user picks another item, so the panel's inner form starts over.
  const [selectionKey, setSelectionKey] = useState(0)
  const [mode, setMode] = useState<'canvas' | 'list'>('canvas')
  const [snapping, setSnapping] = useState(grid > 0)
  const [status, setStatus] = useState('')
  const labelInput = useRef<HTMLInputElement | null>(null)
  const nodeElements = useRef(new Map<string, SVGGElement>())
  const pendingFocus = useRef<'label' | null>(null)

  // Ids in the stored graph stay reserved for the whole session, even after their node is deleted:
  // other content, or an old revision, may still point at them.
  const reserved = useRef<Set<string> | null>(null)
  reserved.current ??= new Set(graph.nodes.map((node) => node.id))
  // Nodes added in this session take their id from their label until the editor closes.
  const fresh = useRef(new Set<string>())

  const latest = useRef(graph)
  latest.current = graph
  const commit = (next: Graph) => {
    latest.current = next
    field.onChange({ ...(field.value as object | undefined), nodes: next.nodes, edges: next.edges })
  }
  const announce = (message: string) => setStatus(message)
  const select = (next: Selection) => {
    setSelection(next)
    setSelectionKey((key) => key + 1)
  }
  const takenIds = (except?: string) => {
    const taken = new Set(reserved.current)
    for (const node of latest.current.nodes) taken.add(node.id)
    if (except !== undefined && fresh.current.has(except)) taken.delete(except)
    return taken
  }

  // A graph written by hand may leave out positions: lay it out once, and keep the result.
  useEffect(() => {
    if (graph.nodes.some((node) => !Number.isFinite(node.x) || !Number.isFinite(node.y))) {
      commit({ ...graph, nodes: autoLayout(graph, { direction: options.direction, directed, nodeKinds: kinds, grid }) })
    }
    // Only for the value the editor opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const target = pendingFocus.current
    pendingFocus.current = null
    if (target === 'label') {
      labelInput.current?.focus()
      labelInput.current?.select()
    }
  })

  // --- Operations --------------------------------------------------------------------------------

  const addNode = (at: Point) => {
    const current = latest.current
    const id = uniqueId(NEW_NODE_LABEL, takenIds())
    const spot = freeSpot(current.nodes, { x: snap(at.x, snapping ? grid : 0), y: snap(at.y, snapping ? grid : 0) })
    const node: GraphNode = { id, label: NEW_NODE_LABEL, x: spot.x, y: spot.y, ...(kindOptions.length > 0 ? { kind: kindOptions[0].value } : {}) }
    fresh.current.add(id)
    commit({ ...current, nodes: [...current.nodes, node] })
    select({ type: 'node', id })
    pendingFocus.current = 'label'
    announce(`Added a node. Type its label.`)
  }

  const setLabel = (id: string, label: string) => {
    const current = latest.current
    let nextId = id
    if (fresh.current.has(id)) {
      nextId = uniqueId(label, takenIds(id))
      fresh.current.delete(id)
      fresh.current.add(nextId)
    }
    const rename = (ref: string) => (ref === id ? nextId : ref)
    commit({
      nodes: current.nodes.map((node) => (node.id === id ? { ...node, id: nextId, label } : node)),
      edges: nextId === id ? current.edges : current.edges.map((edge) => ({ ...edge, from: rename(edge.from), to: rename(edge.to) })),
    })
    if (nextId !== id) setSelection((selected) => (selected?.type === 'node' && selected.id === id ? { type: 'node', id: nextId } : selected))
  }

  const updateNode = (id: string, patch: Partial<GraphNode>) => {
    const current = latest.current
    commit({ ...current, nodes: current.nodes.map((node) => (node.id === id ? merge(node, patch) : node)) })
  }

  const removeNode = (id: string) => {
    const current = latest.current
    const node = current.nodes.find((candidate) => candidate.id === id)
    const edges = current.edges.filter((edge) => edge.from !== id && edge.to !== id)
    const removed = current.edges.length - edges.length
    commit({ nodes: current.nodes.filter((candidate) => candidate.id !== id), edges })
    fresh.current.delete(id)
    select(null)
    announce(`Deleted ${nodeName(node)}${removed ? ` and ${removed} edge${removed === 1 ? '' : 's'}` : ''}.`)
  }

  const addEdge = (from: string, to: string): boolean => {
    const current = latest.current
    const allowed = canConnect(current, from, to, options)
    if (allowed !== true) {
      announce(allowed)
      return false
    }
    commit({ ...current, edges: [...current.edges, { from, to }] })
    select({ type: 'edge', index: current.edges.length })
    announce(`Connected ${nodeName(nodeById.get(from))} to ${nodeName(nodeById.get(to))}.`)
    return true
  }

  const updateEdge = (index: number, patch: Partial<GraphEdge>) => {
    const current = latest.current
    commit({
      ...current,
      edges: current.edges.map((edge, at) => {
        if (at !== index) return edge
        // No `label: ''` lines in the file.
        return merge(edge, patch.label === '' ? { ...patch, label: undefined } : patch)
      }),
    })
  }

  const removeEdge = (index: number) => {
    const current = latest.current
    commit({ ...current, edges: current.edges.filter((_, at) => at !== index) })
    select(null)
    announce('Deleted the edge.')
  }

  const removeSelection = () => {
    if (selection?.type === 'node') removeNode(selection.id)
    else if (selection?.type === 'edge') removeEdge(selection.index)
  }

  // --- View --------------------------------------------------------------------------------------

  const canvas = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  const size = { width, height }
  const [view, setView] = useState<GraphView>(() => fitGraph(graphBounds(graph.nodes, kinds), { width: FALLBACK_WIDTH, height }))
  const [hint, setHint] = useState(false)
  const [connecting, setConnecting] = useState<{ from: string; to: Point } | null>(null)
  const interaction = useRef<Interaction | null>(null)
  const viewState = useRef({ view, size })
  viewState.current = { view, size }

  useLayoutEffect(() => {
    const node = canvas.current
    if (!node) return
    const measure = () => {
      const measured = node.getBoundingClientRect().width
      if (measured > 0) setWidth(measured)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [mode])

  const fit = (nodes = latest.current.nodes) => setView(fitGraph(graphBounds(nodes, kinds), viewState.current.size))
  const zoomBy = (factor: number, anchor?: Point) =>
    setView((current) => zoomView(current, current.zoom * factor, viewState.current.size, anchor))

  const layout = () => {
    const current = latest.current
    const nodes = autoLayout(current, { direction: options.direction, directed, nodeKinds: kinds, grid: snapping ? grid : 0 })
    commit({ ...current, nodes })
    fit(nodes)
    announce('Arranged the nodes in layers.')
  }

  // Scrolling over the canvas in a long form should scroll the form; zoom only with Ctrl or ⌘ held.
  useEffect(() => {
    const node = canvas.current
    if (!node) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        setHint(true)
        clearTimeout(timer)
        timer = setTimeout(() => setHint(false), 1200)
        return
      }
      event.preventDefault()
      const rect = node.getBoundingClientRect()
      zoomBy(event.deltaY < 0 ? 1.2 : 1 / 1.2, { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      clearTimeout(timer)
      node.removeEventListener('wheel', onWheel)
    }
  }, [mode])

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvas.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }
  const graphPoint = (event: { clientX: number; clientY: number }) => fromScreen(localPoint(event), viewState.current.view, viewState.current.size)

  // One handler for the whole canvas; the element under the pointer decides what a drag does.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as Element
    const pointer = event.pointerId
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle')
    const nodeId = target.closest('[data-node]')?.getAttribute('data-node')
    const edgeIndex = target.closest('[data-edge]')?.getAttribute('data-edge')
    if (handle != null) {
      interaction.current = { kind: 'connect', pointer, from: handle }
      setConnecting({ from: handle, to: graphPoint(event) })
    } else if (nodeId != null) {
      const node = latest.current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return
      const point = graphPoint(event)
      interaction.current = { kind: 'drag', pointer, id: nodeId, start: localPoint(event), offset: { x: point.x - node.x, y: point.y - node.y }, moved: false }
      // Focusing the node selects it (see onFocus), and makes the keyboard act on it.
      nodeElements.current.get(nodeId)?.focus({ preventScroll: true })
    } else if (edgeIndex != null) {
      interaction.current = { kind: 'edge', pointer }
      select({ type: 'edge', index: Number(edgeIndex) })
      canvas.current?.focus({ preventScroll: true })
    } else {
      interaction.current = { kind: 'pan', pointer, start: localPoint(event), view: viewState.current.view, moved: false }
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(pointer)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = interaction.current
    if (!state || state.pointer !== event.pointerId) return
    if (state.kind === 'pan') {
      const now = localPoint(event)
      const dx = now.x - state.start.x
      const dy = now.y - state.start.y
      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      state.moved = true
      setView({ ...state.view, x: state.view.x - dx / state.view.zoom, y: state.view.y - dy / state.view.zoom })
    } else if (state.kind === 'drag') {
      const now = localPoint(event)
      if (!state.moved && Math.hypot(now.x - state.start.x, now.y - state.start.y) < DRAG_THRESHOLD) return
      state.moved = true
      const point = graphPoint(event)
      const step = snapping ? grid : 0
      const x = snap(point.x - state.offset.x, step)
      const y = snap(point.y - state.offset.y, step)
      const node = latest.current.nodes.find((candidate) => candidate.id === state.id)
      if (node && (node.x !== x || node.y !== y)) updateNode(state.id, { x, y })
    } else if (state.kind === 'connect') {
      setConnecting({ from: state.from, to: graphPoint(event) })
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = interaction.current
    if (!state || state.pointer !== event.pointerId) return
    interaction.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (state.kind === 'pan' && !state.moved) {
      select(null)
      canvas.current?.focus({ preventScroll: true })
    } else if (state.kind === 'connect') {
      setConnecting(null)
      const target = nodeAt(latest.current.nodes, graphPoint(event), kinds)
      if (target) addEdge(state.from, target.id)
    }
  }

  const onPointerCancel = () => {
    interaction.current = null
    setConnecting(null)
  }

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element
    if (target.closest('[data-node]')) {
      pendingFocus.current = 'label'
      setSelectionKey((key) => key + 1)
    } else if (!target.closest('[data-edge]') && !target.closest('button')) {
      addNode(graphPoint(event))
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nodeId = (event.target as Element).closest?.('[data-node]')?.getAttribute('data-node')
    const node = nodeId == null ? undefined : latest.current.nodes.find((candidate) => candidate.id === nodeId)
    const step = (snapping && grid > 0 ? grid : 10) * (event.shiftKey ? 5 : 1)
    const arrows: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }
    let handled = true
    if (arrows[event.key] && node) {
      const { x, y } = arrows[event.key]
      updateNode(node.id, { x: snap(node.x + x * step, snapping ? grid : 0), y: snap(node.y + y * step, snapping ? grid : 0) })
    } else if (arrows[event.key]) {
      const { x, y } = arrows[event.key]
      setView((current) => ({ ...current, x: current.x + (x * 80) / current.zoom, y: current.y + (y * 80) / current.zoom }))
    } else if ((event.key === 'Enter' || event.key === 'F2') && node) {
      select({ type: 'node', id: node.id })
      pendingFocus.current = 'label'
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && (node || selection)) {
      if (node) removeNode(node.id)
      else removeSelection()
      canvas.current?.focus({ preventScroll: true })
    } else if (event.key === 'Escape' && (selection || connecting)) {
      interaction.current = null
      setConnecting(null)
      select(null)
      canvas.current?.focus({ preventScroll: true })
    } else if (event.key === '+' || event.key === '=') zoomBy(1.2)
    else if (event.key === '-') zoomBy(1 / 1.2)
    else handled = false
    if (handled) event.preventDefault()
  }

  // --- Drawing -----------------------------------------------------------------------------------

  const errors = useGraphErrors(props.id, graph)
  const boxes = new Map<string, NodeBox>(graph.nodes.map((node) => [node.id, nodeBox(node, kinds)]))
  const offsets = edgeOffsets(graph.edges)
  const origin = toScreen({ x: 0, y: 0 }, view, size)
  const transform = `translate(${origin.x} ${origin.y}) scale(${view.zoom})`
  const connectTarget = connecting ? nodeAt(graph.nodes, connecting.to, kinds) : undefined
  const horizontal = options.direction === 'LR'
  const gridSize = grid * view.zoom
  const selectedNode = selection?.type === 'node' ? nodeById.get(selection.id) : undefined
  const selectedEdge = selection?.type === 'edge' ? graph.edges[selection.index] : undefined
  const label = typeof props.label === 'string' && props.label ? props.label : 'Graph'

  // The details below the canvas keep the tallest height they had: when a selection is cleared in a
  // form scrolled to its end, the page would otherwise jump and move the canvas under the pointer.
  const details = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const element = details.current
    if (!element) return
    const height = element.getBoundingClientRect().height
    if (height > Number.parseFloat(element.style.minHeight || '0')) element.style.minHeight = `${height}px`
  })

  // The kind select shows the kinds' names instead of their values.
  const nodeFields = itemFields(props.parsedField, 'nodes', ['id', 'label', 'x', 'y']).map((child) =>
    child.key === 'kind' && kindOptions.length > 0 ? { ...child, options: kindOptions.map((kind): [string, string] => [kind.value, kind.label]) } : child,
  )
  const edgeFields = itemFields(props.parsedField, 'edges', ['from', 'to', 'label'])
  const scope = props.id.replace(/\W/g, '_')

  const canvasView = (
    <div className="gcms-graph-canvas" style={{ height }}>
      <div
        ref={canvas}
        className="gcms-graph-viewport"
        role="group"
        aria-roledescription="graph editor"
        aria-label={`${label}. Tab to a node; arrow keys move it, Enter edits its label, Delete removes it. Plus and minus zoom.`}
        tabIndex={0}
        style={
          snapping && grid > 0 && gridSize >= 6
            ? { backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${origin.x}px ${origin.y}px` }
            : { backgroundImage: 'none' }
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        <svg className="gcms-graph-svg" width={width} height={height}>
          <g transform={transform}>
            {graph.edges.map((edge, index) => {
              const from = boxes.get(edge.from)
              const to = boxes.get(edge.to)
              if (!from || !to) return null
              const route = routeEdge(from, to, offsets[index])
              const selected = selection?.type === 'edge' && selection.index === index
              const className = `gcms-graph-edge${selected ? ' gcms-graph-edge--selected' : ''}${errors.edges.has(index) ? ' gcms-graph-edge--invalid' : ''}`
              return (
                <g key={index} className={className} data-edge={index}>
                  <title>{`${nodeName(nodeById.get(edge.from))} ${directed ? '→' : '–'} ${nodeName(nodeById.get(edge.to))}${edge.label ? `: ${edge.label}` : ''}`}</title>
                  <path className="gcms-graph-edge-hit" d={route.path} />
                  <path className="gcms-graph-edge-line" d={route.path} />
                  {directed ? <polygon className="gcms-graph-arrow" points={route.arrow} /> : null}
                  {edge.label ? (
                    <text className="gcms-graph-edge-label" x={route.label.x} y={route.label.y} textAnchor={route.anchor}>
                      {truncate(String(edge.label))}
                    </text>
                  ) : null}
                </g>
              )
            })}
            {connecting && boxes.get(connecting.from) ? (
              <ConnectPreview from={boxes.get(connecting.from)!} to={connectTarget && connectTarget.id !== connecting.from ? boxes.get(connectTarget.id)! : connecting.to} />
            ) : null}
            {graph.nodes.map((node) => {
              const box = boxes.get(node.id)!
              const selected = selection?.type === 'node' && selection.id === node.id
              const kind = kindOptions.findIndex((option) => option.value === node.kind)
              const className = [
                'gcms-graph-node',
                selected ? 'gcms-graph-node--selected' : '',
                connectTarget?.id === node.id && connecting?.from !== node.id ? 'gcms-graph-node--target' : '',
                errors.nodes.has(node.id) ? 'gcms-graph-node--invalid' : '',
              ].filter(Boolean).join(' ')
              const nodeLabel = String(node.label ?? '')
              return (
                <g
                  key={node.id}
                  ref={(element) => {
                    if (element) nodeElements.current.set(node.id, element)
                    else nodeElements.current.delete(node.id)
                  }}
                  className={className}
                  data-node={node.id}
                  data-tone={kind >= 0 ? kind % 6 : undefined}
                  transform={`translate(${node.x} ${node.y})`}
                  tabIndex={0}
                  role="button"
                  aria-pressed={selected}
                  aria-label={`${nodeLabel || node.id}${kind >= 0 ? `, ${kindOptions[kind].label}` : ''}`}
                  onFocus={() => {
                    if (selection?.type !== 'node' || selection.id !== node.id) select({ type: 'node', id: node.id })
                  }}
                >
                  <title>{nodeLabel}</title>
                  <NodeOutline box={box} />
                  <text className="gcms-graph-node-label">{truncate(nodeLabel)}</text>
                  <circle
                    className="gcms-graph-handle"
                    data-handle={node.id}
                    cx={horizontal ? box.width / 2 : 0}
                    cy={horizontal ? 0 : box.height / 2}
                    r={6}
                  >
                    <title>Drag to another node to connect</title>
                  </circle>
                </g>
              )
            })}
          </g>
        </svg>
        {graph.nodes.length === 0 ? <p className="gcms-graph-empty">Double-click to add a node</p> : null}
        {hint ? <div className="gcms-graph-hint">Hold Ctrl or ⌘ and scroll to zoom</div> : null}
      </div>
      <div className="gcms-graph-zoom">
        <button type="button" className="gcms-graph-zoom-button" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
          +
        </button>
        <button type="button" className="gcms-graph-zoom-button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
          −
        </button>
      </div>
    </div>
  )

  return (
    <div className="gcms-graph" id={props.id} tabIndex={-1} ref={field.ref as never}>
      <div className="gcms-graph-toolbar" role="toolbar" aria-label={`${label} tools`}>
        <div className="gcms-graph-views">
          {(['canvas', 'list'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className="gcms-graph-view-button"
              aria-pressed={mode === option}
              onClick={() => setMode(option)}
            >
              {option === 'canvas' ? 'Canvas' : 'List'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="gcms-button gcms-button--small"
          disabled={options.maxNodes !== undefined && graph.nodes.length >= options.maxNodes}
          onClick={() => addNode(mode === 'canvas' ? fromScreen({ x: width / 2, y: height / 2 }, view, size) : nextListSpot(graph))}
        >
          Add node
        </button>
        <button type="button" className="gcms-button gcms-button--small" disabled={!selectedNode && !selectedEdge} onClick={removeSelection}>
          Delete
        </button>
        <button type="button" className="gcms-button gcms-button--small" disabled={graph.nodes.length < 2} onClick={layout}>
          Auto layout
        </button>
        {mode === 'canvas' ? (
          <>
            <button type="button" className="gcms-button gcms-button--small" disabled={graph.nodes.length === 0} onClick={() => fit()}>
              Fit to view
            </button>
            {grid > 0 ? (
              <label className="gcms-graph-snap">
                <input type="checkbox" checked={snapping} onChange={(event) => setSnapping(event.target.checked)} />
                Snap to grid
              </label>
            ) : null}
          </>
        ) : null}
      </div>
      {mode === 'canvas' ? (
        <>
          {canvasView}
          <p className="gcms-graph-help">
            Double-click to add a node, drag a node to move it, and drag from its dot to another node to connect them. Drag the background to
            pan. {graph.nodes.length} node{graph.nodes.length === 1 ? '' : 's'}, {graph.edges.length} edge{graph.edges.length === 1 ? '' : 's'}.
          </p>
        </>
      ) : (
        <GraphList
          graph={graph}
          directed={directed}
          selection={selection}
          onSelect={(next) => {
            select(next)
            pendingFocus.current = next?.type === 'node' ? 'label' : null
          }}
          onLabel={setLabel}
          onRemoveNode={removeNode}
          onEdge={updateEdge}
          onRemoveEdge={removeEdge}
          onConnect={addEdge}
        />
      )}
      <div ref={details} className="gcms-graph-details">
        {selectedNode ? (
          <fieldset className="gcms-graph-panel">
            <legend className="gcms-legend">Node</legend>
            <label className="gcms-graph-panel-field">
              <span className="gcms-label">Label</span>
              <input
                ref={labelInput}
                className="gcms-input"
                value={String(selectedNode.label ?? '')}
                onChange={(event) => setLabel(selectedNode.id, event.target.value)}
                onKeyDown={(event) => {
                  // Enter and Escape go back to the node, instead of submitting the form.
                  if ((event.key === 'Enter' || event.key === 'Escape') && mode === 'canvas') {
                    event.preventDefault()
                    nodeElements.current.get(selectedNode.id)?.focus()
                  } else if (event.key === 'Enter') event.preventDefault()
                }}
              />
            </label>
            <p className="gcms-description">
              Id <code>{selectedNode.id}</code>
              {fresh.current.has(selectedNode.id) ? ' (follows the label while this node is new)' : ''}
            </p>
            {nodeFields.length > 0 ? (
              <ItemFields
                key={`node-${selectionKey}`}
                scope={`${scope}__node`}
                fields={nodeFields}
                value={selectedNode}
                onChange={(values) => updateNode(selectedNode.id, values)}
              />
            ) : null}
            <ConnectTo
              graph={graph}
              from={selectedNode.id}
              directed={directed}
              onConnect={(to) => addEdge(selectedNode.id, to)}
            />
            {errors.nodes.get(selectedNode.id)?.length ? (
              <p className="gcms-error">{errors.nodes.get(selectedNode.id)!.join('. ')}</p>
            ) : null}
            <div className="gcms-graph-actions">
              <button type="button" className="gcms-button gcms-button--danger gcms-button--small" onClick={() => removeNode(selectedNode.id)}>
                Delete node
              </button>
            </div>
          </fieldset>
        ) : null}
        {selectedEdge && selection?.type === 'edge' ? (
          <fieldset className="gcms-graph-panel">
            <legend className="gcms-legend">Edge</legend>
            <EdgeInputs
              graph={graph}
              edge={selectedEdge}
              index={selection.index}
              directed={directed}
              onChange={(patch) => updateEdge(selection.index, patch)}
            />
            {edgeFields.length > 0 ? (
              <ItemFields
                key={`edge-${selectionKey}`}
                scope={`${scope}__edge`}
                fields={edgeFields}
                value={selectedEdge}
                onChange={(values) => updateEdge(selection.index, values)}
              />
            ) : null}
            <div className="gcms-graph-actions">
              {directed ? (
                <button type="button" className="gcms-button gcms-button--small" onClick={() => updateEdge(selection.index, { from: selectedEdge.to, to: selectedEdge.from })}>
                  Reverse direction
                </button>
              ) : null}
              <button type="button" className="gcms-button gcms-button--danger gcms-button--small" onClick={() => removeEdge(selection.index)}>
                Delete edge
              </button>
            </div>
          </fieldset>
        ) : null}
        {selectedNode || selectedEdge ? null : <p className="gcms-graph-help">Select a node or an edge to edit it here.</p>}
      </div>
      {errors.messages.length > 0 ? (
        <ul className="gcms-error gcms-graph-errors" role="alert">
          {errors.messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      <p className="gcms-graph-status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  )
}

/**
 * Apply a patch to a node or edge; `undefined` in the patch removes the key, so cleared fields leave
 * no `key: null` or empty lines in the file (and keys keep their order).
 */
function merge<T extends object>(item: T, patch: Partial<T>): T {
  const next: Record<string, unknown> = { ...item, ...patch }
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key]
  return next as T
}

/** Where "Add node" puts a node in the list view: below the lowest node. */
function nextListSpot(graph: Graph): Point {
  const bounds = graphBounds(graph.nodes)
  return bounds ? { x: Math.round(bounds.minX + bounds.width / 2), y: Math.round(bounds.maxY + 60) } : { x: 0, y: 0 }
}

function NodeOutline({ box }: { box: NodeBox }) {
  const w = box.width / 2
  const h = box.height / 2
  if (box.shape === 'diamond') return <polygon className="gcms-graph-shape" points={`0,${-h} ${w},0 0,${h} ${-w},0`} />
  if (box.shape === 'ellipse') return <ellipse className="gcms-graph-shape" rx={w} ry={h} />
  return <rect className="gcms-graph-shape" x={-w} y={-h} width={box.width} height={box.height} rx={box.shape === 'rounded' ? 10 : 2} />
}

function ConnectPreview({ from, to }: { from: NodeBox; to: NodeBox | Point }) {
  const end = 'shape' in to ? boundaryPoint(to, from) : to
  const start = boundaryPoint(from, end)
  return <line className="gcms-graph-connect" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
}

/** Messages from the form's errors under the field, with the node or edge they belong to. */
function useGraphErrors(name: string, graph: Graph) {
  const tree = useErrorTree(name) as
    | { nodes?: unknown; edges?: unknown; message?: unknown }
    | undefined
  const nodes = new Map<string, string[]>()
  const edges = new Map<number, string[]>()
  const messages: string[] = []
  const items = (list: unknown, each: (index: number, found: string[]) => void) => {
    if (!list || typeof list !== 'object') return
    // Errors of the list itself (`Add at least 2 nodes`) sit on the list or its `root`.
    const own = [(list as { message?: unknown }).message, (list as { root?: { message?: unknown } }).root?.message]
    for (const message of own) if (typeof message === 'string') messages.push(message)
    for (const [key, child] of Object.entries(list)) {
      if (!/^\d+$/.test(key)) continue
      const found = errorMessages(child)
      if (found.length > 0) each(Number(key), found)
    }
  }
  items(tree?.nodes, (index, found) => {
    const node = graph.nodes[index]
    if (node) nodes.set(node.id, found)
    messages.push(`${node ? `“${node.label || node.id}”` : `Node ${index + 1}`}: ${found.join('. ')}`)
  })
  items(tree?.edges, (index, found) => {
    edges.set(index, found)
    const edge = graph.edges[index]
    messages.push(`${edge ? `Edge ${edge.from} → ${edge.to}` : `Edge ${index + 1}`}: ${found.join('. ')}`)
  })
  return { nodes, edges, messages: [...new Set(messages)] }
}

/**
 * The declared extra fields of a node or edge, rendered by AutoForm with the CMS inputs. They live in
 * a small form of their own, so the inputs bind to the selected item instead of a list index that
 * shifts when items are deleted; every change is copied into the graph.
 */
function ItemFields({
  scope,
  fields,
  value,
  onChange,
}: {
  scope: string
  fields: ParsedField[]
  value: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}) {
  const form = useForm({ defaultValues: { [scope]: Object.fromEntries(fields.map((child) => [child.key, value[child.key]])) } })
  const latest = useRef({ onChange, fields })
  latest.current = { onChange, fields }

  useEffect(() => {
    const subscription = form.watch((values, { name }) => {
      const edited = (values[scope] ?? {}) as Record<string, unknown>
      // Inputs clear to undefined, which react-hook-form answers by showing the default (the stored
      // value) again. Hold null instead, as the other CMS fields do; it is removed below.
      if (name?.startsWith(`${scope}.`) && edited[name.slice(scope.length + 1)] === undefined) {
        form.setValue(name, null as never)
        return
      }
      const patch: Record<string, unknown> = {}
      for (const child of latest.current.fields) {
        const next = edited[child.key]
        // An emptied optional field is removed from the item (see `merge`).
        patch[child.key] = !child.required && (next === '' || next === null) ? undefined : next
      }
      latest.current.onChange(patch)
    })
    return () => subscription.unsubscribe()
  }, [form, scope])

  return (
    <FormProvider {...form}>
      <div className="gcms-graph-fields">
        {fields.map((child) => (
          <AutoFormField key={child.key} parsedField={child} path={[scope, child.key]} />
        ))}
      </div>
    </FormProvider>
  )
}

function NodeSelect({
  graph,
  value,
  label,
  onChange,
  placeholder,
}: {
  graph: Graph
  value: string
  label: string
  onChange: (id: string) => void
  placeholder?: string
}) {
  const known = graph.nodes.some((node) => node.id === value)
  return (
    <select className="gcms-input" aria-label={label} value={known ? value : ''} onChange={(event) => onChange(event.target.value)}>
      {known ? null : <option value="">{value ? `${value} (missing)` : (placeholder ?? '—')}</option>}
      {graph.nodes.map((node) => (
        <option key={node.id} value={node.id}>
          {nodeName(node)}
        </option>
      ))}
    </select>
  )
}

function EdgeInputs({
  graph,
  edge,
  index,
  directed,
  onChange,
}: {
  graph: Graph
  edge: GraphEdge
  index: number
  directed: boolean
  onChange: (patch: Partial<GraphEdge>) => void
}) {
  const name = `edge ${index + 1}`
  return (
    <div className="gcms-graph-edge-inputs">
      <label className="gcms-graph-panel-field">
        <span className="gcms-label">{directed ? 'From' : 'Between'}</span>
        <NodeSelect graph={graph} value={String(edge.from ?? '')} label={`${directed ? 'From' : 'First end'} of ${name}`} onChange={(from) => onChange({ from })} />
      </label>
      <label className="gcms-graph-panel-field">
        <span className="gcms-label">{directed ? 'To' : 'And'}</span>
        <NodeSelect graph={graph} value={String(edge.to ?? '')} label={`${directed ? 'To' : 'Second end'} of ${name}`} onChange={(to) => onChange({ to })} />
      </label>
      <label className="gcms-graph-panel-field">
        <span className="gcms-label">Label</span>
        <input
          className="gcms-input"
          aria-label={`Label of ${name}`}
          value={String(edge.label ?? '')}
          onChange={(event) => onChange({ label: event.target.value })}
          onKeyDown={(event) => event.key === 'Enter' && event.preventDefault()}
        />
      </label>
    </div>
  )
}

/** Pick a node and add an edge to it: connecting without a pointer. */
function ConnectTo({ graph, from, directed, onConnect }: { graph: Graph; from?: string; directed: boolean; onConnect: (to: string, from?: string) => boolean }) {
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const start = from ?? source
  return (
    <div className="gcms-graph-connect-form">
      {from === undefined ? <NodeSelect graph={graph} value={source} label="New edge from" placeholder="From…" onChange={setSource} /> : null}
      <NodeSelect graph={graph} value={target} label={from === undefined ? 'New edge to' : `Connect ${directed ? 'to' : 'with'}`} placeholder={directed ? 'Connect to…' : 'Connect with…'} onChange={setTarget} />
      <button
        type="button"
        className="gcms-button gcms-button--small"
        disabled={!start || !target}
        onClick={() => {
          if (onConnect(target, start)) setTarget('')
        }}
      >
        Add edge
      </button>
    </div>
  )
}

function GraphList({
  graph,
  directed,
  selection,
  onSelect,
  onLabel,
  onRemoveNode,
  onEdge,
  onRemoveEdge,
  onConnect,
}: {
  graph: Graph
  directed: boolean
  selection: Selection
  onSelect: (selection: Selection) => void
  onLabel: (id: string, label: string) => void
  onRemoveNode: (id: string) => void
  onEdge: (index: number, patch: Partial<GraphEdge>) => void
  onRemoveEdge: (index: number) => void
  onConnect: (from: string, to: string) => boolean
}): ReactNode {
  return (
    <div className="gcms-graph-list">
      <h4 className="gcms-graph-list-heading">Nodes ({graph.nodes.length})</h4>
      {graph.nodes.length === 0 ? <p className="gcms-description">No nodes yet. Use Add node.</p> : null}
      <ol className="gcms-graph-rows gcms-graph-rows--nodes">
        {graph.nodes.map((node, index) => {
          const name = nodeName(node, `node ${index + 1}`)
          return (
            <li key={node.id} className={selection?.type === 'node' && selection.id === node.id ? 'gcms-graph-row--selected' : undefined}>
              <input
                className="gcms-input"
                aria-label={`Label of node ${index + 1}`}
                value={String(node.label ?? '')}
                onChange={(event) => onLabel(node.id, event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && event.preventDefault()}
              />
              <code className="gcms-graph-id">{node.id}</code>
              <button type="button" className="gcms-button gcms-button--small" aria-label={`Edit ${name}`} onClick={() => onSelect({ type: 'node', id: node.id })}>
                Edit
              </button>
              <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" aria-label={`Remove ${name}`} onClick={() => onRemoveNode(node.id)}>
                Remove
              </button>
            </li>
          )
        })}
      </ol>
      <h4 className="gcms-graph-list-heading">Edges ({graph.edges.length})</h4>
      <ol className="gcms-graph-rows gcms-graph-rows--edges">
        {graph.edges.map((edge, index) => (
          <li key={index} className={selection?.type === 'edge' && selection.index === index ? 'gcms-graph-row--selected' : undefined}>
            <EdgeInputs graph={graph} edge={edge} index={index} directed={directed} onChange={(patch) => onEdge(index, patch)} />
            <button type="button" className="gcms-button gcms-button--small" aria-label={`Edit edge ${index + 1}`} onClick={() => onSelect({ type: 'edge', index })}>
              Edit
            </button>
            <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" aria-label={`Remove edge ${index + 1}`} onClick={() => onRemoveEdge(index)}>
              Remove
            </button>
          </li>
        ))}
      </ol>
      {graph.nodes.length > 0 ? <ConnectTo graph={graph} directed={directed} onConnect={(to, from) => onConnect(from!, to)} /> : null}
    </div>
  )
}
