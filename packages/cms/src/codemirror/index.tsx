// gitvfs-cms/codemirror: a CodeMirror 6 editor for the code and mermaid fields. The main entries
// never import this module, so apps that do not register it do not ship CodeMirror.
//
//   import { CodeMirrorField } from 'gitvfs-cms/codemirror'
//   <CmsApp cms={cms} formComponents={{ code: CodeMirrorField }} />

import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { Compartment, EditorState, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { normalizeLanguage, tokenize, type CodeLanguage, type TokenType } from '../highlight.js'
import { createCodeField, setRef, type CodeEditorProps } from '../react/code.js'

// Language packages load when a field first needs them, so apps split them into their own chunks.
const LANGUAGE_PACKAGES: Partial<Record<CodeLanguage, () => Promise<Extension>>> = {
  js: () => import('@codemirror/lang-javascript').then((module) => module.javascript()),
  ts: () => import('@codemirror/lang-javascript').then((module) => module.javascript({ typescript: true })),
  json: () => import('@codemirror/lang-json').then((module) => module.json()),
  yaml: () => import('@codemirror/lang-yaml').then((module) => module.yaml()),
  css: () => import('@codemirror/lang-css').then((module) => module.css()),
  html: () => import('@codemirror/lang-html').then((module) => module.html()),
}

const TOKEN_MARKS = new Map<TokenType, Decoration>()
const tokenMark = (type: TokenType) => {
  let mark = TOKEN_MARKS.get(type)
  if (!mark) TOKEN_MARKS.set(type, (mark = Decoration.mark({ class: `gcms-tok-${type}` })))
  return mark
}

/** Highlighting from the built-in tokenizer, for languages without a CodeMirror package (shell, Mermaid, ...). */
function tokenHighlighting(language: CodeLanguage): Extension {
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>()
    let position = 0
    for (const token of tokenize(view.state.doc.toString(), language)) {
      if (token.type !== 'plain') builder.add(position, position + token.text.length, tokenMark(token.type))
      position += token.text.length
    }
    return builder.finish()
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = build(update.view)
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}

/** The CodeMirror language support for a code language: its package, or the built-in tokenizer. */
export async function loadLanguage(name: string | undefined): Promise<Extension> {
  const language = normalizeLanguage(name)
  const load = LANGUAGE_PACKAGES[language]
  return load ? load() : tokenHighlighting(language)
}

/** Colors from the same `--gcms-code-*` custom properties as the built-in editor, so both follow the theme and dark mode. */
export const codeMirrorHighlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.meta], color: 'var(--gcms-code-comment)' },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: 'var(--gcms-code-string)' },
  { tag: [tags.number, tags.color, tags.unit], color: 'var(--gcms-code-number)' },
  { tag: [tags.keyword, tags.modifier, tags.self], color: 'var(--gcms-code-keyword)' },
  { tag: [tags.bool, tags.null, tags.atom], color: 'var(--gcms-code-literal)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--gcms-code-property)' },
  { tag: [tags.tagName, tags.className, tags.typeName], color: 'var(--gcms-code-tag)' },
  { tag: [tags.special(tags.variableName), tags.labelName], color: 'var(--gcms-code-variable)' },
  { tag: [tags.punctuation, tags.bracket, tags.operator, tags.separator], color: 'var(--gcms-code-punctuation)' },
  { tag: tags.invalid, color: 'var(--gcms-danger)' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
])

export const codeMirrorTheme = EditorView.theme({
  '&': {
    border: '1px solid var(--gcms-border)',
    borderRadius: '6px',
    backgroundColor: 'var(--gcms-bg)',
    color: 'var(--gcms-text)',
    fontSize: '0.85rem',
  },
  '&.cm-focused': { outline: '2px solid var(--gcms-accent)', outlineOffset: '1px' },
  '.cm-scroller': {
    minHeight: 'calc(var(--gcms-code-rows, 8) * 1.55em + 1rem)',
    maxHeight: '32em',
    fontFamily: 'var(--gcms-mono)',
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '0.5rem 0', caretColor: 'var(--gcms-text)' },
  '.cm-line': { padding: '0 0.75rem' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--gcms-text)' },
  '.cm-gutters': {
    borderRight: '1px solid var(--gcms-border)',
    borderRadius: '6px 0 0 6px',
    backgroundColor: 'var(--gcms-surface)',
    color: 'var(--gcms-muted)',
  },
  // Only while focused: every code field on a form would otherwise mark its first line.
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--gcms-code-active-line)' },
  '&.cm-focused .cm-activeLineGutter': { backgroundColor: 'var(--gcms-code-active-line)', color: 'var(--gcms-text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--gcms-code-selection)',
  },
  '.cm-matchingBracket': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--gcms-code-selection)',
    outline: '1px solid var(--gcms-border)',
  },
  '.gcms-cm-error-line': { backgroundColor: 'var(--gcms-code-error-line)' },
})

const errorLineMark = Decoration.line({ class: 'gcms-cm-error-line' })

function options(lineNumbersOn: boolean, tabSize: number): Extension {
  return [
    lineNumbersOn ? [lineNumbers(), highlightActiveLineGutter()] : [],
    EditorState.tabSize.of(tabSize),
    indentUnit.of(' '.repeat(tabSize)),
  ]
}

/**
 * A CodeMirror 6 editor with the props of the built-in `CodeEditor`, for `createCodeField` and
 * `createMermaidField`. Tab indents; Esc then Tab moves focus on.
 */
export function CodeMirrorEditor(props: CodeEditorProps) {
  const { value, language, lineNumbers: lineNumbersOn = true, tabSize = 2, rows = 8, errorLine } = props
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const compartments = useMemo(
    () => ({ options: new Compartment(), language: new Compartment(), attributes: new Compartment(), error: new Compartment() }),
    [],
  )
  const attributes = EditorView.contentAttributes.of({
    id: props.id,
    ...(props.label ? { 'aria-label': props.label } : {}),
    ...(props.describedBy ? { 'aria-describedby': props.describedBy } : {}),
    'aria-invalid': props.invalid ? 'true' : 'false',
  })

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          compartments.options.of(options(lineNumbersOn, tabSize)),
          compartments.language.of([]),
          compartments.attributes.of(attributes),
          compartments.error.of([]),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          syntaxHighlighting(codeMirrorHighlightStyle),
          codeMirrorTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
          }),
          EditorView.domEventHandlers({ blur: () => latest.current.onBlur?.() }),
        ],
      }),
    })
    view.current = editor
    setRef(latest.current.inputRef, editor)
    return () => {
      setRef(latest.current.inputRef, null)
      editor.destroy()
      view.current = null
    }
  }, [])

  // Follow changes from outside the editor, such as a form reset.
  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
    }
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.options.reconfigure(options(lineNumbersOn, tabSize)) })
  }, [lineNumbersOn, tabSize])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.attributes.reconfigure(attributes) })
  }, [props.id, props.label, props.describedBy, props.invalid])

  useEffect(() => {
    let current = true
    void loadLanguage(language).then((extension) => {
      if (current) view.current?.dispatch({ effects: compartments.language.reconfigure(extension) })
    })
    return () => {
      current = false
    }
  }, [language])

  useEffect(() => {
    // Computed from the current document, so the mark never points past its end while typing.
    const marks = errorLine
      ? EditorView.decorations.of(({ state: { doc } }) =>
          errorLine <= doc.lines ? Decoration.set(errorLineMark.range(doc.line(errorLine).from)) : Decoration.none,
        )
      : []
    view.current?.dispatch({ effects: compartments.error.reconfigure(marks) })
  }, [errorLine])

  return <div ref={host} className="gcms-codemirror" style={{ '--gcms-code-rows': rows } as CSSProperties} />
}

/** The field component for `code()` and `codeBlock()`, editing with CodeMirror. */
export const CodeMirrorField = createCodeField(CodeMirrorEditor)
