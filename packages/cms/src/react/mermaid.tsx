import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { useFieldRHF } from '@autoform/react/react-hook-form'
import type { AutoFormFieldComponents, AutoFormFieldProps } from '@autoform/react'
import { CodeBody, CodeEditor, type CodeEditorComponent } from './code.js'

// Not imported from ./autoform.js, which imports this module for its field components.
const useField = (name: string) => useFieldRHF({ name }).field

/**
 * Renders Mermaid source to SVG markup, or rejects with the syntax error. `gitvfs-cms/mermaid`
 * exports one (`renderMermaid`) that loads mermaid only when a diagram is first shown.
 */
export type MermaidRenderer = (source: string, options: { dark: boolean }) => Promise<string>

/**
 * SVG markup as an image source. Shown through `<img>`, a diagram can never run scripts or load
 * anything, whatever its labels contain, and its styles cannot leak into the page.
 */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Whether a CSS color (`#14171c`, `rgb(20 23 28)`) is dark; undefined when it cannot tell. */
export function isDarkColor(color: string): boolean | undefined {
  let channels: number[] | undefined
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color.trim())
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((digit) => digit + digit) : hex[1].match(/../g)!
    channels = digits.map((pair) => parseInt(pair, 16))
  } else {
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim())
    if (rgb) channels = rgb.slice(1, 4).map(Number)
  }
  if (!channels) return undefined
  const [r, g, b] = channels
  return 0.299 * r + 0.587 * g + 0.114 * b < 128
}

/**
 * Whether the editor is dark: from the `--gcms-bg` the element sees (so a theme that overrides the
 * custom properties counts), else from `prefers-color-scheme`.
 */
export function useDarkMode(element?: RefObject<HTMLElement | null>): boolean {
  const [dark, setDark] = useState(false)
  useLayoutEffect(() => {
    const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
    const update = () => {
      const background = element?.current ? getComputedStyle(element.current).getPropertyValue('--gcms-bg') : ''
      setDark(isDarkColor(background) ?? query?.matches ?? false)
    }
    update()
    query?.addEventListener?.('change', update)
    return () => query?.removeEventListener?.('change', update)
  }, [element])
  return dark
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || 'The diagram could not be rendered.'
}

export interface MermaidPreviewProps {
  source: string
  render: MermaidRenderer
  /** Wait this long after typing stops before rendering, in milliseconds. Default: 300. */
  delay?: number
}

/** A live rendering of Mermaid source. On an error the last good diagram stays, dimmed. */
export function MermaidPreview({ source, render, delay = 300 }: MermaidPreviewProps) {
  const element = useRef<HTMLDivElement | null>(null)
  const dark = useDarkMode(element)
  const [state, setState] = useState<{ svg?: string; error?: string }>({})
  const rendered = useRef(false)

  useEffect(() => {
    if (source.trim() === '') {
      setState({})
      return
    }
    let current = true
    // Render the first diagram at once; wait for a pause in typing after that.
    const timer = setTimeout(
      () => {
        rendered.current = true
        render(source, { dark }).then(
          (svg) => current && setState({ svg }),
          (error: unknown) => current && setState((previous) => ({ svg: previous.svg, error: errorText(error) })),
        )
      },
      rendered.current ? delay : 0,
    )
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [source, dark, render, delay])

  return (
    <div ref={element} className="gcms-mermaid-preview">
      {state.svg ? (
        <img
          className="gcms-mermaid-diagram"
          data-stale={state.error ? 'true' : undefined}
          src={svgDataUrl(state.svg)}
          alt="Rendered diagram"
        />
      ) : null}
      <div aria-live="polite">
        {state.error ? <pre className="gcms-error gcms-mermaid-error">{state.error}</pre> : null}
      </div>
      {!state.svg && !state.error ? (
        <p className="gcms-muted">{source.trim() ? 'Rendering…' : 'The diagram shows here.'}</p>
      ) : null}
    </div>
  )
}

export interface MermaidFieldOptions {
  /** Renders the preview. Without it the field shows a note that the preview needs `gitvfs-cms/mermaid`. */
  render?: MermaidRenderer
  /** The editor for the source. Default: the built-in `CodeEditor`. */
  editor?: CodeEditorComponent
}

/** A mermaid field component, with the renderer it was made with for the markdown preview. */
export type MermaidFieldComponent = ((props: AutoFormFieldProps) => JSX.Element) & {
  renderMermaid?: MermaidRenderer
}

/** Make the field component for `mermaid()`: the source in a code editor and a live preview. */
export function createMermaidField({ render, editor = CodeEditor }: MermaidFieldOptions = {}): MermaidFieldComponent {
  function MermaidField(props: AutoFormFieldProps) {
    const field = useField(props.id)
    const value = typeof field.value === 'string' ? field.value : ''
    return (
      <div className="gcms-mermaid">
        <div className="gcms-mermaid-layout">
          <CodeBody
            props={props}
            Editor={editor}
            value={value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            inputRef={field.ref}
            language="mermaid"
          />
          {render ? (
            <MermaidPreview source={value} render={render} />
          ) : (
            <p className="gcms-muted gcms-mermaid-note">
              Register <code>MermaidField</code> from <code>gitvfs-cms/mermaid</code> to see a live preview.
            </p>
          )}
        </div>
      </div>
    )
  }
  return Object.assign(MermaidField, { renderMermaid: render })
}

/** The field component for `mermaid()` without a renderer: the source editor and a note. */
export const MermaidField = createMermaidField()

/** The renderer of the registered mermaid field, which the markdown preview uses for ```mermaid blocks. */
export function mermaidRendererOf(components: Partial<AutoFormFieldComponents> | undefined): MermaidRenderer | undefined {
  return (components?.mermaid as MermaidFieldComponent | undefined)?.renderMermaid
}

/**
 * Render the given Mermaid sources, for the markdown preview: a map from source to SVG that fills
 * in as diagrams finish. Sources that fail to render are left out, so they show as code.
 */
export function useMermaidDiagrams(sources: readonly string[], render: MermaidRenderer | undefined, delay = 400): ReadonlyMap<string, string> {
  const dark = useDarkMode()
  const [diagrams, setDiagrams] = useState<{ dark: boolean; svgs: ReadonlyMap<string, string> }>({ dark, svgs: new Map() })
  const key = sources.join('\u0000')

  useEffect(() => {
    if (!render || sources.length === 0) return
    const known = diagrams.dark === dark ? diagrams.svgs : new Map<string, string>()
    const missing = [...new Set(sources)].filter((source) => !known.has(source))
    if (missing.length === 0) return
    let current = true
    const timer = setTimeout(async () => {
      const svgs = new Map([...known].filter(([source]) => sources.includes(source)))
      for (const source of missing) {
        try {
          svgs.set(source, await render(source, { dark }))
        } catch {
          // Shown as a code block until it renders.
        }
        if (!current) return
      }
      setDiagrams({ dark, svgs })
    }, delay)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [key, dark, render])

  return diagrams.dark === dark ? diagrams.svgs : EMPTY
}

const EMPTY: ReadonlyMap<string, string> = new Map()
