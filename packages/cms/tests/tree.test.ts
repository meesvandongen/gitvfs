import { z } from 'zod'
import { ZodProvider } from '@autoform/zod'
import {
  countDescendants,
  flattenTree,
  getNode,
  indentNode,
  insertNode,
  moveDown,
  moveNode,
  moveUp,
  nodeHeight,
  outdentNode,
  remapPath,
  removeNode,
  serializeDocument,
  tree,
  updateNode,
} from '../src'

type Item = { label: string; children?: Item[] }

const item = (label: string, ...children: Item[]): Item => (children.length > 0 ? { label, children } : { label })

// Home
// Docs
//   Guides
//     Install
//   API
// Blog
const menu: Item[] = [item('Home'), item('Docs', item('Guides', item('Install')), item('API')), item('Blog')]

/** The tree as indented labels, for readable expectations. */
const outline = (nodes: Item[]) => flattenTree(nodes).map(({ node, level }) => `${'  '.repeat(level - 1)}${node.label}`)

describe('tree schema', () => {
  const schema = z.object({
    menu: tree({ label: 'Menu', fields: { label: z.string().min(1), href: z.string().optional() }, maxDepth: 3 }).default([]),
  })

  it('validates nested nodes and drops empty child lists', () => {
    const result = schema.parse({ menu: [{ label: 'Docs', href: '/docs', children: [{ label: 'API', children: [] }] }, { label: 'Blog', children: [] }] })
    expect(result.menu).toEqual([{ label: 'Docs', href: '/docs', children: [{ label: 'API' }] }, { label: 'Blog' }])
    expect(serializeDocument('yaml', { data: result, body: '' })).toBe(
      'menu:\n  - label: Docs\n    href: /docs\n    children:\n      - label: API\n  - label: Blog\n',
    )
    const failure = schema.safeParse({ menu: [{ label: 'Docs', children: [{ label: '' }] }] })
    expect(failure.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['menu.0.children.0.label'])
  })

  it('enforces maxDepth with the path of the node that is too deep', () => {
    const tooDeep = [{ label: 'A', children: [{ label: 'B', children: [{ label: 'C', children: [{ label: 'D' }] }] }] }]
    const failure = schema.safeParse({ menu: tooDeep })
    expect(failure.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['menu.0.children.0.children.0.children.0', 'Nest at most 3 levels deep'],
    ])
  })

  it('is parsed by AutoForm without recursing forever, and to JSON Schema', () => {
    const fields = new ZodProvider(schema).parseSchema().fields
    expect(fields[0].type).toBe('tree')
    expect(fields[0].fieldConfig?.customData).toEqual({ tree: { childrenKey: 'children', maxDepth: 3, labelField: undefined } })
    expect(fields[0].schema?.[0].schema?.map((field) => field.key)).toEqual(['label', 'href', 'children'])
    expect(JSON.stringify(z.toJSONSchema(schema))).toContain('"$ref"')
  })

  it('supports another children key and rejects clashes', () => {
    const pages = tree({ fields: { title: z.string() }, childrenKey: 'pages' })
    expect(pages.parse([{ title: 'A', pages: [{ title: 'B', pages: [] }] }])).toEqual([{ title: 'A', pages: [{ title: 'B' }] }])
    expect(() => tree({ fields: { children: z.string() } })).toThrow(/children key/)
    expect(() => tree({ fields: {}, maxDepth: 0 })).toThrow(/maxDepth/)
  })
})

describe('tree helpers', () => {
  it('flattens with levels, skipping collapsed nodes', () => {
    expect(outline(menu)).toEqual(['Home', 'Docs', '  Guides', '    Install', '  API', 'Blog'])
    const rows = flattenTree(menu, { isCollapsed: (path) => path.join('.') === '1.0' })
    expect(rows.map((row) => row.path.join('.'))).toEqual(['0', '1', '1.0', '1.1', '2'])
    expect(rows[2]).toMatchObject({ level: 2, index: 0, setSize: 2, hasChildren: true })
  })

  it('reads nodes and measures subtrees', () => {
    expect(getNode(menu, [1, 0, 0])?.label).toBe('Install')
    expect(getNode(menu, [1, 5])).toBeUndefined()
    expect(nodeHeight(menu[1])).toBe(3)
    expect(nodeHeight(menu[0])).toBe(1)
    expect(countDescendants(menu[1])).toBe(3)
  })

  it('updates, inserts and removes without mutating', () => {
    const before = JSON.stringify(menu)
    const updated = updateNode(menu, [1, 1], (node) => ({ ...node, label: 'Reference' }))
    expect(outline(updated)).toContain('  Reference')
    expect(updated[0]).toBe(menu[0])

    const inserted = insertNode(menu, [0], 0, item('Welcome'))!
    expect(inserted.to).toEqual([0, 0])
    expect(outline(inserted.nodes).slice(0, 2)).toEqual(['Home', '  Welcome'])

    // Removing the last child drops the child list.
    const removed = removeNode(menu, [1, 0, 0])
    expect(getNode(removed.nodes, [1, 0])).toEqual({ label: 'Guides' })
    expect(JSON.stringify(menu)).toBe(before)
  })

  it('moves up and down among siblings', () => {
    expect(moveUp(menu, [0])).toBeUndefined()
    expect(moveDown(menu, [2])).toBeUndefined()
    const down = moveDown(menu, [0])!
    expect(down.to).toEqual([1])
    expect(outline(down.nodes)[0]).toBe('Docs')
    expect(outline(down.nodes)[4]).toBe('Home')
    const up = moveUp(menu, [1, 1])!
    expect(up.to).toEqual([1, 0])
    expect(outline(up.nodes)).toEqual(['Home', 'Docs', '  API', '  Guides', '    Install', 'Blog'])
  })

  it('indents and outdents like an outliner', () => {
    expect(indentNode(menu, [0])).toBeUndefined()
    const indented = indentNode(menu, [2])!
    expect(indented.to).toEqual([1, 2])
    expect(outline(indented.nodes)).toEqual(['Home', 'Docs', '  Guides', '    Install', '  API', '  Blog'])

    expect(outdentNode(menu, [1])).toBeUndefined()
    const outdented = outdentNode(menu, [1, 0])!
    expect(outdented.to).toEqual([2])
    expect(outline(outdented.nodes)).toEqual(['Home', 'Docs', '  API', 'Guides', '  Install', 'Blog'])
  })

  it('moves to any position given in the tree before the move', () => {
    // Blog into Docs, before API.
    const moved = moveNode(menu, [2], [1], 1)!
    expect(moved.to).toEqual([1, 1])
    expect(outline(moved.nodes)).toEqual(['Home', 'Docs', '  Guides', '    Install', '  Blog', '  API'])
    // Home to after Docs: index 2 in the list before the move.
    expect(moveNode(menu, [0], [], 2)!.to).toEqual([1])
    // Not into itself or its own children.
    expect(moveNode(menu, [1], [1, 0], 0)).toBeUndefined()
    expect(moveNode(menu, [1], [1], 0)).toBeUndefined()
  })

  it('respects maxDepth', () => {
    const options = { maxDepth: 3 }
    // Docs is three levels deep: it cannot go under Home.
    expect(indentNode(menu, [1], options)).toBeUndefined()
    expect(moveNode(menu, [1], [0], 0, options)).toBeUndefined()
    expect(insertNode(menu, [1, 0, 0], 0, item('Too deep'), options)).toBeUndefined()
    expect(indentNode(menu, [2], options)).toBeDefined()
  })

  it('uses another children key', () => {
    const pages = [{ title: 'A' }, { title: 'B' }]
    const indented = indentNode(pages, [1], { childrenKey: 'pages' })!
    expect(indented.nodes).toEqual([{ title: 'A', pages: [{ title: 'B' }] }])
    expect(outdentNode(indented.nodes, [0, 0], { childrenKey: 'pages' })!.nodes).toEqual(pages)
  })

  it('remaps paths across changes', () => {
    // Blog moved into Docs before API.
    const move = { from: [2], to: [1, 1] }
    expect(remapPath([2], move)).toEqual([1, 1])
    expect(remapPath([1, 1], move)).toEqual([1, 2])
    expect(remapPath([1, 0, 0], move)).toEqual([1, 0, 0])
    expect(remapPath([0], move)).toEqual([0])
    // Docs moved down below Blog carries its children along.
    const down = moveDown(menu, [1])!
    expect(remapPath([1, 0, 0], down)).toEqual([2, 0, 0])
    expect(remapPath([2], down)).toEqual([1])
    // Removal.
    expect(remapPath([1, 0, 0], { from: [1] })).toBeUndefined()
    expect(remapPath([2], { from: [1] })).toEqual([1])
    // Insertion.
    expect(remapPath([1, 0], { to: [1, 0] })).toEqual([1, 1])
    expect(remapPath([0, 3], { to: [1, 0] })).toEqual([0, 3])
  })
})
