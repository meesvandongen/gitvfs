import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { github } from '../../src/providers/github'
import type { GitProvider } from '../../src/types/provider'
import { NotFoundError, AuthError, RateLimitError, GitFSError } from '../../src/types/errors'

const BASE = 'https://api.github.com'
const GQL = `${BASE}/graphql`

function restUrl(path: string) {
  return `${BASE}${path}`
}

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('GitHub Provider', () => {
  let provider: GitProvider

  beforeAll(() => {
    provider = github({ token: 'test-token', owner: 'acme', repo: 'website' })
  })

  // ─── getTree ───────────────────────────────────────────────

  describe('getTree', () => {
    it('fetches recursive tree via REST (ref → commit → tree)', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ object: { sha: 'commit-sha-1' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/commits/commit-sha-1'), () =>
          HttpResponse.json({ tree: { sha: 'tree-sha-1' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/trees/tree-sha-1'), () =>
          HttpResponse.json({
            tree: [
              { path: 'readme.md', type: 'blob', sha: 'abc123', size: 42 },
              { path: 'src', type: 'tree', sha: 'def456' },
              { path: 'src/index.ts', type: 'blob', sha: 'ghi789', size: 100 },
            ],
          }),
        ),
      )

      const tree = await provider.getTree('main')

      expect(tree).toHaveLength(3)
      expect(tree[0]).toEqual({ path: 'readme.md', type: 'blob', sha: 'abc123', size: 42 })
      expect(tree[1]).toEqual({ path: 'src', type: 'tree', sha: 'def456', size: undefined })
      expect(tree[2]).toEqual({ path: 'src/index.ts', type: 'blob', sha: 'ghi789', size: 100 })
    })

    it('returns empty array for empty repo', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ object: { sha: 'c1' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/commits/c1'), () =>
          HttpResponse.json({ tree: { sha: 't1' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/trees/t1'), () =>
          HttpResponse.json({ tree: [] }),
        ),
      )

      const tree = await provider.getTree('main')
      expect(tree).toEqual([])
    })

    it('throws NotFoundError for missing branch', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/nonexistent'), () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      )

      await expect(provider.getTree('nonexistent')).rejects.toThrow(NotFoundError)
    })

    it('throws AuthError on 401', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
        ),
      )

      await expect(provider.getTree('main')).rejects.toThrow(AuthError)
    })

    it('throws AuthError on 403', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
        ),
      )

      await expect(provider.getTree('main')).rejects.toThrow(AuthError)
    })

    it('throws RateLimitError on 429', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json(
            { message: 'rate limit' },
            { status: 429, headers: { 'Retry-After': '30' } },
          ),
        ),
      )

      const err = await provider.getTree('main').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RateLimitError)
      expect((err as RateLimitError).retryAfter).toBe(30)
    })

    it('throws GitFSError on 500', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.text('Internal Server Error', { status: 500 }),
        ),
      )

      await expect(provider.getTree('main')).rejects.toThrow(GitFSError)
    })
  })

  // ─── getFiles ──────────────────────────────────────────────

  describe('getFiles', () => {
    it('fetches multiple files via GraphQL', async () => {
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              repository: {
                f0: { text: '# Hello', oid: 'sha-1', byteSize: 7 },
                f1: { text: 'world', oid: 'sha-2', byteSize: 5 },
              },
            },
          }),
        ),
      )

      const files = await provider.getFiles('main', ['readme.md', 'hello.txt'])

      expect(files.size).toBe(2)
      const readme = files.get('readme.md')!
      expect(readme.path).toBe('readme.md')
      expect(readme.sha).toBe('sha-1')
      expect(readme.size).toBe(7)
      expect(new TextDecoder().decode(readme.content)).toBe('# Hello')
    })

    it('skips null entries (binary or missing files)', async () => {
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              repository: {
                f0: { text: 'content', oid: 'sha-1', byteSize: 7 },
                f1: null,
              },
            },
          }),
        ),
      )

      const files = await provider.getFiles('main', ['text.md', 'image.png'])

      expect(files.size).toBe(1)
      expect(files.has('text.md')).toBe(true)
      expect(files.has('image.png')).toBe(false)
    })

    it('skips entries with null text', async () => {
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              repository: {
                f0: { text: null, oid: 'sha-1', byteSize: 1024 },
              },
            },
          }),
        ),
      )

      const files = await provider.getFiles('main', ['binary.bin'])
      expect(files.size).toBe(0)
    })

    it('handles empty path list', async () => {
      const files = await provider.getFiles('main', [])
      expect(files.size).toBe(0)
    })

    it('chunks requests by 250', async () => {
      const calls: string[] = []
      server.use(
        http.post(GQL, async ({ request }) => {
          const body = (await request.json()) as { query: string }
          calls.push(body.query)
          const fields: Record<string, unknown> = {}
          const matches = body.query.match(/f\d+/g) || []
          for (const f of matches) {
            fields[f] = { text: 'x', oid: `sha-${f}`, byteSize: 1 }
          }
          return HttpResponse.json({ data: { repository: fields } })
        }),
      )

      const paths = Array.from({ length: 260 }, (_, i) => `file-${i}.txt`)
      await provider.getFiles('main', paths)

      expect(calls).toHaveLength(2) // 250 + 10
    })

    it('throws AuthError on GraphQL 401', async () => {
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
        ),
      )

      await expect(provider.getFiles('main', ['test.md'])).rejects.toThrow(AuthError)
    })

    it('throws on GraphQL errors', async () => {
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({ errors: [{ message: 'Something went wrong' }] }),
        ),
      )

      await expect(provider.getFiles('main', ['test.md'])).rejects.toThrow(GitFSError)
    })
  })

  // ─── getFile ───────────────────────────────────────────────

  describe('getFile', () => {
    it('fetches a single file via getFiles (GraphQL)', async () => {
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              repository: {
                f0: { text: '# Hello World', oid: 'sha-abc', byteSize: 13 },
              },
            },
          }),
        ),
      )

      const file = await provider.getFile('main', 'readme.md')
      expect(file.path).toBe('readme.md')
      expect(file.sha).toBe('sha-abc')
      expect(new TextDecoder().decode(file.content)).toBe('# Hello World')
    })

    it('throws NotFoundError for missing file', async () => {
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: { repository: { f0: null } },
          }),
        ),
      )

      await expect(provider.getFile('main', 'missing.md')).rejects.toThrow(NotFoundError)
    })
  })

  // ─── getBlob ───────────────────────────────────────────────

  describe('getBlob', () => {
    it('fetches blob by SHA with base64 decoding', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/blobs/abc123'), () =>
          HttpResponse.json({ content: 'SGVsbG8=', encoding: 'base64' }),
        ),
      )

      const blob = await provider.getBlob('abc123')
      expect(new TextDecoder().decode(blob)).toBe('Hello')
    })

    it('handles base64 content with newlines', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/blobs/abc123'), () =>
          HttpResponse.json({ content: 'SGVs\nbG8=', encoding: 'base64' }),
        ),
      )

      const blob = await provider.getBlob('abc123')
      expect(new TextDecoder().decode(blob)).toBe('Hello')
    })

    it('handles non-base64 (raw text) encoding', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/blobs/abc123'), () =>
          HttpResponse.json({ content: 'plain text', encoding: 'utf-8' }),
        ),
      )

      const blob = await provider.getBlob('abc123')
      expect(new TextDecoder().decode(blob)).toBe('plain text')
    })

    it('throws NotFoundError for missing blob', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/blobs/missing'), () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      )

      await expect(provider.getBlob('missing')).rejects.toThrow(NotFoundError)
    })
  })

  // ─── getBranch ─────────────────────────────────────────────

  describe('getBranch', () => {
    it('returns branch info', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ object: { sha: 'head-sha-1' } }),
        ),
      )

      const branch = await provider.getBranch('main')
      expect(branch).toEqual({ name: 'main', sha: 'head-sha-1' })
    })

    it('throws NotFoundError for missing branch', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/missing'), () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      )

      await expect(provider.getBranch('missing')).rejects.toThrow(NotFoundError)
    })
  })

  // ─── getLastCommitSha ─────────────────────────────────────

  describe('getLastCommitSha', () => {
    it('returns the head SHA via getBranch', async () => {
      server.use(
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ object: { sha: 'head-sha-999' } }),
        ),
      )

      const sha = await provider.getLastCommitSha('main')
      expect(sha).toBe('head-sha-999')
    })
  })

  // ─── createBranch ──────────────────────────────────────────

  describe('createBranch', () => {
    it('creates a ref via REST POST', async () => {
      server.use(
        http.post(restUrl('/repos/acme/website/git/refs'), async ({ request }) => {
          const body = (await request.json()) as { ref: string; sha: string }
          expect(body.ref).toBe('refs/heads/feature/new')
          expect(body.sha).toBe('from-sha')
          return HttpResponse.json({ object: { sha: 'from-sha' } }, { status: 201 })
        }),
      )

      const branch = await provider.createBranch('feature/new', 'from-sha')
      expect(branch).toEqual({ name: 'feature/new', sha: 'from-sha' })
    })

    it('sends correct authorization header', async () => {
      let authHeader: string | null = null
      server.use(
        http.post(restUrl('/repos/acme/website/git/refs'), ({ request }) => {
          authHeader = request.headers.get('Authorization')
          return HttpResponse.json({ object: { sha: 'sha1' } }, { status: 201 })
        }),
      )

      await provider.createBranch('test', 'sha1')
      expect(authHeader).toBe('Bearer test-token')
    })
  })

  // ─── deleteBranch ──────────────────────────────────────────

  describe('deleteBranch', () => {
    it('deletes a ref via REST DELETE', async () => {
      let deleteCalled = false
      server.use(
        http.delete(restUrl('/repos/acme/website/git/refs/heads/feature/old'), () => {
          deleteCalled = true
          return new HttpResponse(null, { status: 204 })
        }),
      )

      await provider.deleteBranch('feature/old')
      expect(deleteCalled).toBe(true)
    })

    it('throws NotFoundError when branch does not exist', async () => {
      server.use(
        http.delete(restUrl('/repos/acme/website/git/refs/heads/nonexistent'), () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      )

      await expect(provider.deleteBranch('nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  // ─── commit ────────────────────────────────────────────────

  describe('commit', () => {
    it('sends GraphQL mutation with additions', async () => {
      let gqlBody: Record<string, unknown> | null = null

      server.use(
        http.post(GQL, async ({ request }) => {
          gqlBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({
            data: {
              createCommitOnBranch: {
                commit: { oid: 'new-commit-sha', committedDate: '2024-01-01T00:00:00Z' },
              },
            },
          })
        }),
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ object: { sha: 'new-commit-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/commits/new-commit-sha'), () =>
          HttpResponse.json({ tree: { sha: 'new-tree-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/trees/new-tree-sha'), () =>
          HttpResponse.json({
            tree: [{ path: 'new-file.md', type: 'blob', sha: 'file-sha-1', size: 10 }],
          }),
        ),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Add file',
        changes: [{ action: 'create', path: 'new-file.md', content: '# New' }],
        expectedHeadOid: 'old-head',
      })

      expect(result.sha).toBe('new-commit-sha')
      expect(result.date).toBe('2024-01-01T00:00:00Z')
      expect(result.files['new-file.md'].sha).toBe('file-sha-1')

      const vars = (gqlBody as Record<string, Record<string, Record<string, unknown>>>).variables.input
      expect(vars.expectedHeadOid).toBe('old-head')
      expect(vars.message).toEqual({ headline: 'Add file' })
    })

    it('handles deletions', async () => {
      let gqlBody: Record<string, unknown> | null = null

      server.use(
        http.post(GQL, async ({ request }) => {
          gqlBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({
            data: {
              createCommitOnBranch: {
                commit: { oid: 'commit-sha', committedDate: '2024-01-01T00:00:00Z' },
              },
            },
          })
        }),
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ object: { sha: 'commit-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/commits/commit-sha'), () =>
          HttpResponse.json({ tree: { sha: 'tree-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/trees/tree-sha'), () =>
          HttpResponse.json({ tree: [] }),
        ),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Delete file',
        changes: [{ action: 'delete', path: 'old-file.md' }],
      })

      expect(result.sha).toBe('commit-sha')
      expect(result.files['old-file.md']).toBeUndefined()
      const vars = (gqlBody as Record<string, Record<string, Record<string, { deletions: unknown[] }>>>).variables.input
      expect(vars.fileChanges.deletions).toEqual([{ path: 'old-file.md' }])
    })

    it('handles moves (delete old + add new)', async () => {
      let gqlBody: Record<string, unknown> | null = null

      server.use(
        http.post(GQL, async ({ request }) => {
          gqlBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({
            data: {
              createCommitOnBranch: {
                commit: { oid: 'commit-sha', committedDate: '2024-01-01T00:00:00Z' },
              },
            },
          })
        }),
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ object: { sha: 'commit-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/commits/commit-sha'), () =>
          HttpResponse.json({ tree: { sha: 'tree-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/trees/tree-sha'), () =>
          HttpResponse.json({
            tree: [{ path: 'new-path.md', type: 'blob', sha: 'new-sha', size: 5 }],
          }),
        ),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Move file',
        changes: [{ action: 'move', path: 'new-path.md', previousPath: 'old-path.md', content: 'moved' }],
      })

      expect(result.files['new-path.md'].sha).toBe('new-sha')
      const vars = (gqlBody as Record<string, Record<string, Record<string, { deletions: unknown[]; additions: unknown[] }>>>).variables.input
      expect(vars.fileChanges.deletions).toEqual([{ path: 'old-path.md' }])
      expect(vars.fileChanges.additions).toHaveLength(1)
    })

    it('handles Uint8Array content', async () => {
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              createCommitOnBranch: {
                commit: { oid: 'commit-sha', committedDate: '2024-01-01T00:00:00Z' },
              },
            },
          }),
        ),
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ object: { sha: 'commit-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/commits/commit-sha'), () =>
          HttpResponse.json({ tree: { sha: 'tree-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/trees/tree-sha'), () =>
          HttpResponse.json({
            tree: [{ path: 'file.bin', type: 'blob', sha: 'bin-sha', size: 3 }],
          }),
        ),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Add binary',
        changes: [{ action: 'create', path: 'file.bin', content: new Uint8Array([1, 2, 3]) }],
      })

      expect(result.files['file.bin'].sha).toBe('bin-sha')
    })

    it('handles mixed additions and deletions', async () => {
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              createCommitOnBranch: {
                commit: { oid: 'commit-sha', committedDate: '2024-01-01T00:00:00Z' },
              },
            },
          }),
        ),
        http.get(restUrl('/repos/acme/website/git/ref/heads/main'), () =>
          HttpResponse.json({ object: { sha: 'commit-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/commits/commit-sha'), () =>
          HttpResponse.json({ tree: { sha: 'tree-sha' } }),
        ),
        http.get(restUrl('/repos/acme/website/git/trees/tree-sha'), () =>
          HttpResponse.json({
            tree: [
              { path: 'new.md', type: 'blob', sha: 'new-sha', size: 5 },
              { path: 'updated.md', type: 'blob', sha: 'upd-sha', size: 10 },
            ],
          }),
        ),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Multiple changes',
        changes: [
          { action: 'create', path: 'new.md', content: 'new' },
          { action: 'update', path: 'updated.md', content: 'updated' },
          { action: 'delete', path: 'removed.md' },
        ],
      })

      expect(result.files['new.md'].sha).toBe('new-sha')
      expect(result.files['updated.md'].sha).toBe('upd-sha')
      expect(result.files['removed.md']).toBeUndefined()
    })
  })

  // ─── Custom API URL ────────────────────────────────────────

  describe('custom apiUrl', () => {
    it('uses custom API URL for REST calls', async () => {
      const customProvider = github({
        token: 'test-token',
        owner: 'acme',
        repo: 'website',
        apiUrl: 'https://github.example.com/api/v3',
      })

      server.use(
        http.get('https://github.example.com/api/v3/repos/acme/website/git/ref/heads/main', () =>
          HttpResponse.json({ object: { sha: 'sha-1' } }),
        ),
      )

      const branch = await customProvider.getBranch('main')
      expect(branch.sha).toBe('sha-1')
    })
  })
})
