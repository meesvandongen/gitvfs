import { z } from 'zod'
import { field, type CmsFieldConfig } from './fields.js'
import { slugify } from './slug.js'

// Graph fields store `{ nodes: [{ id, label, x, y }], edges: [{ from, to, label? }] }`. It is the
// nodes-and-edges model of React Flow, Cytoscape and the JSON Graph Format, flattened for files that
// people read and edit by hand: ids are readable slugs, edges point at them with `from`/`to` (as in
// Mermaid's `a --> b`) and have no ids of their own, and positions are whole numbers, so moving a node
// changes two short lines in a diff. Node and edge objects keep keys the schema does not know.

/** A node: a stable `id`, a `label`, and the position of its center. Declared node fields are extra keys. */
export interface GraphNode {
  id: string
  label: string
  x: number
  y: number
  kind?: string
  [key: string]: unknown
}

/** A connection between two node ids. For undirected graphs `from` and `to` are interchangeable. */
export interface GraphEdge {
  from: string
  to: string
  label?: string
  [key: string]: unknown
}

export interface Graph<N extends GraphNode = GraphNode, E extends GraphEdge = GraphEdge> {
  nodes: N[]
  edges: E[]
}

/** Outline of a node on the canvas (and in Mermaid exports). */
export type NodeShape = 'rect' | 'rounded' | 'diamond' | 'ellipse'

/** How nodes of one kind look in the editor. */
export interface NodeKind {
  /** Name shown in the editor. Default: the kind itself. */
  label?: string
  /** Default: `'rounded'`. */
  shape?: NodeShape
}

/** Node kinds as a list of names, or as names mapped to their look. */
export type NodeKinds<K extends string = string> = readonly K[] | { readonly [kind in K]: NodeKind }

/** Direction of auto layout and of Mermaid exports: top to bottom or left to right. */
export type GraphDirection = 'TB' | 'LR'

export interface GraphOptions<K extends string = string> {
  /** Draw arrowheads, and treat `a → b` and `b → a` as different edges. Default: true. */
  directed?: boolean
  /** Adds a required `kind` to every node, edited with a select; kinds can have their own shape. */
  nodeKinds?: NodeKinds<K>
  minNodes?: number
  maxNodes?: number
  /** Allow edges from a node to itself. Default: false. */
  allowSelfLoops?: boolean
  /** Allow more than one edge between the same two nodes (in the same direction). Default: false. */
  allowMultiEdges?: boolean
  /** Grid that dragged nodes snap to, in pixels; 0 turns snapping off. Default: 20. */
  grid?: number
  /** Direction used by Auto layout. Default: `'TB'`. */
  direction?: GraphDirection
  /** Height of the canvas in pixels. Default: 420. */
  height?: number
}

export interface GraphFieldConfig<N extends z.ZodRawShape = {}, E extends z.ZodRawShape = {}, K extends string = never>
  extends Omit<CmsFieldConfig, 'fieldType' | 'customData'>,
    GraphOptions<K> {
  /** Extra node fields, edited in the side panel with the regular inputs: `{ description: z.string().optional() }`. */
  nodeFields?: N
  /** Extra edge fields. Every edge already has an optional `label`. */
  edgeFields?: E
}

/** Where graph fields keep their options in AutoForm's `customData`. */
export interface GraphCustomData {
  graph: GraphOptions
}

const GRAPH_OPTION_KEYS = [
  'directed',
  'nodeKinds',
  'minNodes',
  'maxNodes',
  'allowSelfLoops',
  'allowMultiEdges',
  'grid',
  'direction',
  'height',
] as const

/** Ids are used in edges, in links from other content and in Mermaid exports, so keep them plain. */
export const NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

type BaseNodeShape = { id: z.ZodString; label: z.ZodString; x: z.ZodNumber; y: z.ZodNumber }
type KindShape<K extends string> = [K] extends [never] ? {} : { kind: z.ZodEnum<{ [kind in K]: kind }> }
type BaseEdgeShape = { from: z.ZodString; to: z.ZodString; label: z.ZodOptional<z.ZodString> }

/**
 * A node-and-edge diagram, such as a decision tree or a workflow, edited on a canvas (with a list view
 * for keyboard and screen reader users): `{ nodes: [{ id, label, x, y, ... }], edges: [{ from, to, label?, ... }] }`.
 *
 * ```ts
 * flow: graph({
 *   label: 'Flow',
 *   nodeKinds: { question: { shape: 'diamond' }, answer: { shape: 'rounded' } },
 *   nodeFields: { details: z.string().optional() },
 * })
 * ```
 */
export function graph<N extends z.ZodRawShape = {}, E extends z.ZodRawShape = {}, K extends string = never>(
  config: GraphFieldConfig<N, E, K> = {},
) {
  const { nodeFields, edgeFields, ...rest } = config
  const fieldConfig: Record<string, unknown> = {}
  const options: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if ((GRAPH_OPTION_KEYS as readonly string[]).includes(key)) options[key] = value
    else fieldConfig[key] = value
  }
  const kinds = kindList(config.nodeKinds).map((kind) => kind.value)

  // Loose objects: keys added by hand (a color, a link) survive saving from the editor.
  const node = z.looseObject({
    id: z.string().regex(NODE_ID_PATTERN, 'Use only letters, digits, - and _ in node ids'),
    label: z.string().trim().min(1, 'Give every node a label'),
    x: z.number().int('Positions are whole numbers'),
    y: z.number().int('Positions are whole numbers'),
    ...(kinds.length > 0 ? { kind: z.enum(kinds as [string, ...string[]]) } : {}),
    ...nodeFields,
  }) as unknown as z.ZodObject<BaseNodeShape & KindShape<K> & N, z.core.$loose>
  const edge = z.looseObject({
    from: z.string().min(1, 'Choose where the edge starts'),
    to: z.string().min(1, 'Choose where the edge ends'),
    label: z.string().optional(),
    ...edgeFields,
  }) as unknown as z.ZodObject<BaseEdgeShape & E, z.core.$loose>

  let nodes = z.array(node)
  if (config.minNodes !== undefined) nodes = nodes.min(config.minNodes, `Add at least ${config.minNodes} node${config.minNodes === 1 ? '' : 's'}`)
  if (config.maxNodes !== undefined) nodes = nodes.max(config.maxNodes, `Use at most ${config.maxNodes} nodes`)

  return z
    .object({ nodes, edges: z.array(edge).default([]) })
    .superRefine((value, ctx) => {
      for (const issue of graphIssues(value as Graph, options as GraphOptions)) ctx.addIssue({ code: 'custom', ...issue })
    })
    .check(field({ ...(fieldConfig as CmsFieldConfig), fieldType: 'graph', customData: { graph: options } satisfies GraphCustomData }))
}

// --- Validation ----------------------------------------------------------------------------------

export interface GraphIssue {
  path: Array<string | number>
  message: string
}

/** Key of an edge's end points; `a|b` and `b|a` are the same pair in an undirected graph. */
export function edgeKey(edge: Pick<GraphEdge, 'from' | 'to'>, directed = true): string {
  const ends = [edge.from, edge.to]
  if (!directed) ends.sort()
  return JSON.stringify(ends)
}

/**
 * What is wrong with a graph's structure: duplicate node ids, edges to nodes that do not exist, and
 * self loops or repeated edges unless the options allow them. Paths are relative to the graph.
 */
export function graphIssues(graph: Graph, options: GraphOptions = {}): GraphIssue[] {
  const issues: GraphIssue[] = []
  const ids = new Set<string>()
  graph.nodes.forEach((node, index) => {
    if (ids.has(node.id)) issues.push({ path: ['nodes', index, 'id'], message: `Another node already uses the id “${node.id}”` })
    ids.add(node.id)
  })
  const directed = options.directed ?? true
  const seen = new Set<string>()
  graph.edges.forEach((edge, index) => {
    if (!ids.has(edge.from)) issues.push({ path: ['edges', index, 'from'], message: `No node has the id “${edge.from}”` })
    if (!ids.has(edge.to)) issues.push({ path: ['edges', index, 'to'], message: `No node has the id “${edge.to}”` })
    if (edge.from === edge.to && !options.allowSelfLoops) {
      issues.push({ path: ['edges', index, 'to'], message: 'An edge cannot connect a node to itself' })
    }
    const key = edgeKey(edge, directed)
    if (seen.has(key) && !options.allowMultiEdges) {
      issues.push({ path: ['edges', index], message: `“${edge.from}” and “${edge.to}” are already connected` })
    }
    seen.add(key)
  })
  return issues
}

/** Whether an edge `from → to` may be added to `graph`; returns the reason when it may not. */
export function canConnect(graph: Graph, from: string, to: string, options: GraphOptions = {}): true | string {
  if (from === to && !options.allowSelfLoops) return 'An edge cannot connect a node to itself'
  const key = edgeKey({ from, to }, options.directed ?? true)
  if (!options.allowMultiEdges && graph.edges.some((edge) => edgeKey(edge, options.directed ?? true) === key)) {
    return 'These nodes are already connected'
  }
  return true
}

/**
 * A readable id for a new node: the slug of its label (`node` for labels without letters or digits),
 * with `-2`, `-3`, ... added when `taken` already has it.
 */
export function uniqueId(label: string, taken: Iterable<string>): string {
  const used = taken instanceof Set ? (taken as Set<string>) : new Set(taken)
  const base = slugify(label) || 'node'
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix++
  return `${base}-${suffix}`
}

/** The kinds of a `nodeKinds` option, in order, with their name and shape filled in. */
export function kindList(kinds: NodeKinds | undefined): Array<{ value: string; label: string; shape: NodeShape }> {
  if (!kinds) return []
  const entries: Array<[string, NodeKind]> = Array.isArray(kinds)
    ? (kinds as readonly string[]).map((kind) => [kind, {}])
    : Object.entries(kinds as Record<string, NodeKind>)
  return entries.map(([value, kind]) => ({ value, label: kind.label ?? value, shape: kind.shape ?? 'rounded' }))
}

/** The shape a node is drawn with. */
export function shapeOf(node: Pick<GraphNode, 'kind'>, kinds?: NodeKinds): NodeShape {
  if (!kinds || node.kind === undefined) return 'rounded'
  return kindList(kinds).find((kind) => kind.value === node.kind)?.shape ?? 'rounded'
}

/** Coerce a stored or half-edited value into arrays the editor can work with. */
export function toGraph(value: unknown): Graph {
  const record = (value ?? {}) as Partial<Graph>
  return {
    nodes: Array.isArray(record.nodes) ? record.nodes.filter((node) => node && typeof node === 'object') : [],
    edges: Array.isArray(record.edges) ? record.edges.filter((edge) => edge && typeof edge === 'object') : [],
  }
}

// --- Geometry ------------------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** A node as drawn: its center, size and shape. */
export interface NodeBox extends Point, Size {
  shape: NodeShape
}

/** Average width of a character of a node label, in pixels. Labels are measured without a DOM. */
const CHAR_WIDTH = 7
/** Labels longer than this are cut off on the canvas (the full label is in the tooltip and panel). */
export const MAX_LABEL_CHARS = 32

/** Size of a node on the canvas, from its label and shape. Estimated, so it is the same everywhere. */
export function nodeSize(label: string, shape: NodeShape = 'rounded'): Size {
  const text = Math.min(Array.from(label).length, MAX_LABEL_CHARS) * CHAR_WIDTH
  if (shape === 'diamond') return { width: Math.round(Math.max(120, text * 1.4 + 40)), height: 72 }
  if (shape === 'ellipse') return { width: Math.round(Math.max(96, text * 1.15 + 40)), height: 48 }
  return { width: Math.round(Math.max(80, text + 32)), height: 40 }
}

/** The drawn box of a node. */
export function nodeBox(node: GraphNode, kinds?: NodeKinds): NodeBox {
  const shape = shapeOf(node, kinds)
  return { x: node.x, y: node.y, shape, ...nodeSize(String(node.label ?? ''), shape) }
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

/** The rectangle around all nodes (including their size), or `undefined` for a graph without nodes. */
export function graphBounds(nodes: readonly GraphNode[], kinds?: NodeKinds): Bounds | undefined {
  if (nodes.length === 0) return undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const box = nodeBox(node, kinds)
    minX = Math.min(minX, box.x - box.width / 2)
    minY = Math.min(minY, box.y - box.height / 2)
    maxX = Math.max(maxX, box.x + box.width / 2)
    maxY = Math.max(maxY, box.y + box.height / 2)
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

/**
 * Pan and zoom of the canvas: the graph point `(x, y)` is in the middle of the canvas, and one graph
 * pixel is `zoom` screen pixels. Keeping the middle (not a corner) keeps the graph centered on resize.
 */
export interface GraphView extends Point {
  zoom: number
}

export const MIN_GRAPH_ZOOM = 0.2
export const MAX_GRAPH_ZOOM = 3

/** The view that shows all of `bounds` in a canvas of `size`, with `padding` pixels around it. */
export function fitGraph(bounds: Bounds | undefined, size: Size, padding = 40, maxZoom = 1.25): GraphView {
  if (!bounds) return { x: 0, y: 0, zoom: 1 }
  const zoom = Math.max(
    MIN_GRAPH_ZOOM,
    Math.min(maxZoom, (size.width - padding * 2) / Math.max(bounds.width, 1), (size.height - padding * 2) / Math.max(bounds.height, 1)),
  )
  return { x: bounds.minX + bounds.width / 2, y: bounds.minY + bounds.height / 2, zoom }
}

/** Screen position (relative to the canvas) of a graph point. */
export function toScreen(point: Point, view: GraphView, size: Size): Point {
  return { x: (point.x - view.x) * view.zoom + size.width / 2, y: (point.y - view.y) * view.zoom + size.height / 2 }
}

/** Graph point at a screen position (relative to the canvas). */
export function fromScreen(point: Point, view: GraphView, size: Size): Point {
  return { x: (point.x - size.width / 2) / view.zoom + view.x, y: (point.y - size.height / 2) / view.zoom + view.y }
}

/** Zoom to `zoom` while keeping the graph point under `anchor` (a screen position) in place. */
export function zoomView(view: GraphView, zoom: number, size: Size, anchor: Point = { x: size.width / 2, y: size.height / 2 }): GraphView {
  const next = Math.min(MAX_GRAPH_ZOOM, Math.max(MIN_GRAPH_ZOOM, zoom))
  const fixed = fromScreen(anchor, view, size)
  return { x: fixed.x - (anchor.x - size.width / 2) / next, y: fixed.y - (anchor.y - size.height / 2) / next, zoom: next }
}

/** Round to the grid, or to whole pixels when `grid` is 0. */
export function snap(value: number, grid = 0): number {
  return grid > 0 ? Math.round(value / grid) * grid : Math.round(value)
}

/** The topmost node whose box contains `point`. */
export function nodeAt(nodes: readonly GraphNode[], point: Point, kinds?: NodeKinds): GraphNode | undefined {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const box = nodeBox(nodes[index], kinds)
    if (Math.abs(point.x - box.x) <= box.width / 2 && Math.abs(point.y - box.y) <= box.height / 2) return nodes[index]
  }
  return undefined
}

/** A spot near `point` that no node occupies, stepping down until one is free; for new nodes. */
export function freeSpot(nodes: readonly GraphNode[], point: Point, step = 60): Point {
  let spot = point
  for (let tries = 0; tries < 50 && nodes.some((node) => Math.abs(node.x - spot.x) < 40 && Math.abs(node.y - spot.y) < 30); tries++) {
    spot = { x: spot.x, y: spot.y + step }
  }
  return spot
}

/** Where the line from the center of `box` towards `toward` leaves its outline. */
export function boundaryPoint(box: NodeBox, toward: Point): Point {
  const dx = toward.x - box.x
  const dy = toward.y - box.y
  if (dx === 0 && dy === 0) return { x: box.x, y: box.y }
  const rx = box.width / 2
  const ry = box.height / 2
  const scale =
    box.shape === 'diamond'
      ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
      : box.shape === 'ellipse'
        ? 1 / Math.hypot(dx / rx, dy / ry)
        : 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry)
  return { x: box.x + dx * scale, y: box.y + dy * scale }
}

/** Spacing between parallel edges of one pair of nodes, in pixels. */
export const EDGE_SPACING = 36

/**
 * Sideways offset of every edge, so edges between the same two nodes (`a → b` and `b → a`, or
 * repeated edges) bend apart instead of overlapping. A lone edge is straight (0). Positive offsets
 * bend to the left of the edge's direction.
 */
export function edgeOffsets(edges: readonly GraphEdge[]): number[] {
  const groups = new Map<string, number[]>()
  edges.forEach((edge, index) => {
    const key = edgeKey(edge, false)
    groups.set(key, [...(groups.get(key) ?? []), index])
  })
  const offsets = edges.map(() => 0)
  for (const members of groups.values()) {
    const loop = edges[members[0]].from === edges[members[0]].to
    members.forEach((edgeIndex, position) => {
      if (loop) {
        offsets[edgeIndex] = position
        return
      }
      if (members.length === 1) return
      // Offsets are spread around 0 in the direction of the pair's first id, then turned into the
      // edge's own direction, so `a → b` and `b → a` end up on opposite sides.
      const offset = (position - (members.length - 1) / 2) * EDGE_SPACING
      const edge = edges[edgeIndex]
      offsets[edgeIndex] = edge.from <= edge.to ? offset : -offset
    })
  }
  return offsets
}

export interface EdgeRoute {
  /** SVG path data. */
  path: string
  /** Where the label goes: the middle of the drawn line, a little outside a curve. */
  label: Point
  /**
   * How the label text aligns at `label` (SVG `text-anchor`). Labels of curves grow away from the
   * curve, so the labels of `a → b` and `b → a` do not run into each other.
   */
  anchor: 'start' | 'middle' | 'end'
  /** Arrowhead polygon (`points` attribute) at the end. */
  arrow: string
}

const ARROW_LENGTH = 10
const ARROW_WIDTH = 5

function arrowAt(tip: Point, from: Point): string {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1
  const ux = (tip.x - from.x) / length
  const uy = (tip.y - from.y) / length
  const base = { x: tip.x - ux * ARROW_LENGTH, y: tip.y - uy * ARROW_LENGTH }
  const corner = (side: number) => `${round2(base.x - uy * ARROW_WIDTH * side)},${round2(base.y + ux * ARROW_WIDTH * side)}`
  return `${round2(tip.x)},${round2(tip.y)} ${corner(1)} ${corner(-1)}`
}

const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * The line of an edge between two node boxes: straight for offset 0, otherwise a curve bent
 * `offset` pixels to the side. It starts and ends on the node outlines, so arrowheads stay visible.
 */
export function routeEdge(from: NodeBox, to: NodeBox, offset = 0): EdgeRoute {
  if (from.x === to.x && from.y === to.y && from.width === to.width) return routeLoop(from, offset)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  // Normal pointing to the left of the direction of travel (y grows downwards on screen).
  const normal = { x: dy / length, y: -dx / length }
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  // A quadratic curve passes halfway to its control point, so the control is twice the offset away.
  const control = { x: middle.x + normal.x * offset * 2, y: middle.y + normal.y * offset * 2 }
  const start = boundaryPoint(from, offset ? control : to)
  const end = boundaryPoint(to, offset ? control : from)
  if (!offset) {
    return {
      path: `M${round2(start.x)},${round2(start.y)} L${round2(end.x)},${round2(end.y)}`,
      label: { x: round2((start.x + end.x) / 2), y: round2((start.y + end.y) / 2) },
      anchor: 'middle',
      arrow: arrowAt(end, start),
    }
  }
  // The side of the line the curve bulges to, and the label's distance from the curve.
  const outward = { x: normal.x * Math.sign(offset), y: normal.y * Math.sign(offset) }
  const sideways = Math.abs(outward.x) >= 0.5
  const gap = sideways ? 6 : 10
  return {
    path: `M${round2(start.x)},${round2(start.y)} Q${round2(control.x)},${round2(control.y)} ${round2(end.x)},${round2(end.y)}`,
    label: {
      x: round2(0.25 * start.x + 0.5 * control.x + 0.25 * end.x + outward.x * gap),
      y: round2(0.25 * start.y + 0.5 * control.y + 0.25 * end.y + outward.y * gap),
    },
    anchor: sideways ? (outward.x > 0 ? 'start' : 'end') : 'middle',
    arrow: arrowAt(end, control),
  }
}

/** An edge from a node to itself: a loop over its top right corner, larger for each further loop. */
function routeLoop(box: NodeBox, index: number): EdgeRoute {
  const size = 28 + index * 16
  const start = { x: box.x + box.width / 4, y: box.y - box.height / 2 }
  const end = { x: box.x + box.width / 2, y: box.y - box.height / 4 }
  if (box.shape === 'diamond' || box.shape === 'ellipse') {
    Object.assign(start, boundaryPoint(box, { x: box.x + box.width / 8, y: box.y - box.height }))
    Object.assign(end, boundaryPoint(box, { x: box.x + box.width, y: box.y - box.height / 8 }))
  }
  const c1 = { x: start.x, y: start.y - size }
  const c2 = { x: end.x + size, y: end.y }
  return {
    path: `M${round2(start.x)},${round2(start.y)} C${round2(c1.x)},${round2(c1.y)} ${round2(c2.x)},${round2(c2.y)} ${round2(end.x)},${round2(end.y)}`,
    label: { x: round2(end.x + size * 0.6), y: round2(start.y - size * 0.6) },
    anchor: 'start',
    arrow: arrowAt(end, c2),
  }
}

// --- Layout --------------------------------------------------------------------------------------

export interface LayoutOptions {
  /** Default: `'TB'`, top to bottom. */
  direction?: GraphDirection
  /** Follow edge directions when ranking nodes; undirected graphs are ranked by distance. Default: true. */
  directed?: boolean
  nodeKinds?: NodeKinds
  /** Space between nodes of one layer. Default: 40. */
  nodeGap?: number
  /** Space between layers. Default: 72. */
  layerGap?: number
  /** Round positions to this grid. Default: 0 (whole pixels). */
  grid?: number
}

/**
 * Arrange nodes in layers (a simplified Sugiyama layout): rank nodes so edges point down (or right),
 * ignoring the edges that close a cycle, order each layer by the average position of its neighbors
 * to reduce crossings, then place nodes under their parents. Deterministic: the same graph gives the
 * same layout.
 * Returns the nodes, in their original order, with new positions; the top-left node box is at 0,0.
 */
export function autoLayout<N extends GraphNode>(graph: Graph<N>, options: LayoutOptions = {}): N[] {
  const { nodes } = graph
  if (nodes.length === 0) return []
  const directed = options.directed ?? true
  const horizontal = options.direction === 'LR'
  const nodeGap = options.nodeGap ?? 40
  const layerGap = options.layerGap ?? 72
  const indexOf = new Map<string, number>()
  nodes.forEach((node, index) => {
    if (!indexOf.has(node.id)) indexOf.set(node.id, index)
  })
  const links: Array<[number, number]> = []
  for (const edge of graph.edges) {
    const from = indexOf.get(edge.from)
    const to = indexOf.get(edge.to)
    if (from !== undefined && to !== undefined && from !== to) links.push([from, to])
  }

  const rank = directed ? rankDirected(nodes.length, links) : rankByDistance(nodes.length, links)
  const layerCount = Math.max(...rank) + 1
  const layers: number[][] = Array.from({ length: layerCount }, () => [])
  nodes.forEach((_, index) => layers[rank[index]].push(index))

  // Neighbors in adjacent layers, whichever way the edge points.
  const neighbors = nodes.map(() => [] as number[])
  for (const [from, to] of links) {
    if (Math.abs(rank[from] - rank[to]) !== 1) continue
    neighbors[from].push(to)
    neighbors[to].push(from)
  }
  const position = Array.from({ length: nodes.length }, () => 0)
  const renumber = (layer: number[]) => layer.forEach((node, at) => (position[node] = at))
  layers.forEach(renumber)
  for (let sweep = 0; sweep < 8; sweep++) {
    const down = sweep % 2 === 0
    for (let step = 1; step < layerCount; step++) {
      const layerIndex = down ? step : layerCount - 1 - step
      const reference = down ? layerIndex - 1 : layerIndex + 1
      const layer = layers[layerIndex]
      const key = (node: number) => {
        const around = neighbors[node].filter((other) => rank[other] === reference)
        return around.length === 0 ? position[node] : around.reduce((sum, other) => sum + position[other], 0) / around.length
      }
      const keys = new Map(layer.map((node) => [node, key(node)]))
      layer.sort((a, b) => keys.get(a)! - keys.get(b)! || position[a] - position[b])
      renumber(layer)
    }
  }

  const sizes = nodes.map((node) => nodeBox(node, options.nodeKinds))
  const along = (size: Size) => (horizontal ? size.height : size.width)
  const across = (size: Size) => (horizontal ? size.width : size.height)
  const centers = nodes.map(() => ({ main: 0, cross: 0 }))
  let layerStart = 0
  layers.forEach((layer, layerIndex) => {
    const thickness = Math.max(...layer.map((node) => across(sizes[node])))
    // Each node aims for the middle of its neighbors in the layer above; nodes are then pushed apart
    // left to right, and the layer is shifted back so it is off by as little as possible on average.
    const wanted = layer.map((node) => {
      const above = neighbors[node].filter((other) => rank[other] === layerIndex - 1)
      return above.length === 0 ? undefined : above.reduce((sum, other) => sum + centers[other].main, 0) / above.length
    })
    let right = -Infinity
    const main = layer.map((node, at) => {
      const half = along(sizes[node]) / 2
      const earliest = right + nodeGap + half
      const center = wanted[at] === undefined ? (Number.isFinite(earliest) ? earliest : half) : Math.max(wanted[at]!, earliest)
      right = center + half
      return center
    })
    const anchored = wanted.flatMap((target, at) => (target === undefined ? [] : [target - main[at]]))
    // A layer with no neighbors above (the first one) is centered on 0.
    const shift = anchored.length > 0
      ? anchored.reduce((sum, offset) => sum + offset, 0) / anchored.length
      : -(main[0] - along(sizes[layer[0]]) / 2 + right) / 2
    layer.forEach((node, at) => (centers[node] = { main: main[at] + shift, cross: layerStart + thickness / 2 }))
    layerStart += thickness + layerGap
  })

  const minMain = Math.min(...nodes.map((_, index) => centers[index].main - along(sizes[index]) / 2))
  return nodes.map((node, index) => {
    const main = centers[index].main - minMain
    const cross = centers[index].cross
    return { ...node, x: snap(horizontal ? cross : main, options.grid), y: snap(horizontal ? main : cross, options.grid) }
  })
}

/** Longest-path ranks after dropping the edges that close cycles (found depth first, in node order). */
function rankDirected(count: number, links: ReadonlyArray<[number, number]>): number[] {
  const outgoing = Array.from({ length: count }, () => [] as number[])
  for (const [from, to] of links) outgoing[from].push(to)
  const state = Array.from({ length: count }, (): 0 | 1 | 2 => 0)
  const back = new Set<string>()
  for (let root = 0; root < count; root++) {
    if (state[root]) continue
    // Iterative DFS, so long chains cannot overflow the stack.
    const stack: Array<[number, number]> = [[root, 0]]
    state[root] = 1
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const [node, next] = top
      if (next >= outgoing[node].length) {
        state[node] = 2
        stack.pop()
        continue
      }
      top[1]++
      const target = outgoing[node][next]
      if (state[target] === 1) back.add(`${node}>${target}`)
      else if (state[target] === 0) {
        state[target] = 1
        stack.push([target, 0])
      }
    }
  }
  const forward = links.filter(([from, to]) => !back.has(`${from}>${to}`))
  const incoming = Array.from({ length: count }, () => 0)
  const next = Array.from({ length: count }, () => [] as number[])
  for (const [from, to] of forward) {
    incoming[to]++
    next[from].push(to)
  }
  const rank = Array.from({ length: count }, () => 0)
  const queue = rank.map((_, index) => index).filter((index) => incoming[index] === 0)
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]
    for (const target of next[node]) {
      rank[target] = Math.max(rank[target], rank[node] + 1)
      if (--incoming[target] === 0) queue.push(target)
    }
  }
  return rank
}

/** Breadth-first distance from the first node of each connected part. */
function rankByDistance(count: number, links: ReadonlyArray<[number, number]>): number[] {
  const adjacent = Array.from({ length: count }, () => [] as number[])
  for (const [a, b] of links) {
    adjacent[a].push(b)
    adjacent[b].push(a)
  }
  const rank = Array.from({ length: count }, () => -1)
  for (let root = 0; root < count; root++) {
    if (rank[root] >= 0) continue
    rank[root] = 0
    const queue = [root]
    for (let head = 0; head < queue.length; head++) {
      for (const other of adjacent[queue[head]]) {
        if (rank[other] < 0) {
          rank[other] = rank[queue[head]] + 1
          queue.push(other)
        }
      }
    }
  }
  return rank
}

// --- Export --------------------------------------------------------------------------------------

export interface MermaidOptions {
  direction?: GraphDirection
  /** Default: true. Undirected graphs use `---` lines. */
  directed?: boolean
  /** For node shapes. */
  nodeKinds?: NodeKinds
}

const MERMAID_SHAPES: Record<NodeShape, [string, string]> = {
  rect: ['[', ']'],
  rounded: ['(', ')'],
  diamond: ['{', '}'],
  ellipse: ['([', '])'],
}

/** Mermaid ids are words, and a node called `end` closes a subgraph. */
function mermaidId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_]/g, '_')
  return /^(end|graph|subgraph|flowchart)$/.test(safe) ? `n_${safe}` : safe
}

const mermaidText = (text: string) => `"${text.replace(/"/g, '#quot;').replace(/\s*\n\s*/g, ' ')}"`

/**
 * The graph as a Mermaid flowchart, for docs sites and READMEs that render Mermaid:
 * `flowchart TB` with one line per node (`start("Start")`) and per edge (`start -->|"yes"| done`).
 */
export function toMermaid(graph: Graph, options: MermaidOptions = {}): string {
  const arrow = options.directed === false ? '---' : '-->'
  const lines = [`flowchart ${options.direction ?? 'TB'}`]
  for (const node of graph.nodes) {
    const [open, close] = MERMAID_SHAPES[shapeOf(node, options.nodeKinds)]
    lines.push(`  ${mermaidId(node.id)}${open}${mermaidText(String(node.label ?? node.id))}${close}`)
  }
  for (const edge of graph.edges) {
    const label = edge.label ? `|${mermaidText(edge.label)}|` : ''
    lines.push(`  ${mermaidId(edge.from)} ${arrow}${label} ${mermaidId(edge.to)}`)
  }
  return `${lines.join('\n')}\n`
}
