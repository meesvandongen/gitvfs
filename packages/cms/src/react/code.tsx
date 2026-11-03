import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import {
  applyTextEdit,
  indentSelection,
  insertNewline,
  outdentSelection,
  validateCode,
  type CodeCustomData,
  type CodeError,
  type TextEdit,
} from '../code.js'
import { CODE_LANGUAGES, normalizeLanguage, tokenize, type CodeLanguage } from '../highlight.js'
import { fieldOptions, useErrorTree, useField } from './field-utils.js'

/**
 * What a code editor component gets. The built-in `CodeEditor` and the CodeMirror one in
 * `gitvfs-cms/codemirror` both take these, so either can back the code and mermaid fields.
 */
export interface CodeEditorProps {
  id: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  language?: string
  /** Default: true. */
  lineNumbers?: boolean
  /** Default: 2. */
  tabSize?: number
  /** Lines shown before the editor grows. Default: 8. */
  rows?: number
  /** 1-based line to mark as wrong. */
  errorLine?: number
  /** Accessible name, for editors that a `<label for>` cannot name. */
  label?: string
  /** Ids of elements that describe the editor, such as hints and errors. */
  describedBy?: string
  invalid?: boolean
  /** Gets something to `focus()`, so the form can move focus to the field when it is invalid. */
  inputRef?: Ref<{ focus(): void }>
  inputProps?: Record<string, unknown>
}

export type CodeEditorComponent = ComponentType<CodeEditorProps>

/** Hand `instance` to a callback or object ref. */
export function setRef<T>(ref: Ref<T> | undefined, instance: T | null): void {
  if (typeof ref === 'function') ref(instance)
  else if (ref) (ref as { current: T | null }).current = instance
}

/** Replace a range through the browser, so the edit lands in its undo history. */
function insertText(textarea: HTMLTextAreaElement, edit: TextEdit): boolean {
  textarea.setSelectionRange(edit.from, edit.to)
  if (typeof document.execCommand !== 'function') return false
  try {
    return edit.insert === '' ? document.execCommand('delete') : document.execCommand('insertText', false, edit.insert)
  } catch {
    return false
  }
}

/**
 * A dependency-free code editor: a textarea over a highlighted copy of its text. Tab and
 * Shift+Tab indent, Enter keeps the indentation. Esc then Tab moves focus on, as in CodeMirror.
 */
export function CodeEditor({
  id,
  value,
  onChange,
  onBlur,
  language,
  lineNumbers = true,
  tabSize = 2,
  rows = 8,
  errorLine,
  describedBy,
  invalid,
  inputRef,
  inputProps,
}: CodeEditorProps) {
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const pendingSelection = useRef<[number, number] | null>(null)
  const escaped = useRef(false)
  const tokens = useMemo(() => tokenize(value, language), [value, language])
  const lineCount = useMemo(() => value.split('\n').length, [value])

  useLayoutEffect(() => {
    if (textarea.current && pendingSelection.current) {
      textarea.current.setSelectionRange(...pendingSelection.current)
      pendingSelection.current = null
    }
  }, [value])

  const apply = (element: HTMLTextAreaElement, edit: TextEdit) => {
    if (edit.from === edit.to && edit.insert === '') {
      element.setSelectionRange(edit.selectionStart, edit.selectionEnd)
    } else if (insertText(element, edit)) {
      element.setSelectionRange(edit.selectionStart, edit.selectionEnd)
    } else {
      pendingSelection.current = [edit.selectionStart, edit.selectionEnd]
      onChange(applyTextEdit(element.value, edit))
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const wasEscaped = escaped.current
    escaped.current = event.key === 'Escape'
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    const element = event.currentTarget
    const { selectionStart: start, selectionEnd: end } = element
    if (event.key === 'Tab' && !wasEscaped) {
      event.preventDefault()
      apply(element, (event.shiftKey ? outdentSelection : indentSelection)(element.value, start, end, tabSize))
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      apply(element, insertNewline(element.value, start, end, tabSize, language))
    }
  }

  return (
    <div
      className="gcms-code"
      data-invalid={invalid ? 'true' : undefined}
      style={{ '--gcms-code-rows': rows, tabSize } as CSSProperties}
    >
      <div className="gcms-code-scroll">
        {lineNumbers ? (
          <div className="gcms-code-gutter" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, index) => (
              <span key={index} className={index + 1 === errorLine ? 'gcms-code-error-line' : undefined}>
                {index + 1}
              </span>
            ))}
          </div>
        ) : null}
        <div className="gcms-code-area">
          <pre className="gcms-code-highlight" aria-hidden="true">
            {tokens.map((token, index) =>
              token.type === 'plain' ? token.text : (
                <span key={index} className={`gcms-tok-${token.type}`}>
                  {token.text}
                </span>
              ),
            )}
            {/* A final newline gives an empty last line its height. */}
            {'\n'}
          </pre>
          <textarea
            className="gcms-code-input"
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            {...inputProps}
            id={id}
            ref={(element) => {
              textarea.current = element
              setRef(inputRef, element)
            }}
            value={value}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
          />
        </div>
      </div>
    </div>
  )
}

// --- Fields --------------------------------------------------------------------------------------

export function codeOptions(props: AutoFormFieldProps): CodeCustomData['code'] {
  return fieldOptions<CodeCustomData['code']>(props.parsedField, 'code')
}

/** Whether the form has an error for a field, which the field wrapper shows; set after a save attempt. */
const useFormError = (name: string): boolean => useErrorTree(name) !== undefined

/** `error` once it has stayed the same for a moment, so typing does not flash errors; clears at once. */
function useSettled(error: CodeError | undefined, delay = 500): CodeError | undefined {
  const [settled, setSettled] = useState(error)
  const key = error && `${error.line}:${error.column}:${error.message}`
  useEffect(() => {
    if (!error) {
      setSettled(undefined)
      return
    }
    const timer = setTimeout(() => setSettled(error), delay)
    return () => clearTimeout(timer)
  }, [key])
  return error && settled
}

interface CodeBodyProps {
  props: AutoFormFieldProps
  Editor: CodeEditorComponent
  value: string
  onChange: (value: string) => void
  onBlur: () => void
  inputRef?: Ref<{ focus(): void }>
  language: string | undefined
  /** Shown at the start of the bar under the editor, such as a language picker. */
  languageControl?: ReactNode
}

/** An editor with the syntax check and the bar under it; shared by the code and mermaid fields. */
export function CodeBody({ props, Editor, value, onChange, onBlur, inputRef, language, languageControl }: CodeBodyProps) {
  const options = codeOptions(props)
  const checked = useMemo(() => validateCode(value, language), [value, language])
  const error = useSettled(checked)
  const formError = useFormError(props.id)
  const hintId = `${props.id}-hint`
  const errorId = `${props.id}-syntax`
  // After a save attempt the field wrapper shows the schema's message for the same problem.
  const showError = error && !formError

  return (
    <div className="gcms-code-field">
      <Editor
        id={props.id}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        language={language}
        lineNumbers={options.lineNumbers}
        tabSize={options.tabSize}
        rows={options.rows}
        errorLine={error?.line}
        label={typeof props.label === 'string' ? props.label : undefined}
        describedBy={showError ? `${errorId} ${hintId}` : hintId}
        invalid={Boolean(error) || formError}
        inputRef={inputRef}
        inputProps={props.inputProps}
      />
      <div className="gcms-code-bar">
        {languageControl ?? <span>{CODE_LANGUAGES[normalizeLanguage(language)]}</span>}
        <span id={hintId}>Tab indents. Esc then Tab moves on.</span>
      </div>
      {showError ? (
        <p className="gcms-error" id={errorId}>
          Line {error.line}, column {error.column}: {error.message}
        </p>
      ) : null}
    </div>
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Make the field component for `code()` and `codeBlock()` from an editor component. The built-in
 * `CodeField` uses `CodeEditor`; `gitvfs-cms/codemirror` makes one with CodeMirror.
 */
export function createCodeField(Editor: CodeEditorComponent = CodeEditor) {
  return function CodeField(props: AutoFormFieldProps) {
    const field = useField(props.id)
    const options = codeOptions(props)
    const languages = options.languages
    // codeBlock(): the value is { language, code }.
    const block = languages && isRecord(field.value) ? field.value : undefined
    const [picked, setPicked] = useState<CodeLanguage | undefined>(languages?.[0])
    const language = languages ? (typeof block?.language === 'string' ? block.language : picked) : options.language
    const value = languages ? (typeof block?.code === 'string' ? block.code : '') : typeof field.value === 'string' ? field.value : ''

    const setBlock = (nextLanguage: string | undefined, code: string) =>
      // An optional snippet with no code is no snippet. Null, not undefined: react-hook-form would
      // show the stored value again for undefined.
      field.onChange(code === '' && !props.parsedField.required ? null : { language: nextLanguage, code })

    return (
      <CodeBody
        props={props}
        Editor={Editor}
        value={value}
        onChange={(next) => (languages ? setBlock(language, next) : field.onChange(next))}
        onBlur={field.onBlur}
        inputRef={field.ref}
        language={language}
        languageControl={
          languages ? (
            <select
              className="gcms-code-language"
              aria-label="Language"
              value={language}
              onChange={(event) => {
                setPicked(event.target.value as CodeLanguage)
                setBlock(event.target.value, value)
              }}
            >
              {languages.map((name) => (
                <option key={name} value={name}>
                  {CODE_LANGUAGES[name] ?? name}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />
    )
  }
}

/** The field component for `code()` and `codeBlock()`, with the built-in editor. */
export const CodeField = createCodeField()
