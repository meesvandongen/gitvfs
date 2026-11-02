import { parseDocument } from 'yaml'
import { z } from 'zod'
import { field, type CmsFieldConfig } from './fields.js'
import { CODE_LANGUAGES, normalizeLanguage, type CodeLanguage } from './highlight.js'

// Code and diagram fields store plain strings (or `{ language, code }`), so YAML writes them as
// block scalars (`code: |`) and they diff line by line.

/** How a code field edits. */
export interface CodeOptions {
  /** Language for highlighting and syntax checks: `ts`, `json`, `yaml`, `css`, `html`, ... Default: `text`. */
  language?: CodeLanguage | (string & {})
  /** Show line numbers. Default: true. */
  lineNumbers?: boolean
  /** Spaces per indentation level. Default: 2. */
  tabSize?: number
  /** Lines shown before the editor grows. Default: 8. */
  rows?: number
}

/** Editor options of a code field, without `fieldType` (set by the helper). */
export type CodeFieldConfig<O = CodeOptions> = Omit<CmsFieldConfig, 'fieldType' | 'customData'> & O

/** Where code fields keep their options in AutoForm's `customData`. */
export interface CodeCustomData {
  code: CodeOptions & {
    /** Set by `codeBlock()`: the languages to pick from; the value is `{ language, code }`. */
    languages?: CodeLanguage[]
  }
}

/** A syntax error with its 1-based line and column. */
export interface CodeError {
  message: string
  line: number
  column: number
}

function splitConfig<O extends object>(config: CodeFieldConfig<O>, keys: readonly string[], fieldType: string, extra: object = {}) {
  const fieldConfig: Record<string, unknown> = {}
  const options: Record<string, unknown> = { ...extra }
  for (const [key, value] of Object.entries(config)) {
    if (keys.includes(key)) options[key] = value
    else fieldConfig[key] = value
  }
  return field({ ...(fieldConfig as CmsFieldConfig), fieldType, customData: { code: options } satisfies CodeCustomData })
}

const CODE_OPTION_KEYS = ['language', 'lineNumbers', 'tabSize', 'rows'] as const

/** `Invalid JSON on line 3: Expected ',' or '}'`. */
export function formatCodeError(error: CodeError, language: string | undefined): string {
  return `Invalid ${CODE_LANGUAGES[normalizeLanguage(language)]} on line ${error.line}: ${error.message}`
}

function checkSyntax(language: string | undefined) {
  return (code: string, ctx: { addIssue: (issue: { code: 'custom'; message: string }) => void }) => {
    const error = validateCode(code, language)
    if (error) ctx.addIssue({ code: 'custom', message: formatCodeError(error, language) })
  }
}

/**
 * A string edited as code, with highlighting, line numbers and indentation. JSON and YAML are
 * checked for syntax errors before saving.
 *
 * ```ts
 * config: code({ label: 'Settings', language: 'json' }).optional()
 * ```
 */
export function code(config: CodeFieldConfig = {}) {
  return z.string().superRefine(checkSyntax(config.language)).check(splitConfig(config, CODE_OPTION_KEYS, 'code'))
}

/** A code snippet whose language editors pick: `{ language, code }`. */
export interface CodeBlock {
  language: CodeLanguage
  code: string
}

/**
 * Code with a language picker, stored as `{ language, code }`, for snippets in documentation.
 * `languages` lists the choices; the first one is the default.
 */
export function codeBlock(config: CodeFieldConfig<Omit<CodeOptions, 'language'> & { languages?: CodeLanguage[] }> = {}) {
  const languages = config.languages?.length ? config.languages : (Object.keys(CODE_LANGUAGES) as CodeLanguage[])
  // Checked here rather than with z.enum, so the message shows on the field itself.
  return z
    .object({ language: z.string().default(languages[0]), code: z.string().default('') })
    .superRefine((value, ctx) => {
      if (!(languages as string[]).includes(value.language)) {
        ctx.addIssue({ code: 'custom', message: `Choose one of ${languages.map((name) => CODE_LANGUAGES[name]).join(', ')}` })
        return
      }
      checkSyntax(value.language)(value.code, ctx)
    })
    .check(splitConfig({ ...config, languages }, [...CODE_OPTION_KEYS, 'languages'], 'code')) as unknown as z.ZodType<CodeBlock>
}

/** Options of a mermaid field: those of a code field, without the language. */
export type MermaidOptions = Omit<CodeOptions, 'language'>

/**
 * A [Mermaid](https://mermaid.js.org) diagram, stored as its source text, edited with a live
 * preview. The preview needs `gitvfs-cms/mermaid`; see the docs.
 */
export function mermaid(config: CodeFieldConfig<MermaidOptions> = {}) {
  return z.string().check(splitConfig(config, CODE_OPTION_KEYS, 'mermaid', { language: 'mermaid' }))
}

// --- Syntax checks -------------------------------------------------------------------------------

/** 1-based line and column of an offset. */
export function lineColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 }
}

class JsonSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message)
  }
}

/**
 * Check JSON syntax, with a position and message that read the same in every browser
 * (`JSON.parse` messages differ per engine, and some have no position).
 */
export function validateJson(source: string): CodeError | undefined {
  if (source.trim() === '') return undefined
  let position = 0
  const fail = (message: string, at = position): never => {
    throw new JsonSyntaxError(message, at)
  }
  const describe = () => (position >= source.length ? 'end of input' : `'${source[position]}'`)
  const skipSpace = () => {
    while (position < source.length && ' \t\n\r'.includes(source[position])) position++
  }
  const expect = (char: string, message: string) => {
    skipSpace()
    if (source[position] !== char) fail(message)
    position++
  }

  const string = () => {
    const start = position++
    for (;;) {
      const char = source[position]
      if (char === undefined || char === '\n') fail('Unterminated string', start)
      if (char === '"') {
        position++
        return
      }
      if (char === '\\') {
        const escape = source[position + 1]
        if (escape !== undefined && '"\\/bfnrt'.includes(escape)) position += 2
        else if (escape === 'u' && /^[\da-fA-F]{4}$/.test(source.slice(position + 2, position + 6))) position += 6
        else fail('Invalid escape in string')
      } else if (char < ' ') {
        fail('Control character in string; use an escape such as \\t')
      } else {
        position++
      }
    }
  }

  const number = () => {
    const pattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
    pattern.lastIndex = position
    const match = pattern.exec(source)
    if (!match || /[\d.eE+-]/.test(source[position + match[0].length] ?? '')) fail('Invalid number')
    position += match![0].length
  }

  const value = (depth: number): void => {
    if (depth > 512) fail('Nested too deeply')
    skipSpace()
    const char = source[position]
    if (char === '{') {
      position++
      skipSpace()
      if (source[position] === '}') {
        position++
        return
      }
      for (;;) {
        skipSpace()
        if (source[position] !== '"') fail(source[position] === '}' ? 'Trailing comma' : 'Expected a property name in double quotes')
        string()
        expect(':', "Expected ':' after the property name")
        value(depth + 1)
        skipSpace()
        if (source[position] === '}') {
          position++
          return
        }
        if (source[position] !== ',') fail(`Expected ',' or '}' but found ${describe()}`)
        position++
      }
    }
    if (char === '[') {
      position++
      skipSpace()
      if (source[position] === ']') {
        position++
        return
      }
      for (;;) {
        skipSpace()
        if (source[position] === ']') fail('Trailing comma')
        value(depth + 1)
        skipSpace()
        if (source[position] === ']') {
          position++
          return
        }
        if (source[position] !== ',') fail(`Expected ',' or ']' but found ${describe()}`)
        position++
      }
    }
    if (char === '"') return string()
    if (char === '-' || (char >= '0' && char <= '9')) return number()
    for (const literal of ['true', 'false', 'null']) {
      if (source.startsWith(literal, position)) {
        position += literal.length
        return
      }
    }
    if (char === "'") fail('Strings need double quotes')
    if (char === '/') fail('JSON has no comments')
    fail(`Unexpected ${describe()}`)
  }

  try {
    value(0)
    skipSpace()
    if (position < source.length) fail(`Unexpected ${describe()} after the value`)
    return undefined
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error
    return { message: error.message, ...lineColumn(source, Math.min(error.offset, source.length)) }
  }
}

/** Check YAML syntax with the parser the CMS reads files with. */
export function validateYaml(source: string): CodeError | undefined {
  const error = parseDocument(source, { prettyErrors: false }).errors[0]
  if (!error) return undefined
  return { message: error.message, ...lineColumn(source, error.pos[0]) }
}

/** The first syntax error in `source`, for the languages the editor checks (JSON and YAML). */
export function validateCode(source: string, language: string | undefined): CodeError | undefined {
  switch (normalizeLanguage(language)) {
    case 'json':
      return validateJson(source)
    case 'yaml':
      return validateYaml(source)
    default:
      return undefined
  }
}

// --- Editing -------------------------------------------------------------------------------------

/** A replacement of `from`..`to` with `insert`, and the selection after it. */
export interface TextEdit {
  from: number
  to: number
  insert: string
  selectionStart: number
  selectionEnd: number
}

export function applyTextEdit(value: string, edit: TextEdit): string {
  return value.slice(0, edit.from) + edit.insert + value.slice(edit.to)
}

const lineStartOf = (value: string, position: number) => value.lastIndexOf('\n', position - 1) + 1

/** The lines a selection touches. A selection that ends at the start of a line leaves that line out. */
function selectedLines(value: string, start: number, end: number) {
  const from = lineStartOf(value, start)
  const last = end > start && lineStartOf(value, end) === end ? end - 1 : end
  const lineEnd = value.indexOf('\n', last)
  const to = lineEnd === -1 ? value.length : lineEnd
  return { from, to, lines: value.slice(from, to).split('\n') }
}

/**
 * Edit every selected line, where `change` returns how many characters to remove from the start of
 * the line and what to put there. Selection ends move with the text around them.
 */
function editLines(
  value: string,
  start: number,
  end: number,
  change: (line: string) => { remove: number; insert: string },
): TextEdit {
  const { from, to, lines } = selectedLines(value, start, end)
  const changes: Array<{ at: number; remove: number; insert: string }> = []
  let at = from
  for (const line of lines) {
    changes.push({ at, ...change(line) })
    at += line.length + 1
  }
  const map = (position: number, stayAtLineStart: boolean) => {
    let delta = 0
    for (const { at: lineStart, remove, insert } of changes) {
      if (position < lineStart || (position === lineStart && stayAtLineStart)) break
      delta += insert.length - Math.min(remove, position - lineStart)
    }
    return position + delta
  }
  const insert = lines
    .map((line, index) => changes[index].insert + line.slice(changes[index].remove))
    .join('\n')
  return {
    from,
    to,
    insert,
    // A selection that starts at the start of a line keeps the whole line selected.
    selectionStart: map(start, start !== end),
    selectionEnd: map(end, false),
  }
}

/**
 * Tab: insert spaces up to the next tab stop, or indent every selected line when the selection
 * spans more than one line.
 */
export function indentSelection(value: string, start: number, end: number, tabSize = 2): TextEdit {
  if (!value.slice(start, end).includes('\n')) {
    const column = start - lineStartOf(value, start)
    const insert = ' '.repeat(tabSize - (column % tabSize))
    const caret = start + insert.length
    return { from: start, to: end, insert, selectionStart: caret, selectionEnd: caret }
  }
  const unit = ' '.repeat(tabSize)
  return editLines(value, start, end, (line) => ({ remove: 0, insert: line.trim() === '' ? '' : unit }))
}

/** Shift+Tab: remove one level of indentation (up to `tabSize` spaces, or a tab) from each selected line. */
export function outdentSelection(value: string, start: number, end: number, tabSize = 2): TextEdit {
  return editLines(value, start, end, (line) => {
    if (line.startsWith('\t')) return { remove: 1, insert: '' }
    return { remove: Math.min(tabSize, /^ */.exec(line)![0].length), insert: '' }
  })
}

const BRACKETS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }

/**
 * Enter: start the new line at the indentation of the current one, one level deeper after an
 * opening bracket (or a trailing `:` in YAML and Python), with the closing bracket on its own line.
 */
export function insertNewline(value: string, start: number, end: number, tabSize = 2, language?: string): TextEdit {
  const lineStart = lineStartOf(value, start)
  const before = value.slice(lineStart, start)
  const indent = /^[ \t]*/.exec(before)![0]
  const unit = ' '.repeat(tabSize)
  const last = before.trimEnd().slice(-1)
  const opens = last in BRACKETS || (last === ':' && ['yaml', 'python'].includes(normalizeLanguage(language)))
  const inner = '\n' + indent + (opens ? unit : '')
  const spaces = /^[ \t]*/.exec(value.slice(end))![0].length
  const closes = last in BRACKETS && value[end + spaces] === BRACKETS[last]
  const caret = start + inner.length
  // `{|}` becomes three lines; the spaces before the closing bracket would otherwise start its line.
  if (closes) return { from: start, to: end + spaces, insert: inner + '\n' + indent, selectionStart: caret, selectionEnd: caret }
  return { from: start, to: end, insert: inner, selectionStart: caret, selectionEnd: caret }
}
