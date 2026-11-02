import { toPlainData } from './document.js'
import { slugify } from './slug.js'

/** Empty-ish values count as equal: a field that is unset, `null` or `''` has no content either way. */
function normalize(value: unknown): unknown {
  const plain = toPlainData(value)
  if (plain === null || plain === undefined || plain === '') return undefined
  if (Array.isArray(plain)) return plain.map(normalize)
  if (typeof plain === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(plain).sort()) {
      const entry = normalize((plain as Record<string, unknown>)[key])
      if (entry !== undefined) result[key] = entry
    }
    return result
  }
  return plain
}

/**
 * Whether two form values hold the same content, whatever the field type: objects compare by
 * content regardless of key order, dates as their stored text, and unset, `null` and `''` match.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

/** The value at a dotted form path such as `author.name` or `tags.0`. */
export function valueAt(values: unknown, path: string): unknown {
  let current = values
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

/** Above this many line pairs, `diffLines` stops looking for common lines and replaces everything. */
const MAX_DIFF_CELLS = 4_000_000

/** A line-by-line diff of two texts (longest common subsequence), for showing any file's changes. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n')
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n')

  // Lines both share at the start and end need no table.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }))
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: 'same', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    return [
      ...head,
      ...midA.map((text): DiffLine => ({ kind: 'removed', text })),
      ...midB.map((text): DiffLine => ({ kind: 'added', text })),
      ...tail,
    ]
  }

  // lengths[i][j]: the longest common subsequence of midA[i..] and midB[j..].
  const width = midB.length + 1
  const lengths = new Uint32Array((midA.length + 1) * width)
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lengths[i * width + j] = midA[i] === midB[j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
    }
  }

  const middle: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      middle.push({ kind: 'same', text: midA[i] })
      i++
      j++
    } else if (j < midB.length && (i === midA.length || lengths[i * width + j + 1] >= lengths[(i + 1) * width + j])) {
      middle.push({ kind: 'added', text: midB[j++] })
    } else {
      middle.push({ kind: 'removed', text: midA[i++] })
    }
  }
  // Show removals before the additions that replace them, as diffs usually do.
  for (let k = 0; k + 1 < middle.length; k++) {
    if (middle[k].kind === 'added' && middle[k + 1].kind === 'removed') {
      let end = k + 1
      while (end < middle.length && middle[end].kind === 'removed') end++
      let begin = k
      while (begin > 0 && middle[begin - 1].kind === 'added') begin--
      const block = middle.slice(begin, end)
      middle.splice(begin, block.length, ...block.filter((line) => line.kind === 'removed'), ...block.filter((line) => line.kind === 'added'))
      k = end - 1
    }
  }
  return [...head, ...middle, ...tail]
}

/** The branch name for a change titled `title`, e.g. `cms/spring-update`. */
export function changeBranchName(prefix: string, title: string): string {
  return `${prefix}${slugify(title) || 'change'}`
}

/** A readable title for a change branch: `cms/spring-update` → `Spring update`. */
export function changeTitle(prefix: string, branch: string): string {
  const name = branch.startsWith(prefix) ? branch.slice(prefix.length) : branch
  const words = name.replace(/[-_/]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : branch
}
