import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitVFS } from 'gitvfs'
import { z } from 'zod'
import { code, codeBlock, createCms, defineCollection, markdown, mermaid } from '../src'
import { CmsApp, createMermaidField, isDarkColor, type CmsAppProps, type MermaidRenderer } from '../src/react'
import { CodeMirrorField } from '../src/codemirror'
import { sizeSvg } from '../src/mermaid'
import { MemoryRepository } from './helpers/memory-repository'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function waitFor<T>(find: () => T | null | undefined, timeout = 2000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for element')
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
}

function byText(text: string, selector = 'button'): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text)
}

function typeInto(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

function press(element: HTMLTextAreaElement, key: string, options: KeyboardEventInit = {}) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))
}

const snippets = defineCollection({
  name: 'snippets',
  label: 'Snippets',
  folder: 'snippets',
  format: 'yaml',
  schema: z.object({
    title: z.string().min(1),
    config: code({ label: 'Config', language: 'json' }).optional(),
    snippet: codeBlock({ label: 'Snippet', languages: ['ts', 'json'] }).optional(),
    diagram: mermaid({ label: 'Diagram' }).optional(),
  }),
})

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  folder: 'posts',
  schema: z.object({ title: z.string().min(1), body: z.string().check(markdown()).default('') }),
})

function setup(files: Record<string, string>, props: Partial<CmsAppProps> = {}) {
  const remote = new MemoryRepository(files)
  const cms = createCms({ fs: new GitVFS({ repository: remote, branch: 'main', cache: 'none' }), collections: [snippets, posts] })
  act(() => root.render(<CmsApp cms={cms} title="Test CMS" {...props} />))
  return remote
}

async function click(label: string) {
  const button = await waitFor(() => byText(label))
  await act(async () => button.click())
}

async function open(label: string) {
  await click(label)
  return waitFor(() => container.querySelector<HTMLTextAreaElement>('textarea[id="config"]'))
}

const JSON_FILE = 'title: Demo\nconfig: |\n  {\n    "a": 1\n  }\n'

describe('code fields', () => {
  it('highlights code, numbers lines and saves a block scalar', async () => {
    const remote = setup({ 'snippets/demo.yml': JSON_FILE })
    const config = await open('Demodemo')
    expect(config.value).toBe('{\n  "a": 1\n}\n')
    const editor = config.closest('.gcms-code')!
    expect(editor.querySelector('.gcms-tok-property')?.textContent).toBe('"a"')
    expect(editor.querySelector('.gcms-tok-number')?.textContent).toBe('1')
    expect([...editor.querySelectorAll('.gcms-code-gutter span')].map((line) => line.textContent)).toEqual(['1', '2', '3', '4'])
    expect(document.querySelector('label[for="config"]')?.textContent).toContain('Config')
    expect(config.getAttribute('aria-describedby')).toBe('config-hint')

    await act(async () => typeInto(config, '{\n  "a": 1,\n  "b": [true]\n}\n'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('snippets/demo.yml')).toBe('title: Demo\nconfig: |\n  {\n    "a": 1,\n    "b": [true]\n  }\n')
  })

  it('indents with Tab and Shift+Tab and keeps indentation on Enter', async () => {
    setup({ 'snippets/demo.yml': 'title: Demo\nconfig: "{}"\n' })
    const config = await open('Demodemo')

    // Enter between braces opens an indented line.
    config.setSelectionRange(1, 1)
    await act(async () => press(config, 'Enter'))
    expect(config.value).toBe('{\n  \n}')
    expect(config.selectionStart).toBe(4)

    await act(async () => press(config, 'Tab'))
    expect(config.value).toBe('{\n    \n}')
    await act(async () => press(config, 'Tab', { shiftKey: true }))
    expect(config.value).toBe('{\n  \n}')

    // A multi-line selection indents every line that has text.
    config.setSelectionRange(0, config.value.length)
    await act(async () => press(config, 'Tab'))
    expect(config.value).toBe('  {\n  \n  }')

    // Esc then Tab leaves the editor: the key is not taken over.
    await act(async () => press(config, 'Escape'))
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => config.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(false)
    expect(config.value).toBe('  {\n  \n  }')
  })

  it('shows JSON syntax errors with their line, and blocks saving', async () => {
    const remote = setup({ 'snippets/demo.yml': JSON_FILE })
    const config = await open('Demodemo')

    await act(async () => typeInto(config, '{\n  "a": 1,\n}'))
    const message = await waitFor(() => container.querySelector('#config-syntax'))
    expect(message.textContent).toBe('Line 3, column 1: Trailing comma')
    expect(config.getAttribute('aria-invalid')).toBe('true')
    expect(config.getAttribute('aria-describedby')).toBe('config-syntax config-hint')
    expect(container.querySelector('.gcms-code-error-line')?.textContent).toBe('3')

    await act(async () => byText('Save')!.click())
    await waitFor(() => byText('Invalid JSON on line 3: Trailing comma', 'p'))
    // The field wrapper now shows the problem; the editor does not repeat it.
    expect(container.querySelector('#config-syntax')).toBeNull()
    expect(remote.commits).toHaveLength(0)
  })

  it('picks a language for a code block and stores { language, code }', async () => {
    const remote = setup({ 'snippets/demo.yml': 'title: Demo\n' })
    await open('Demodemo')
    const snippet = container.querySelector<HTMLTextAreaElement>('textarea[id="snippet"]')!
    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!
    expect(picker.value).toBe('ts')

    await act(async () => typeInto(picker, 'json'))
    await act(async () => typeInto(snippet, '[1, 2]'))
    expect(snippet.closest('.gcms-code')!.querySelector('.gcms-tok-number')).toBeTruthy()
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('snippets/demo.yml')).toBe('title: Demo\nsnippet:\n  language: json\n  code: "[1, 2]"\n')

    // Emptying an optional snippet removes it.
    await act(async () => typeInto(snippet, ''))
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 2)
    expect(remote.text('snippets/demo.yml')).toBe('title: Demo\n')
  })
})

describe('gitvfs-cms/codemirror', () => {
  it('edits code fields with CodeMirror when registered', async () => {
    const remote = setup({ 'snippets/demo.yml': JSON_FILE }, { formComponents: { code: CodeMirrorField } })
    await click('Demodemo')
    const content = await waitFor(() => container.querySelector<HTMLElement>('.cm-content#config'))
    expect(content.getAttribute('aria-label')).toBe('Config')
    expect(content.getAttribute('aria-describedby')).toBe('config-hint')
    expect([...content.querySelectorAll('.cm-line')].map((line) => line.textContent)).toEqual(['{', '  "a": 1', '}', ''])

    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(content)!
    await act(async () => view.dispatch({ changes: { from: view.state.doc.length - 2, insert: ',' } }))
    await waitFor(() => container.querySelector('#config-syntax'))
    expect(content.getAttribute('aria-invalid')).toBe('true')
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '{"b": 2}\n' } }))
    await waitFor(() => !container.querySelector('#config-syntax'))
    await act(async () => byText('Save')!.click())
    await waitFor(() => remote.commits.length === 1)
    expect(remote.text('snippets/demo.yml')).toBe('title: Demo\nconfig: |\n  {"b": 2}\n')
  })
})

describe('mermaid fields', () => {
  const DIAGRAM = 'title: Demo\ndiagram: |\n  graph TD\n    A --> B\n'

  it('edits the source and says the preview needs gitvfs-cms/mermaid', async () => {
    setup({ 'snippets/demo.yml': DIAGRAM })
    await open('Demodemo')
    const source = container.querySelector<HTMLTextAreaElement>('textarea[id="diagram"]')!
    expect(source.value).toBe('graph TD\n  A --> B\n')
    expect(source.closest('.gcms-code')!.querySelector('.gcms-tok-keyword')?.textContent).toBe('graph')
    expect(container.querySelector('.gcms-mermaid-note')?.textContent).toContain('gitvfs-cms/mermaid')
    expect(container.querySelector('.gcms-mermaid-preview')).toBeNull()
  })

  it('renders a live preview and shows render errors inline', async () => {
    const render = vi.fn<MermaidRenderer>(async (source) => {
      if (source.includes('-->')) return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>ok</text></svg>'
      throw new Error('Parse error on line 2')
    })
    setup({ 'snippets/demo.yml': DIAGRAM }, { formComponents: { mermaid: createMermaidField({ render }) } })
    await open('Demodemo')

    const image = await waitFor(() => container.querySelector<HTMLImageElement>('.gcms-mermaid-diagram'))
    expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/)
    expect(render).toHaveBeenCalledWith('graph TD\n  A --> B\n', { dark: false })
    expect(container.querySelector('.gcms-mermaid-note')).toBeNull()

    const source = container.querySelector<HTMLTextAreaElement>('textarea[id="diagram"]')!
    await act(async () => typeInto(source, 'graph TD\n  A -'))
    const error = await waitFor(() => container.querySelector('.gcms-mermaid-error'))
    expect(error.textContent).toBe('Parse error on line 2')
    // The last good diagram stays, dimmed.
    expect(container.querySelector('.gcms-mermaid-diagram')?.getAttribute('data-stale')).toBe('true')

    await act(async () => typeInto(source, 'graph TD\n  A --> C'))
    await waitFor(() => container.querySelector('.gcms-mermaid-diagram:not([data-stale])'))
    expect(container.querySelector('.gcms-mermaid-error')).toBeNull()
  })

  it('renders ```mermaid blocks in the markdown preview as images, when registered', async () => {
    // Whatever a renderer returns ends up inside an <img> data URL, never as markup in the frame.
    const render = vi.fn<MermaidRenderer>(async () => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    setup(
      { 'posts/hello.md': '---\ntitle: Hello\n---\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n```js\nlet a\n```\n' },
      { formComponents: { mermaid: createMermaidField({ render }) } },
    )
    await click('Posts')
    await click('Hellohello')
    const frame = await waitFor(() => container.querySelector('iframe'))
    await waitFor(() => frame.getAttribute('srcdoc')?.includes('<img class="mermaid"'), 3000)
    const html = frame.getAttribute('srcdoc')!
    expect(render).toHaveBeenCalledWith('graph TD\n  A --> B', { dark: false })
    expect(html).toContain('src="data:image/svg+xml;charset=utf-8,%3Csvg')
    expect(html).not.toContain('<script')
    expect(html).toContain('<code class="language-js">')
  })

  it('leaves ```mermaid blocks as code without a renderer', async () => {
    setup({ 'posts/hello.md': '---\ntitle: Hello\n---\n\n```mermaid\ngraph TD\n```\n' })
    await click('Posts')
    await click('Hellohello')
    const frame = await waitFor(() => container.querySelector('iframe'))
    await waitFor(() => frame.getAttribute('srcdoc')?.includes('<code class="language-mermaid">'))
  })
})

describe('mermaid helpers', () => {
  it('sizes the SVG by its viewBox, so an <img> gets a natural size', () => {
    const svg = '<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 280px;" viewBox="-8 -8 280.5 254"><g/></svg>'
    expect(sizeSvg(svg)).toBe('<svg width="280.5" height="254" id="m" xmlns="http://www.w3.org/2000/svg" style="max-width: 280px;" viewBox="-8 -8 280.5 254"><g/></svg>')
    expect(sizeSvg('<svg width="1"></svg>')).toBe('<svg width="1"></svg>')
  })

  it('tells dark colors from light ones', () => {
    expect(isDarkColor('#14171c')).toBe(true)
    expect(isDarkColor('#fff')).toBe(false)
    expect(isDarkColor(' rgb(27, 31, 38) ')).toBe(true)
    expect(isDarkColor('rgb(246 247 249)')).toBe(false)
    expect(isDarkColor('')).toBeUndefined()
  })
})
