// A tiny tokenizer for syntax highlighting in the code editor. It colors what helps reading
// (strings, comments, numbers, keywords, keys, punctuation) and never fails: anything a grammar
// does not recognize is plain text. Strings and line comments stop at the end of the line, so an
// unfinished string only miscolors one line while someone types.

/** Languages the code editor knows by name. Other names edit as plain text. */
export type CodeLanguage =
  | 'text'
  | 'js'
  | 'ts'
  | 'json'
  | 'yaml'
  | 'css'
  | 'html'
  | 'shell'
  | 'python'
  | 'sql'
  | 'mermaid'

/** Display names of the code languages, in the order a language picker lists them. */
export const CODE_LANGUAGES: Record<CodeLanguage, string> = {
  text: 'Plain text',
  ts: 'TypeScript',
  js: 'JavaScript',
  json: 'JSON',
  yaml: 'YAML',
  css: 'CSS',
  html: 'HTML',
  shell: 'Shell',
  python: 'Python',
  sql: 'SQL',
  mermaid: 'Mermaid',
}

const ALIASES: Record<string, CodeLanguage> = {
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  typescript: 'ts',
  tsx: 'ts',
  yml: 'yaml',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  plain: 'text',
  txt: 'text',
}

/** The language for a name or common alias (`typescript`, `yml`, `bash`); unknown names are `text`. */
export function normalizeLanguage(name: string | undefined): CodeLanguage {
  const key = (name ?? '').trim().toLowerCase()
  if (key in CODE_LANGUAGES) return key as CodeLanguage
  return ALIASES[key] ?? 'text'
}

export type TokenType =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'literal'
  | 'property'
  | 'tag'
  | 'variable'
  | 'punctuation'

export interface Token {
  type: TokenType
  text: string
}

/** A pattern (sticky regex, or a function returning the match length) and the type it produces. */
type Matcher = RegExp | ((source: string, position: number) => number)
/** Optionally enter a state (`'tag'`) or leave the current one (`'pop'`) after the match. */
type Rule = [Matcher, TokenType | ((text: string) => TokenType), string?]
type Grammar = Record<string, Rule[]> & { main: Rule[] }

const words = (list: string) => new Set(list.split(' '))

function word(keywords: Set<string>, literals: Set<string> = new Set(), ignoreCase = false) {
  return (text: string): TokenType => {
    const key = ignoreCase ? text.toUpperCase() : text
    if (keywords.has(key)) return 'keyword'
    return literals.has(key) ? 'literal' : 'plain'
  }
}

const space: Rule = [/\s+/y, 'plain']
const blockComment: Rule = [/\/\*[\s\S]*?(?:\*\/|$)/y, 'comment']
const doubleQuoted: Rule = [/"(?:\\.|[^"\\\n])*"?/y, 'string']
const singleQuoted: Rule = [/'(?:\\.|[^'\\\n])*'?/y, 'string']
/** `#` starts a comment only at the start of a line or after whitespace (`a#b` is a word). */
const hashComment: Rule = [/(?<=^|\s)#.*/my, 'comment']
const decimal: Rule = [/(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/y, 'number']

const JS_KEYWORDS = words(
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield',
)

const js: Grammar = {
  main: [
    space,
    [/\/\/.*/y, 'comment'],
    blockComment,
    singleQuoted,
    doubleQuoted,
    [/`(?:\\[\s\S]|[^`\\])*`?/y, 'string'],
    [/0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?/y, 'number'],
    [/(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?/y, 'number'],
    [/[A-Za-z_$][\w$]*/y, word(JS_KEYWORDS, words('true false null undefined NaN Infinity'))],
    [/[{}()[\];,.:?<>=+\-*/%&|^!~@#]/y, 'punctuation'],
  ],
}

const json: Grammar = {
  main: [
    space,
    [/"(?:\\.|[^"\\\n])*"(?=\s*:)/y, 'property'],
    doubleQuoted,
    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, 'number'],
    [/(?:true|false|null)(?![\w$])/y, 'literal'],
    [/[{}[\],:]/y, 'punctuation'],
  ],
}

/**
 * A YAML block scalar (`|` or `>`) with its indented lines, so the text inside is not read as keys.
 * Returns the length of the scalar, or 0 when `|`/`>` at `position` does not start one.
 */
function yamlBlockScalar(source: string, position: number): number {
  const header = /[|>][-+\d]*[ \t]*(?:#.*)?(?=\n|$)/y
  header.lastIndex = position
  if (!header.test(source)) return 0
  const lineStart = source.lastIndexOf('\n', position - 1) + 1
  const before = source.slice(lineStart, position)
  // Only as a value: after `key:`, `- ` or `? `, or on a line of its own.
  if (!/(?:^|[:\-?])[ \t]*$/.test(before)) return 0
  const parentIndent = /^[ \t]*/.exec(before)![0].length
  let end = header.lastIndex
  while (end < source.length) {
    const next = source.indexOf('\n', end + 1)
    const line = source.slice(end + 1, next === -1 ? source.length : next)
    if (line.trim() !== '' && /^ */.exec(line)![0].length <= parentIndent) break
    end = next === -1 ? source.length : next
  }
  return end - position
}

/** A value that ends here: before a comment, a flow separator or the end of the line. */
const yamlScalarEnd = String.raw`(?=[ \t]*(?:#|,|\]|\}|$))`

const yaml: Grammar = {
  main: [
    space,
    hashComment,
    [/^(?:---|\.\.\.)(?=\s|$)/my, 'punctuation'],
    [yamlBlockScalar, 'string'],
    // Keys: at the start of a line (after `- ` items), or in a flow mapping.
    [
      /(?<=^[ \t]*(?:-[ \t]+)*|[{,][ \t]*)(?:"(?:\\.|[^"\\\n])*"|'(?:''|[^'\n])*'|[^\s#'"&*!|>%@`,[\]{}-][^\n#]*?|-[^\s#,[\]{}][^\n#]*?)(?=[ \t]*:(?:\s|$))/my,
      'property',
    ],
    [/"(?:\\.|[^"\\\n])*"?/y, 'string'],
    [/'(?:''|[^'\n])*'?/y, 'string'],
    [/[&*][^\s,[\]{}]+/y, 'variable'],
    [/![^\s,[\]{}]*/y, 'keyword'],
    [new RegExp(String.raw`[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?` + yamlScalarEnd, 'my'), 'number'],
    [new RegExp(String.raw`(?:true|false|null|True|False|Null|TRUE|FALSE|NULL|~)` + yamlScalarEnd, 'my'), 'literal'],
    [/-(?=\s|$)|[:?](?=\s|$)|[,[\]{}]/my, 'punctuation'],
    [/[^\s,[\]{}]+/y, 'plain'],
  ],
}

const css: Grammar = {
  // Outside braces: selectors and at-rules.
  main: [
    space,
    blockComment,
    doubleQuoted,
    singleQuoted,
    [/@[\w-]+/y, 'keyword'],
    [/\{/y, 'punctuation', 'block'],
    [/\}/y, 'punctuation', 'pop'],
    [/::?[\w-]+|[.#]?[\w-]+|\*/y, 'tag'],
    [/[>+~,()[\]=]/y, 'punctuation'],
  ],
  // Inside braces: declarations.
  block: [
    space,
    blockComment,
    doubleQuoted,
    singleQuoted,
    [/[\w-]+(?=\s*:)/y, 'property'],
    [/#[\da-fA-F]{3,8}(?![\w-])/y, 'number'],
    [/-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y, 'number'],
    [/!important|@[\w-]+/y, 'keyword'],
    [/[\w-]+/y, 'plain'],
    [/\{/y, 'punctuation', 'block'],
    [/\}/y, 'punctuation', 'pop'],
    [/[:;,()/*+>]/y, 'punctuation'],
  ],
}

const html: Grammar = {
  main: [
    [/<!--[\s\S]*?(?:-->|$)/y, 'comment'],
    [/<![^>]*>?/y, 'keyword'],
    [/<\/?[A-Za-z][\w:.-]*/y, 'tag', 'tag'],
    [/&(?:#\d+|#x[\da-fA-F]+|\w+);/y, 'literal'],
    [/[^<&]+/y, 'plain'],
  ],
  tag: [
    space,
    [/\/?>/y, 'tag', 'pop'],
    [/[^\s"'>/=]+/y, 'property'],
    [/=/y, 'punctuation'],
    [/"[^"]*"?|'[^']*'?/y, 'string'],
  ],
}

const shell: Grammar = {
  main: [
    space,
    hashComment,
    [/'[^']*'?/y, 'string'],
    [/"(?:\\[\s\S]|[^"\\])*"?/y, 'string'],
    [/\$(?:\{[^}\n]*\}?|\w+|[@*#?$!\d-])/y, 'variable'],
    [/[A-Za-z_][\w-]*/y, word(words('if then else elif fi for while until do done case esac in function return local export readonly declare select break continue exit'))],
    [/\d+(?![\w.])/y, 'number'],
    [/[|&;<>()[\]{}=]/y, 'punctuation'],
  ],
}

const python: Grammar = {
  main: [
    space,
    [/#.*/y, 'comment'],
    [/[rRbBuUfF]{0,2}("""|''')[\s\S]*?(?:\1|$)/y, 'string'],
    [/[rRbBuUfF]{0,2}(?:'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?)/y, 'string'],
    [/@[\w.]+/y, 'keyword'],
    decimal,
    [
      /[A-Za-z_]\w*/y,
      word(
        words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield'),
        words('True False None'),
      ),
    ],
    [/[{}()[\];,.:=+\-*/%&|^~<>!@]/y, 'punctuation'],
  ],
}

const sql: Grammar = {
  main: [
    space,
    [/--.*/y, 'comment'],
    blockComment,
    [/'(?:''|[^'])*'?/y, 'string'],
    [/"(?:""|[^"])*"?|`[^`]*`?/y, 'property'],
    decimal,
    [
      /[A-Za-z_]\w*/y,
      word(
        words('ADD ALL ALTER AND AS ASC BETWEEN BY CASE CHECK COLUMN CONSTRAINT CREATE CROSS DEFAULT DELETE DESC DISTINCT DROP ELSE END EXISTS FOREIGN FROM FULL GROUP HAVING IF IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT OFFSET ON OR ORDER OUTER PRIMARY REFERENCES RETURNING RIGHT SELECT SET TABLE THEN UNION UNIQUE UPDATE USING VALUES VIEW WHEN WHERE WITH'),
        words('NULL TRUE FALSE'),
        true,
      ),
    ],
    [/[(),;.*=<>!+\-/%]/y, 'punctuation'],
  ],
}

const mermaid: Grammar = {
  main: [
    space,
    [/%%.*/y, 'comment'],
    [/"[^"\n]*"?/y, 'string'],
    // Node and edge labels: `A[Label]`, `B(Label)`, `C{Label}`, `-->|label|`.
    [/\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}|\|[^|\n]*\|/y, 'string'],
    [
      /[A-Za-z_][\w]*(?:-v2|-beta)?/y,
      word(
        words(
          'graph flowchart sequenceDiagram classDiagram stateDiagram stateDiagram-v2 erDiagram gantt pie journey gitGraph mindmap timeline quadrantChart requirementDiagram sankey-beta xychart-beta block-beta subgraph end direction TB TD BT RL LR participant actor note over left right of loop alt else opt par and critical break rect activate deactivate autonumber class classDef style linkStyle click title section dateFormat axisFormat state as',
        ),
      ),
    ],
    decimal,
    [/[-=.<>~*+:;,&]/y, 'punctuation'],
  ],
}

const GRAMMARS: Partial<Record<CodeLanguage, Grammar>> = {
  js,
  ts: js,
  json,
  yaml,
  css,
  html,
  shell,
  python,
  sql,
  mermaid,
}

function matchLength(matcher: Matcher, source: string, position: number): number {
  if (typeof matcher === 'function') return matcher(source, position)
  matcher.lastIndex = position
  return matcher.exec(source)?.[0].length ?? 0
}

/**
 * Split `source` into highlighted tokens. Joining the token texts gives back `source` exactly;
 * neighbouring tokens of the same type are merged.
 */
export function tokenize(source: string, language: string | undefined): Token[] {
  const grammar = GRAMMARS[normalizeLanguage(language)]
  if (!grammar) return source ? [{ type: 'plain', text: source }] : []

  const tokens: Token[] = []
  const add = (type: TokenType, text: string) => {
    const last = tokens[tokens.length - 1]
    if (last?.type === type) last.text += text
    else tokens.push({ type, text })
  }

  const states = ['main']
  let position = 0
  while (position < source.length) {
    let matched = false
    for (const [matcher, type, action] of grammar[states[states.length - 1]]) {
      const length = matchLength(matcher, source, position)
      if (length === 0) continue
      const text = source.slice(position, position + length)
      add(typeof type === 'function' ? type(text) : type, text)
      position += length
      if (action === 'pop') {
        if (states.length > 1) states.pop()
      } else if (action) {
        states.push(action)
      }
      matched = true
      break
    }
    if (!matched) {
      add('plain', source[position])
      position++
    }
  }
  return tokens
}
