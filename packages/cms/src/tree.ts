import { z } from 'zod'
import { field, type CmsFieldConfig } from './fields.js'

// A tree is stored as nested lists: every node is an object with its own fields and, when it has
// any, a `children` list of nodes. Leaves have no `children` key at all, so menus read naturally
// in YAML and JSON and adding a level never rewrites the siblings:
//
//   - label: Docs
//     href: /docs
//     children:
//       - label: Guides
//         href: /docs/guides

/** Where a node is: its index in the top-level list, then in each `children` list down. */
export type TreePath = readonly number[]

/** A node with its fields and, optionally, child nodes under `K`. */
export type TreeNode<T, K extends string = 'children'> = T & { [P in K]?: Array<TreeNode<T, K>> }

export interface TreeOptions {
  /** Key of the child list. Default: `'children'`. */
  childrenKey?: string
  /** Most levels allowed; 1 is a flat list. Default: unlimited. */
  maxDepth?: number
}

export interface TreeConfig<Shape extends z.ZodRawShape, K extends string>
  extends Omit<CmsFieldConfig, 'fieldType' | 'customData'> {
  /** The fields of every node, such as `{ label: z.string(), href: z.string().optional() }`. */
  fields: Shape
  childrenKey?: K
  maxDepth?: number
  /** Field shown as a node's title in the outline. Default: `label`, `title` or `name`, else the first field. */
  labelField?: keyof Shape & string
}

/** Where tree fields keep their options in AutoForm's `customData`. */
export interface TreeCustomData {
  tree: { childrenKey: string; maxDepth?: number; labelField?: string }
}

type Node = Record<string, unknown>

function dropEmptyChildren(key: string) {
  return (node: Node): Node => {
    if (!Array.isArray(node[key]) || (node[key] as unknown[]).length > 0) return node
    const { [key]: _empty, ...rest } = node
    return rest
  }
}

/**
 * A nested list, such as a navigation menu or a page hierarchy, edited as an outline.
 *
 * ```ts
 * menu: tree({
 *   label: 'Menu',
 *   fields: { label: z.string().min(1), href: z.string().optional() },
 *   maxDepth: 3,
 * }).default([])
 * ```
 *
 * The child list is a `z.lazy` schema rather than a getter: AutoForm walks object shapes eagerly
 * and would recurse forever into a getter. Empty child lists are dropped from the saved value.
 */
export function tree<Shape extends z.ZodRawShape, K extends string = 'children'>(config: TreeConfig<Shape, K>) {
  const { fields, childrenKey = 'children' as K, maxDepth, labelField, ...fieldConfig } = config
  if (childrenKey in fields) throw new Error(`tree(): "${childrenKey}" is the children key and cannot be a field too`)
  if (maxDepth !== undefined && !(Number.isInteger(maxDepth) && maxDepth >= 1)) {
    throw new Error('tree(): maxDepth must be a whole number of at least 1')
  }

  const shape: z.ZodRawShape = { ...fields, [childrenKey]: z.lazy(() => z.array(node)).optional() }
  const node: z.ZodType = z.object(shape).overwrite(dropEmptyChildren(childrenKey))
  const customData: TreeCustomData = { tree: { childrenKey, maxDepth, labelField } }

  return z
    .array(node)
    .superRefine((nodes, context) => {
      if (maxDepth === undefined) return
      for (const item of flattenTree(nodes as Node[], { childrenKey })) {
        if (item.level === maxDepth + 1) {
          context.addIssue({
            code: 'custom',
            message: `Nest at most ${maxDepth} level${maxDepth === 1 ? '' : 's'} deep`,
            path: item.path.flatMap((index, at) => (at === 0 ? [index] : [childrenKey, index])),
          })
        }
      }
    })
    .check(field({ ...fieldConfig, fieldType: 'tree', customData })) as unknown as z.ZodArray<
    z.ZodType<TreeNode<z.output<z.ZodObject<Shape>>, K>, TreeNode<z.input<z.ZodObject<Shape>>, K>>
  >
}

// --- Helpers -------------------------------------------------------------------------------------
// Pure functions over plain nested arrays. They never mutate, keep untouched nodes as they are and
// never leave an empty child list behind.

function childrenOf<N extends Node>(node: N | undefined, key: string): N[] {
  const children = node?.[key]
  return Array.isArray(children) ? (children as N[]) : []
}

const keyOf = (options: TreeOptions) => options.childrenKey ?? 'children'

/** `[1, 0]` → `'1.0'`, for React keys and sets of paths. */
export function pathKey(path: TreePath): string {
  return path.join('.')
}

/** Whether `ancestor` is `path` or one of its ancestors. */
export function isWithin(path: TreePath, ancestor: TreePath): boolean {
  return ancestor.length <= path.length && ancestor.every((index, at) => path[at] === index)
}

/** The node at `path`, or `undefined`. */
export function getNode<N extends Node>(nodes: readonly N[], path: TreePath, options: TreeOptions = {}): N | undefined {
  let list: readonly N[] = nodes
  let node: N | undefined
  for (const index of path) {
    node = list[index]
    if (!node) return undefined
    list = childrenOf(node, keyOf(options))
  }
  return node
}

/** Levels in a node's subtree: 1 for a leaf. */
export function nodeHeight(node: Node, options: TreeOptions = {}): number {
  return 1 + Math.max(0, ...childrenOf(node, keyOf(options)).map((child) => nodeHeight(child, options)))
}

/** Number of nodes below `node`. */
export function countDescendants(node: Node, options: TreeOptions = {}): number {
  return childrenOf(node, keyOf(options)).reduce((total, child) => total + 1 + countDescendants(child, options), 0)
}

export interface FlatTreeNode<N extends Node = Node> {
  node: N
  path: number[]
  /** 1 for top-level nodes. */
  level: number
  /** Position among its siblings, from 0, and how many siblings there are. */
  index: number
  setSize: number
  hasChildren: boolean
}

/**
 * The nodes in outline order, with their depth. Descendants of nodes for which `isCollapsed`
 * returns true are left out, which gives the rows an outline shows.
 */
export function flattenTree<N extends Node>(
  nodes: readonly N[],
  options: TreeOptions & { isCollapsed?: (path: TreePath, node: N) => boolean } = {},
): Array<FlatTreeNode<N>> {
  const result: Array<FlatTreeNode<N>> = []
  const walk = (list: readonly N[], parent: number[]) => {
    list.forEach((node, index) => {
      const path = [...parent, index]
      const children = childrenOf(node, keyOf(options))
      result.push({ node, path, level: path.length, index, setSize: list.length, hasChildren: children.length > 0 })
      if (children.length > 0 && !options.isCollapsed?.(path, node)) walk(children, path)
    })
  }
  walk(nodes, [])
  return result
}

/** Replace the child list at `parent` (`[]` for the top level), dropping the key when it ends up empty. */
function withChildren<N extends Node>(nodes: readonly N[], parent: TreePath, update: (children: N[]) => N[], key: string): N[] {
  if (parent.length === 0) return update([...nodes])
  const [index, ...rest] = parent
  return nodes.map((node, at) => {
    if (at !== index) return node
    const children = rest.length === 0 ? update([...childrenOf(node, key)]) : withChildren(childrenOf(node, key), rest, update, key)
    const { [key]: _old, ...fields } = node
    return (children.length > 0 ? { ...fields, [key]: children } : fields) as N
  })
}

/** Change the node at `path`. */
export function updateNode<N extends Node>(nodes: readonly N[], path: TreePath, update: (node: N) => N, options: TreeOptions = {}): N[] {
  const index = path[path.length - 1]
  return withChildren(nodes, path.slice(0, -1), (list) => list.map((node, at) => (at === index ? update(node) : node)), keyOf(options))
}

/**
 * The result of a structural change: the new nodes, where the changed node was (`from`) and where
 * it is now (`to`). Pass it to `remapPath` to keep track of other nodes.
 */
export interface TreeChange<N extends Node = Node> {
  nodes: N[]
  from?: number[]
  to?: number[]
}

function fits(level: number, node: Node, options: TreeOptions) {
  return options.maxDepth === undefined || level + nodeHeight(node, options) - 1 <= options.maxDepth
}

/** Insert `node` as child `index` of `parent` (`[]` for the top level), or `undefined` when it is too deep. */
export function insertNode<N extends Node>(nodes: readonly N[], parent: TreePath, index: number, node: N, options: TreeOptions = {}): TreeChange<N> | undefined {
  if (!fits(parent.length + 1, node, options)) return undefined
  if (parent.length > 0 && !getNode(nodes, parent, options)) return undefined
  let at = index
  const result = withChildren(nodes, parent, (list) => {
    at = Math.min(Math.max(0, index), list.length)
    list.splice(at, 0, node)
    return list
  }, keyOf(options))
  return { nodes: result, to: [...parent, at] }
}

/** Remove the node at `path`, with its children. */
export function removeNode<N extends Node>(nodes: readonly N[], path: TreePath, options: TreeOptions = {}): TreeChange<N> {
  const index = path[path.length - 1]
  return { nodes: withChildren(nodes, path.slice(0, -1), (list) => list.filter((_, at) => at !== index), keyOf(options)), from: [...path] }
}

/**
 * Move the node at `from` (with its children) to become child `index` of `parent`, where `parent`
 * and `index` describe the tree before the move, as a drop target does. Returns `undefined` when
 * the move is impossible: into itself or its own children, or deeper than `maxDepth`.
 */
export function moveNode<N extends Node>(nodes: readonly N[], from: TreePath, parent: TreePath, index: number, options: TreeOptions = {}): TreeChange<N> | undefined {
  const node = getNode(nodes, from, options)
  if (!node || isWithin(parent, from)) return undefined
  if (!fits(parent.length + 1, node, options)) return undefined
  // Positions after the removal of `from`.
  const target = shiftAfterRemove(parent, from)
  const sameList = parent.length === from.length - 1 && isWithin(from, parent)
  const at = sameList && index > from[from.length - 1] ? index - 1 : index
  const inserted = insertNode(removeNode(nodes, from, options).nodes, target, at, node, { ...options, maxDepth: undefined })
  return inserted && { nodes: inserted.nodes, from: [...from], to: inserted.to }
}

/** Swap with the previous sibling. */
export function moveUp<N extends Node>(nodes: readonly N[], path: TreePath, options: TreeOptions = {}): TreeChange<N> | undefined {
  const index = path[path.length - 1]
  return index > 0 ? moveNode(nodes, path, path.slice(0, -1), index - 1, options) : undefined
}

/** Swap with the next sibling. */
export function moveDown<N extends Node>(nodes: readonly N[], path: TreePath, options: TreeOptions = {}): TreeChange<N> | undefined {
  const parent = path.slice(0, -1)
  const siblings = parent.length === 0 ? nodes : childrenOf(getNode(nodes, parent, options), keyOf(options))
  const index = path[path.length - 1]
  return index < siblings.length - 1 ? moveNode(nodes, path, parent, index + 2, options) : undefined
}

/** Make the node the last child of its previous sibling, as Tab does in an outliner. */
export function indentNode<N extends Node>(nodes: readonly N[], path: TreePath, options: TreeOptions = {}): TreeChange<N> | undefined {
  const index = path[path.length - 1]
  if (!(index > 0)) return undefined
  const parent = [...path.slice(0, -1), index - 1]
  return moveNode(nodes, path, parent, childrenOf(getNode(nodes, parent, options), keyOf(options)).length, options)
}

/** Move the node out of its parent, to right after it, as Shift+Tab does in an outliner. */
export function outdentNode<N extends Node>(nodes: readonly N[], path: TreePath, options: TreeOptions = {}): TreeChange<N> | undefined {
  if (path.length < 2) return undefined
  return moveNode(nodes, path, path.slice(0, -2), path[path.length - 2] + 1, options)
}

function shiftAfterRemove(path: TreePath, removed: TreePath): number[] {
  const depth = removed.length - 1
  const result = [...path]
  if (path.length > depth && isWithin(path.slice(0, depth), removed.slice(0, depth)) && path[depth] > removed[depth]) result[depth]--
  return result
}

function shiftAfterInsert(path: TreePath, inserted: TreePath): number[] {
  const depth = inserted.length - 1
  const result = [...path]
  if (path.length > depth && isWithin(path.slice(0, depth), inserted.slice(0, depth)) && path[depth] >= inserted[depth]) result[depth]++
  return result
}

/**
 * Where the node that was at `path` is after `change`, or `undefined` when it was removed. Keeps
 * selection, expanded state and the like attached to the right nodes across edits.
 */
export function remapPath(path: TreePath, change: Pick<TreeChange, 'from' | 'to'>): number[] | undefined {
  if (change.from && isWithin(path, change.from)) {
    return change.to ? [...change.to, ...path.slice(change.from.length)] : undefined
  }
  let result = change.from ? shiftAfterRemove(path, change.from) : [...path]
  if (change.to) result = shiftAfterInsert(result, change.to)
  return result
}
