import { parseSchema } from '@autoform/core'
import { ZodProvider } from '@autoform/zod'
import { z } from 'zod'
import {
  applyTextEdit,
  code,
  codeBlock,
  indentSelection,
  insertNewline,
  mermaid,
  normalizeLanguage,
  outdentSelection,
  tokenize,
  validateCode,
  validateJson,
  type TextEdit,
} from '../src'

/** Tokens as `type:text` pairs, with plain text split into words. */
function tokens(source: string, language: string): string[] {
  return tokenize(source, language).flatMap((token) =>
    token.type === 'plain'
      ? token.text.split(/\s+/).filter(Boolean).map((text) => `plain:${text}`)
      : [`${token.type}:${token.text}`],
  )
}

describe('tokenize', () => {
  it('gives back the source exactly, for every language', () => {
    const samples = [
      'const a = "x" // y\n/* z */ `t${1}`',
      '{"a": [1, -2.5e3, true, null], "b": "\\"q\\""}',
      'key: value # note\nlist:\n  - "one"\n  - two\ntext: |\n  a: b\n  # not a comment\nnext: 1\n',
      'a:hover > .b { color: #fff; margin: 0 1.5rem !important; }',
      '<!doctype html><p class="x" hidden>Hi &amp; bye</p><!-- c -->',
      'echo "$HOME" ${PATH} # comment\nif [ -n "$x" ]; then exit 1; fi',
      'def f(x):\n    """doc\n    string"""\n    return None  # done',
      "SELECT name FROM users WHERE id = 1 -- why\nAND note = 'it''s'",
      'flowchart LR\n  A[Start] -->|go| B{Choice}\n  %% a comment\n  B --> C("End")',
      'unterminated "string\nnext line',
      '',
    ]
    for (const language of ['ts', 'json', 'yaml', 'css', 'html', 'shell', 'python', 'sql', 'mermaid', 'text', 'nope']) {
      for (const sample of samples) {
        expect(tokenize(sample, language).map((token) => token.text).join('')).toBe(sample)
      }
    }
  })

  it('highlights TypeScript', () => {
    expect(tokens('const n: number = 0x1F // hex\nreturn "a\\"b" + `c`', 'ts')).toEqual([
      'keyword:const',
      'plain:n',
      'punctuation::',
      'plain:number',
      'punctuation:=',
      'number:0x1F',
      'comment:// hex',
      'keyword:return',
      'string:"a\\"b"',
      'punctuation:+',
      'string:`c`',
    ])
    expect(tokens('/* a\nb */ x2 = true', 'js')).toEqual(['comment:/* a\nb */', 'plain:x2', 'punctuation:=', 'literal:true'])
  })

  it('stops an unterminated string at the end of its line', () => {
    expect(tokens('a = "open\nb = 1', 'js')).toEqual(['plain:a', 'punctuation:=', 'string:"open', 'plain:b', 'punctuation:=', 'number:1'])
  })

  it('highlights JSON keys and values', () => {
    expect(tokens('{"a": "b", "n": -1.5, "t": true}', 'json')).toEqual([
      'punctuation:{',
      'property:"a"',
      'punctuation::',
      'string:"b"',
      'punctuation:,',
      'property:"n"',
      'punctuation::',
      'number:-1.5',
      'punctuation:,',
      'property:"t"',
      'punctuation::',
      'literal:true',
      'punctuation:}',
    ])
  })

  it('highlights YAML keys, scalars, comments and block scalars', () => {
    expect(tokens('title: Hello: world # c\n- name: "x"\ncount: 3\nok: true\nurl: http://a#b', 'yaml')).toEqual([
      'property:title',
      'punctuation::',
      'plain:Hello:',
      'plain:world',
      'comment:# c',
      'punctuation:-',
      'property:name',
      'punctuation::',
      'string:"x"',
      'property:count',
      'punctuation::',
      'number:3',
      'property:ok',
      'punctuation::',
      'literal:true',
      'property:url',
      'punctuation::',
      'plain:http://a#b',
    ])
    // Text in a block scalar is a string, not keys and comments, until the indentation ends.
    expect(tokens('body: |\n  key: x\n  # y\n\n  z\nnext: 1', 'yaml')).toEqual([
      'property:body',
      'punctuation::',
      'string:|\n  key: x\n  # y\n\n  z',
      'property:next',
      'punctuation::',
      'number:1',
    ])
    expect(tokens('version: 1.2.3', 'yaml')).toEqual(['property:version', 'punctuation::', 'plain:1.2.3'])
  })

  it('tells CSS selectors from declarations', () => {
    expect(tokens('a:hover { color: #fff; width: 10px }', 'css')).toEqual([
      'tag:a:hover',
      'punctuation:{',
      'property:color',
      'punctuation::',
      'number:#fff',
      'punctuation:;',
      'property:width',
      'punctuation::',
      'number:10px',
      'punctuation:}',
    ])
  })

  it('highlights HTML tags, attributes and entities', () => {
    expect(tokens('<a href="/x">A &amp; B</a>', 'html')).toEqual([
      'tag:<a',
      'property:href',
      'punctuation:=',
      'string:"/x"',
      'tag:>',
      'plain:A',
      'literal:&amp;',
      'plain:B',
      'tag:</a>',
    ])
  })

  it('highlights shell, Python, SQL and Mermaid', () => {
    expect(tokens('echo $HOME # x', 'bash')).toEqual(['plain:echo', 'variable:$HOME', 'comment:# x'])
    expect(tokens('def f(): return None', 'py')).toEqual([
      'keyword:def',
      'plain:f',
      'punctuation:():',
      'keyword:return',
      'literal:None',
    ])
    expect(tokens("select * from t where a = 'x'", 'sql')).toEqual([
      'keyword:select',
      'punctuation:*',
      'keyword:from',
      'plain:t',
      'keyword:where',
      'plain:a',
      'punctuation:=',
      "string:'x'",
    ])
    expect(tokens('graph TD\n  A[Go] --> B', 'mermaid')).toEqual([
      'keyword:graph',
      'keyword:TD',
      'plain:A',
      'string:[Go]',
      'punctuation:-->',
      'plain:B',
    ])
  })

  it('normalizes language names', () => {
    expect(normalizeLanguage('TypeScript')).toBe('ts')
    expect(normalizeLanguage('yml')).toBe('yaml')
    expect(normalizeLanguage('cobol')).toBe('text')
    expect(normalizeLanguage(undefined)).toBe('text')
  })
})

describe('validateJson', () => {
  it('agrees with JSON.parse', () => {
    const samples = [
      '{}',
      '[]',
      ' {"a": [1, 2, {"b": null}], "c": "\\u00e9\\n"} ',
      '0',
      '-0.5e-3',
      '"x"',
      'true',
      '{"a": 1,}',
      '[1, 2,]',
      '{a: 1}',
      "{'a': 1}",
      '{"a" 1}',
      '[1 2]',
      '01',
      '1.',
      '.5',
      '-',
      '"a\tb"',
      '"\\x"',
      '"\\u12"',
      '[1] 2',
      'nul',
      '{"a": 1 // c\n}',
      '[',
      '{"a":',
      '"open',
    ]
    for (const sample of samples) {
      let valid = true
      try {
        JSON.parse(sample)
      } catch {
        valid = false
      }
      expect(validateJson(sample) === undefined, sample).toBe(valid)
    }
  })

  it('reports the line and column of the error', () => {
    expect(validateJson('{\n  "a": 1\n  "b": 2\n}')).toEqual({ message: "Expected ',' or '}' but found '\"'", line: 3, column: 3 })
    expect(validateJson('[\n  1,\n]')).toEqual({ message: 'Trailing comma', line: 3, column: 1 })
    expect(validateJson("{'a': 1}")).toMatchObject({ message: 'Expected a property name in double quotes', line: 1, column: 2 })
    expect(validateJson('{"a": "x\n"}')).toMatchObject({ message: 'Unterminated string', line: 1, column: 7 })
    expect(validateJson('{"a": 1}\n// end')).toMatchObject({ line: 2, column: 1 })
  })

  it('accepts empty text', () => {
    expect(validateJson('  \n')).toBeUndefined()
  })
})

describe('validateCode', () => {
  it('checks YAML with the parser the CMS uses', () => {
    expect(validateCode('a: 1\nb: [1, 2\n', 'yaml')).toMatchObject({ line: 3 })
    expect(validateCode('a: 1\na: 2\n', 'yml')).toMatchObject({ message: 'Map keys must be unique', line: 2, column: 1 })
    expect(validateCode('a: 1\nb:\n  - 2\n', 'yaml')).toBeUndefined()
  })

  it('does not check other languages', () => {
    expect(validateCode('this is { not', 'ts')).toBeUndefined()
  })
})

describe('code schemas', () => {
  it('rejects JSON with syntax errors, with the line', () => {
    const schema = code({ language: 'json' })
    expect(schema.parse('{"a": 1}')).toBe('{"a": 1}')
    const result = schema.safeParse('{\n"a": 1,\n}')
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe('Invalid JSON on line 3: Trailing comma')
    expect(code({ language: 'ts' }).parse('const {')).toBe('const {')
  })

  it('keeps editor options in customData', () => {
    const schema = z.object({
      config: code({ label: 'Config', language: 'yaml', tabSize: 4 }).optional(),
      diagram: mermaid({ rows: 12 }),
    })
    const [config, diagram] = parseSchema(new ZodProvider(schema)).fields
    expect(config.fieldConfig).toMatchObject({ label: 'Config', fieldType: 'code', customData: { code: { language: 'yaml', tabSize: 4 } } })
    expect(diagram.fieldConfig).toMatchObject({ fieldType: 'mermaid', customData: { code: { language: 'mermaid', rows: 12 } } })
    expect(schema.parse({ diagram: 'graph TD' })).toEqual({ diagram: 'graph TD' })
  })

  it('stores code blocks as { language, code }', () => {
    const schema = codeBlock({ languages: ['ts', 'json'] })
    expect(schema.parse({ code: 'let a' })).toEqual({ language: 'ts', code: 'let a' })
    expect(schema.safeParse({ language: 'json', code: '{' }).error?.issues[0].message).toMatch(/^Invalid JSON on line 1/)
    expect(schema.safeParse({ language: 'css', code: '' }).error?.issues[0].message).toBe('Choose one of TypeScript, JSON')
  })
})

describe('editing helpers', () => {
  /** Apply an edit to text where `|` marks the caret, or `[` and `]` the selection. */
  function run(marked: string, edit: (value: string, start: number, end: number) => TextEdit): string {
    const start = marked.search(/[|[]/)
    const end = marked.includes('[') ? marked.indexOf(']') - 1 : start
    const value = marked.replace(/[|[\]]/g, '')
    const result = edit(value, start, end)
    const next = applyTextEdit(value, result)
    if (result.selectionStart === result.selectionEnd) {
      return next.slice(0, result.selectionStart) + '|' + next.slice(result.selectionStart)
    }
    return next.slice(0, result.selectionStart) + '[' + next.slice(result.selectionStart, result.selectionEnd) + ']' + next.slice(result.selectionEnd)
  }

  it('Tab inserts spaces to the next tab stop', () => {
    expect(run('a|b', (v, s, e) => indentSelection(v, s, e, 2))).toBe('a |b')
    expect(run('ab|', (v, s, e) => indentSelection(v, s, e, 4))).toBe('ab  |')
    expect(run('a[bc]d', (v, s, e) => indentSelection(v, s, e, 2))).toBe('a |d')
  })

  it('Tab indents every selected line, skipping blank ones', () => {
    expect(run('x\na[b\n\nc]d\ny', (v, s, e) => indentSelection(v, s, e, 2))).toBe('x\n  a[b\n\n  c]d\ny')
    // A selection that ends at the start of a line leaves that line alone.
    expect(run('[a\nb\n]c', (v, s, e) => indentSelection(v, s, e, 2))).toBe('[  a\n  b\n]c')
  })

  it('Shift+Tab outdents the current or selected lines', () => {
    expect(run('    a|b', (v, s, e) => outdentSelection(v, s, e, 2))).toBe('  a|b')
    expect(run(' |a', (v, s, e) => outdentSelection(v, s, e, 2))).toBe('|a')
    expect(run('\ta|', (v, s, e) => outdentSelection(v, s, e, 4))).toBe('a|')
    expect(run('  [a\n    b\nc]', (v, s, e) => outdentSelection(v, s, e, 2))).toBe('[a\n  b\nc]')
    expect(run('a|', (v, s, e) => outdentSelection(v, s, e, 2))).toBe('a|')
  })

  it('Enter keeps the indentation', () => {
    expect(run('  a: 1|', (v, s, e) => insertNewline(v, s, e, 2, 'json'))).toBe('  a: 1\n  |')
    expect(run('    x[yz]', (v, s, e) => insertNewline(v, s, e, 2))).toBe('    x\n    |')
    expect(run('  |a', (v, s, e) => insertNewline(v, s, e, 2))).toBe('  \n  |a')
  })

  it('Enter indents after an opening bracket and splits a bracket pair', () => {
    expect(run('  f(|', (v, s, e) => insertNewline(v, s, e, 2))).toBe('  f(\n    |')
    expect(run('{|}', (v, s, e) => insertNewline(v, s, e, 2))).toBe('{\n  |\n}')
    expect(run('  f(| )', (v, s, e) => insertNewline(v, s, e, 4))).toBe('  f(\n      |\n  )')
  })

  it('Enter indents after a trailing colon in YAML and Python only', () => {
    expect(run('items:|', (v, s, e) => insertNewline(v, s, e, 2, 'yaml'))).toBe('items:\n  |')
    expect(run('  if x:|', (v, s, e) => insertNewline(v, s, e, 4, 'python'))).toBe('  if x:\n      |')
    expect(run('a:|', (v, s, e) => insertNewline(v, s, e, 2, 'ts'))).toBe('a:\n|')
  })
})
