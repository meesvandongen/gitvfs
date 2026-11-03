import { z } from 'zod'
import {
  autoLayout,
  boundaryPoint,
  canConnect,
  edgeOffsets,
  fitGraph,
  graph,
  graphBounds,
  graphIssues,
  kindList,
  nodeAt,
  nodeBox,
  nodeSize,
  routeEdge,
  snap,
  toGraph,
  toMermaid,
  uniqueId,
  type Graph,
  type GraphNode,
} from '../src'
import { fromScreen, toScreen, zoomView } from '../src/graph'

const node = (id: string, x = 0, y = 0, extra: Partial<GraphNode> = {}): GraphNode => ({ id, label: id.toUpperCase(), x, y, ...extra })

const chain: Graph = {
  nodes: [node('a'), node('b'), node('c')],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ],
}

function messages(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value)
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
}

describe('graph schema', () => {
  it('accepts a valid graph and keeps options for the editor', () => {
    const schema = graph({ label: 'Flow', directed: false, grid: 10, nodeFields: { note: z.string().optional() } })
    expect(schema.parse({ ...chain, nodes: [...chain.nodes.slice(0, 2), node('c', 0, 0, { note: 'x' })] })).toEqual({
      ...chain,
      nodes: [...chain.nodes.slice(0, 2), node('c', 0, 0, { note: 'x' })],
    })
    // Edges default to an empty list.
    expect(schema.parse({ nodes: [node('a')] })).toEqual({ nodes: [node('a')], edges: [] })
  })

  it('keeps keys that are not declared on nodes and edges', () => {
    const value = { nodes: [node('a', 0, 0, { color: 'red' }), node('b')], edges: [{ from: 'a', to: 'b', weight: 2 }] }
    expect(graph().parse(value)).toEqual(value)
  })

  it('reports structural problems on the item they belong to', () => {
    const bad = {
      nodes: [node('a'), node('a'), node('b', 1.5)],
      edges: [
        { from: 'a', to: 'ghost' },
        { from: 'b', to: 'b' },
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b', label: 'again' },
      ],
    }
    expect(messages(graph(), bad)).toEqual([
      'nodes.2.x: Positions are whole numbers',
    ])
    const positioned = { ...bad, nodes: [node('a'), node('a'), node('b')] }
    expect(messages(graph(), positioned)).toEqual([
      'nodes.1.id: Another node already uses the id “a”',
      'edges.0.to: No node has the id “ghost”',
      'edges.1.to: An edge cannot connect a node to itself',
      'edges.3: “a” and “b” are already connected',
    ])
    expect(messages(graph({ allowSelfLoops: true, allowMultiEdges: true }), positioned)).toEqual([
      'nodes.1.id: Another node already uses the id “a”',
      'edges.0.to: No node has the id “ghost”',
    ])
  })

  it('validates ids, labels and node counts', () => {
    expect(messages(graph({ minNodes: 2, maxNodes: 3 }), { nodes: [{ id: 'a b', label: ' ', x: 0, y: 0 }], edges: [] })).toEqual([
      'nodes.0.id: Use only letters, digits, - and _ in node ids',
      'nodes.0.label: Give every node a label',
      'nodes: Add at least 2 nodes',
    ])
  })

  it('treats a → b and b → a as the same edge in undirected graphs', () => {
    const value = { nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }
    expect(graphIssues(value)).toEqual([])
    expect(graphIssues(value, { directed: false })).toEqual([{ path: ['edges', 1], message: '“b” and “a” are already connected' }])
    expect(canConnect(value, 'a', 'b')).toBe('These nodes are already connected')
    expect(canConnect(chain, 'c', 'a')).toBe(true)
    expect(canConnect(chain, 'a', 'a')).toBe('An edge cannot connect a node to itself')
    expect(canConnect(chain, 'a', 'a', { allowSelfLoops: true })).toBe(true)
  })

  it('adds a kind to nodes when kinds are given', () => {
    const schema = graph({ nodeKinds: { question: { shape: 'diamond' }, answer: { label: 'Answer' } } })
    expect(schema.safeParse({ nodes: [node('a', 0, 0, { kind: 'question' })] }).success).toBe(true)
    expect(schema.safeParse({ nodes: [node('a')] }).success).toBe(false)
    expect(schema.safeParse({ nodes: [node('a', 0, 0, { kind: 'other' })] }).success).toBe(false)
    expect(kindList(['a', 'b'])).toEqual([
      { value: 'a', label: 'a', shape: 'rounded' },
      { value: 'b', label: 'b', shape: 'rounded' },
    ])
    expect(kindList({ q: { label: 'Question', shape: 'diamond' } })).toEqual([{ value: 'q', label: 'Question', shape: 'diamond' }])
  })
})

describe('graph helpers', () => {
  it('makes readable, unused ids', () => {
    expect(uniqueId('Reset your password', [])).toBe('reset-your-password')
    expect(uniqueId('Start', ['start', 'start-2'])).toBe('start-3')
    expect(uniqueId('?!', new Set(['node']))).toBe('node-2')
    expect(uniqueId('Café crème', [])).toBe('cafe-creme')
  })

  it('coerces half-edited values', () => {
    expect(toGraph(undefined)).toEqual({ nodes: [], edges: [] })
    expect(toGraph({ nodes: [node('a'), null], edges: 'x' })).toEqual({ nodes: [node('a')], edges: [] })
  })

  it('sizes nodes from their label and shape', () => {
    expect(nodeSize('Hi')).toEqual({ width: 80, height: 40 })
    expect(nodeSize('A rather long label for a node')).toEqual({ width: 242, height: 40 })
    expect(nodeSize('x'.repeat(100)).width).toBe(nodeSize('x'.repeat(40)).width)
    expect(nodeSize('Hi', 'diamond').height).toBe(72)
  })

  it('measures bounds around node boxes', () => {
    expect(graphBounds([])).toBeUndefined()
    expect(graphBounds([node('a', 0, 0), node('b', 100, 200)])).toEqual({ minX: -40, minY: -20, maxX: 140, maxY: 220, width: 180, height: 240 })
  })

  it('fits, pans and zooms the view', () => {
    const size = { width: 600, height: 400 }
    const view = fitGraph(graphBounds([node('a', 0, 0), node('b', 400, 300)]), size)
    expect(view.x).toBe(200)
    expect(view.y).toBe(150)
    expect(toScreen({ x: 200, y: 150 }, view, size)).toEqual({ x: 300, y: 200 })
    expect(fromScreen(toScreen({ x: 17, y: -3 }, view, size), view, size).x).toBeCloseTo(17)
    // A small graph is not blown up.
    expect(fitGraph(graphBounds([node('a')]), size).zoom).toBe(1.25)
    expect(fitGraph(undefined, size)).toEqual({ x: 0, y: 0, zoom: 1 })

    const anchor = { x: 100, y: 50 }
    const before = fromScreen(anchor, view, size)
    const zoomed = zoomView(view, view.zoom * 2, size, anchor)
    expect(fromScreen(anchor, zoomed, size).x).toBeCloseTo(before.x)
    expect(fromScreen(anchor, zoomed, size).y).toBeCloseTo(before.y)
    expect(zoomView(view, 100, size).zoom).toBe(3)
  })

  it('snaps and hit-tests', () => {
    expect(snap(29, 20)).toBe(20)
    expect(snap(31, 20)).toBe(40)
    expect(snap(12.6)).toBe(13)
    const nodes = [node('a', 0, 0), node('b', 30, 0)]
    expect(nodeAt(nodes, { x: 20, y: 5 })?.id).toBe('b')
    expect(nodeAt(nodes, { x: -39, y: 0 })?.id).toBe('a')
    expect(nodeAt(nodes, { x: 0, y: 30 })).toBeUndefined()
  })

  it('finds where lines leave node outlines', () => {
    const rect = { x: 0, y: 0, width: 100, height: 40, shape: 'rect' as const }
    expect(boundaryPoint(rect, { x: 200, y: 0 })).toEqual({ x: 50, y: 0 })
    expect(boundaryPoint(rect, { x: 0, y: -100 })).toEqual({ x: 0, y: -20 })
    const diamond = { ...rect, shape: 'diamond' as const }
    const point = boundaryPoint(diamond, { x: 100, y: 40 })
    expect(Math.abs(point.x) / 50 + Math.abs(point.y) / 20).toBeCloseTo(1)
    const ellipse = { ...rect, shape: 'ellipse' as const }
    const onEllipse = boundaryPoint(ellipse, { x: 30, y: 30 })
    expect((onEllipse.x / 50) ** 2 + (onEllipse.y / 20) ** 2).toBeCloseTo(1)
  })

  it('bends edges between the same nodes apart', () => {
    expect(edgeOffsets(chain.edges)).toEqual([0, 0])
    // a → b and b → a both bend to their own left, which is opposite sides on screen.
    const [ab, ba] = edgeOffsets([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])
    expect(ab).toBe(ba)
    expect(ab).not.toBe(0)
    expect(edgeOffsets([{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }, { from: 'a', to: 'b' }])).toEqual([-36, 0, 36])
    expect(edgeOffsets([{ from: 'a', to: 'a' }, { from: 'a', to: 'a' }])).toEqual([0, 1])

    const a = nodeBox(node('a', 0, 0))
    const b = nodeBox(node('b', 0, 200))
    const there = routeEdge(a, b, ab)
    const back = routeEdge(b, a, ba)
    expect(there.path).toMatch(/^M[\d.,-]+ Q/)
    expect(Math.sign(there.label.x)).toBe(-Math.sign(back.label.x))
    // Their labels grow away from each other.
    expect([there.anchor, back.anchor].sort()).toEqual(['end', 'start'])
    // Straight edges run from outline to outline, with the arrow tip on the target's outline.
    const straight = routeEdge(a, b)
    expect(straight.path).toBe('M0,20 L0,180')
    expect(straight.label).toEqual({ x: 0, y: 100 })
    expect(straight.anchor).toBe('middle')
    expect(straight.arrow.startsWith('0,180 ')).toBe(true)
    expect(routeEdge(a, a, 0).path).toMatch(/^M[\d.,-]+ C/)
  })

  it('exports Mermaid', () => {
    const value: Graph = {
      nodes: [node('start', 0, 0, { label: 'Say "hi"', kind: 'q' }), node('end', 0, 100, { label: 'Done' })],
      edges: [{ from: 'start', to: 'end', label: 'yes' }],
    }
    expect(toMermaid(value, { nodeKinds: { q: { shape: 'diamond' } } })).toBe(
      'flowchart TB\n  start{"Say #quot;hi#quot;"}\n  n_end("Done")\n  start -->|"yes"| n_end\n',
    )
    expect(toMermaid(chain, { directed: false, direction: 'LR' })).toBe('flowchart LR\n  a("A")\n  b("B")\n  c("C")\n  a --- b\n  b --- c\n')
  })
})

describe('autoLayout', () => {
  const positions = (nodes: GraphNode[]) => Object.fromEntries(nodes.map((n) => [n.id, [n.x, n.y]]))

  it('puts a chain in layers from top to bottom, starting at 0,0', () => {
    const laid = autoLayout(chain)
    expect(laid.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(positions(laid)).toEqual({ a: [40, 20], b: [40, 132], c: [40, 244] })
    expect(laid[0].label).toBe('A')
    expect(positions(autoLayout(chain, { direction: 'LR' }))).toEqual({ a: [40, 20], b: [192, 20], c: [344, 20] })
  })

  it('is deterministic and keeps nodes of a layer apart', () => {
    // Listed so that the bottom layer starts out crossed: rl comes before ll.
    const tree: Graph = {
      nodes: ['root', 'l', 'r', 'rl', 'll', 'lr'].map((id) => node(id, 999, 999)),
      edges: [
        { from: 'root', to: 'l' },
        { from: 'root', to: 'r' },
        { from: 'r', to: 'rl' },
        { from: 'l', to: 'll' },
        { from: 'l', to: 'lr' },
      ],
    }
    const laid = autoLayout(tree)
    expect(autoLayout(tree)).toEqual(laid)
    const at = Object.fromEntries(laid.map((n) => [n.id, n]))
    expect(at.l.y).toBe(at.r.y)
    expect(at.ll.y).toBe(at.rl.y)
    expect(at.root.y).toBeLessThan(at.l.y)
    // Children follow their parents' order, so edges do not cross.
    expect(at.l.x).toBeLessThan(at.r.x)
    expect(at.ll.x).toBeLessThan(at.rl.x)
    expect(at.lr.x).toBeLessThan(at.rl.x)
    expect(Math.abs(at.ll.x - at.lr.x)).toBeGreaterThanOrEqual(80 + 40)
  })

  it('handles cycles, self loops, missing nodes and undirected graphs', () => {
    const cyclic: Graph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
        { from: 'b', to: 'b' },
        { from: 'b', to: 'ghost' },
      ],
    }
    expect(autoLayout(cyclic).map((n) => n.y)).toEqual([20, 132, 244])
    const star: Graph = { nodes: [node('hub'), node('a'), node('b')], edges: [{ from: 'a', to: 'hub' }, { from: 'b', to: 'hub' }] }
    const undirected = autoLayout(star, { directed: false })
    expect(undirected[0].y).toBeLessThan(undirected[1].y)
    expect(undirected[1].y).toBe(undirected[2].y)
    expect(autoLayout({ nodes: [], edges: [] })).toEqual([])
  })

  it('snaps to a grid', () => {
    for (const n of autoLayout(chain, { grid: 20 })) {
      expect(n.x % 20).toBe(0)
      expect(n.y % 20).toBe(0)
    }
  })
})
