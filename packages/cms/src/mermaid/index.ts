// gitvfs-cms/mermaid: renders Mermaid diagrams for the mermaid field and the markdown preview.
// mermaid is large, so it is loaded with a dynamic import the first time a diagram is shown; the
// main entries never import this module.
//
//   import { MermaidField } from 'gitvfs-cms/mermaid'
//   <CmsApp cms={cms} formComponents={{ mermaid: MermaidField }} />

import { createMermaidField, type MermaidRenderer } from '../react/mermaid.js'

/**
 * Give the root `<svg>` the size of its `viewBox`. Mermaid sets `width="100%"`, which leaves a
 * diagram shown through `<img>` without a natural size.
 */
export function sizeSvg(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/, (tag) => {
    const box = /\sviewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/i.exec(tag)
    if (!box) return tag
    return tag.replace(/\s(?:width|height)="[^"]*"/g, '').replace(/^<svg/, `<svg width="${box[1]}" height="${box[2]}"`)
  })
}

let queue: Promise<unknown> = Promise.resolve()
let counter = 0

/**
 * Render Mermaid source to SVG markup with `securityLevel: 'strict'` (labels are sanitized, click
 * handlers are off) and the default or dark theme. Renders run one at a time, because mermaid's
 * configuration is global.
 */
export const renderMermaid: MermaidRenderer = (source, { dark }) => {
  const run = async () => {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
    const id = `gcms-mermaid-${++counter}`
    try {
      const { svg } = await mermaid.render(id, source)
      return sizeSvg(svg)
    } finally {
      // Mermaid leaves its scratch elements in the page when a diagram fails to render.
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}

/** The field component for `mermaid()`, with a live preview. Also renders ```mermaid blocks in the markdown preview. */
export const MermaidField = createMermaidField({ render: renderMermaid })

export { createMermaidField }
export type { MermaidRenderer }
