import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { gitlab } from '../../src/providers/gitlab'
import type { GitProvider } from '../../src/types/provider'
import { NotFoundError, AuthError, RateLimitError, ConflictError, GitFSError } from '../../src/types/errors'

const BASE = 'https://gitlab.com/api/v4'
const GQL = 'https://gitlab.com/api/graphql'

function restUrl(path: string) {
  return `${BASE}${path}`
}

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('GitLab Provider', () => {
  let provider: GitProvider

  beforeEach(() => {
    // Create fresh provider each test so fullPath cache is clean
    provider = gitlab({ token: 'test-token', projectId: '12345' })
  })

  // Helper: set up project fullPath lookup
  function mockFullPath() {
    server.use(
      http.get(restUrl('/projects/12345'), () =>
        HttpResponse.json({ path_with_namespace: 'acme/website' }),
      ),
    )
  }

  // ─── getTree ───────────────────────────────────────────────

  describe('getTree', () => {
    it('fetches recursive tree via GraphQL with pagination', async () => {
      mockFullPath()
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              project: {
                repository: {
                  tree: {
                    blobs: {
                      pageInfo: { hasNextPage: false, endCursor: 'c1' },
                      nodes: [
                        { path: 'readme.md', sha: 'abc123', flatPath: 'readme.md', size: 42 },
                        { path: 'src/index.ts', sha: 'ghi789', flatPath: 'src/index.ts', size: 100 },
                      ],
                    },
                    trees: {
                      nodes: [{ path: 'src', sha: 'def456' }],
                    },
                  },
                },
              },
            },
          }),
        ),
      )

      const tree = await provider.getTree('main')

      expect(tree).toHaveLength(3)
      expect(tree[0]).toEqual({ path: 'readme.md', type: 'blob', sha: 'abc123', size: 42 })
      expect(tree[1]).toEqual({ path: 'src/index.ts', type: 'blob', sha: 'ghi789', size: 100 })
      expect(tree[2]).toEqual({ path: 'src', type: 'tree', sha: 'def456' })
    })

    it('paginates when hasNextPage is true', async () => {
      mockFullPath()
      let callCount = 0
      server.use(
        http.post(GQL, () => {
          callCount++
          if (callCount === 1) {
            return HttpResponse.json({
              data: {
                project: {
                  repository: {
                    tree: {
                      blobs: {
                        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                        nodes: [{ path: 'file1.md', sha: 'sha1', flatPath: 'file1.md', size: 10 }],
                      },
                      trees: { nodes: [] },
                    },
                  },
                },
              },
            })
          }
          return HttpResponse.json({
            data: {
              project: {
                repository: {
                  tree: {
                    blobs: {
                      pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
                      nodes: [{ path: 'file2.md', sha: 'sha2', flatPath: 'file2.md', size: 20 }],
                    },
                    trees: { nodes: [] },
                  },
                },
              },
            },
          })
        }),
      )

      const tree = await provider.getTree('main')

      expect(tree).toHaveLength(2)
      expect(tree[0].path).toBe('file1.md')
      expect(tree[1].path).toBe('file2.md')
      expect(callCount).toBe(2)
    })

    it('returns empty array for empty repo', async () => {
      mockFullPath()
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              project: {
                repository: {
                  tree: {
                    blobs: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [],
                    },
                    trees: { nodes: [] },
                  },
                },
              },
            },
          }),
        ),
      )

      const tree = await provider.getTree('main')
      expect(tree).toEqual([])
    })

    it('throws AuthError on 401', async () => {
      server.use(
        http.get(restUrl('/projects/12345'), () =>
          HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
        ),
      )

      await expect(provider.getTree('main')).rejects.toThrow(AuthError)
    })

    it('throws AuthError on 403', async () => {
      server.use(
        http.get(restUrl('/projects/12345'), () =>
          HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
        ),
      )

      await expect(provider.getTree('main')).rejects.toThrow(AuthError)
    })

    it('throws RateLimitError on 429', async () => {
      server.use(
        http.get(restUrl('/projects/12345'), () =>
          HttpResponse.json(
            { message: 'rate limit' },
            { status: 429, headers: { 'Retry-After': '45' } },
          ),
        ),
      )

      const err = await provider.getTree('main').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RateLimitError)
      expect((err as RateLimitError).retryAfter).toBe(45)
    })

    it('throws on GraphQL errors', async () => {
      mockFullPath()
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({ errors: [{ message: 'Something went wrong' }] }),
        ),
      )

      await expect(provider.getTree('main')).rejects.toThrow(GitFSError)
    })
  })

  // ─── getFiles ──────────────────────────────────────────────

  describe('getFiles', () => {
    it('fetches multiple files via GraphQL', async () => {
      mockFullPath()
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              project: {
                repository: {
                  blobs: {
                    nodes: [
                      { path: 'readme.md', rawBlob: '# Hello', oid: 'sha-1', size: 7 },
                      { path: 'hello.txt', rawBlob: 'world', oid: 'sha-2', size: 5 },
                    ],
                  },
                },
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

    it('skips entries with null rawBlob', async () => {
      mockFullPath()
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({
            data: {
              project: {
                repository: {
                  blobs: {
                    nodes: [
                      { path: 'text.md', rawBlob: 'content', oid: 'sha-1', size: 7 },
                      { path: 'binary.bin', rawBlob: null, oid: 'sha-2', size: 1024 },
                    ],
                  },
                },
              },
            },
          }),
        ),
      )

      const files = await provider.getFiles('main', ['text.md', 'binary.bin'])

      expect(files.size).toBe(1)
      expect(files.has('text.md')).toBe(true)
      expect(files.has('binary.bin')).toBe(false)
    })

    it('handles empty path list', async () => {
      const files = await provider.getFiles('main', [])
      expect(files.size).toBe(0)
    })

    it('chunks requests by 100', async () => {
      mockFullPath()
      const calls: string[] = []
      server.use(
        http.post(GQL, async ({ request }) => {
          const body = (await request.json()) as { query: string }
          calls.push(body.query)
          return HttpResponse.json({
            data: {
              project: {
                repository: {
                  blobs: {
                    nodes: [],
                  },
                },
              },
            },
          })
        }),
      )

      const paths = Array.from({ length: 110 }, (_, i) => `file-${i}.txt`)
      await provider.getFiles('main', paths)

      expect(calls).toHaveLength(2) // 100 + 10
    })

    it('throws AuthError on GraphQL 401', async () => {
      mockFullPath()
      server.use(
        http.post(GQL, () =>
          HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
        ),
      )

      await expect(provider.getFiles('main', ['test.md'])).rejects.toThrow(AuthError)
    })
  })

  // ─── getFile ───────────────────────────────────────────────

  describe('getFile', () => {
    it('fetches a single file via REST with base64 decoding', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/files/readme.md'), () =>
          HttpResponse.json({
            content: 'SGVsbG8=',
            blob_id: 'blob-sha-1',
            size: 5,
            encoding: 'base64',
          }),
        ),
      )

      const file = await provider.getFile('main', 'readme.md')
      expect(new TextDecoder().decode(file.content)).toBe('Hello')
      expect(file.sha).toBe('blob-sha-1')
      expect(file.size).toBe(5)
      expect(file.path).toBe('readme.md')
    })

    it('handles non-base64 encoding', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/files/readme.md'), () =>
          HttpResponse.json({
            content: 'plain text',
            blob_id: 'blob-sha-1',
            size: 10,
            encoding: 'text',
          }),
        ),
      )

      const file = await provider.getFile('main', 'readme.md')
      expect(new TextDecoder().decode(file.content)).toBe('plain text')
    })

    it('encodes path in URL', async () => {
      let requestedUrl = ''
      server.use(
        http.get(restUrl('/projects/12345/repository/files/:path'), ({ request }) => {
          requestedUrl = request.url
          return HttpResponse.json({
            content: 'SGVsbG8=',
            blob_id: 'sha-1',
            size: 5,
            encoding: 'base64',
          })
        }),
      )

      await provider.getFile('main', 'src/deep/file.ts')
      expect(requestedUrl).toContain('src%2Fdeep%2Ffile.ts')
    })

    it('throws NotFoundError for missing file', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/files/missing.md'), () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      )

      await expect(provider.getFile('main', 'missing.md')).rejects.toThrow(NotFoundError)
    })
  })

  // ─── getBlob ───────────────────────────────────────────────

  describe('getBlob', () => {
    it('fetches blob by SHA with base64 decoding', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/blobs/abc123'), () =>
          HttpResponse.json({ content: 'SGVsbG8=', encoding: 'base64' }),
        ),
      )

      const blob = await provider.getBlob('abc123')
      expect(new TextDecoder().decode(blob)).toBe('Hello')
    })

    it('handles non-base64 encoding', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/blobs/abc123'), () =>
          HttpResponse.json({ content: 'plain text', encoding: 'utf-8' }),
        ),
      )

      const blob = await provider.getBlob('abc123')
      expect(new TextDecoder().decode(blob)).toBe('plain text')
    })

    it('throws NotFoundError for missing blob', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/blobs/missing'), () =>
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
        http.get(restUrl('/projects/12345/repository/branches/main'), () =>
          HttpResponse.json({ name: 'main', commit: { id: 'head-sha-1' } }),
        ),
      )

      const branch = await provider.getBranch('main')
      expect(branch).toEqual({ name: 'main', sha: 'head-sha-1' })
    })

    it('throws NotFoundError for missing branch', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/branches/missing'), () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      )

      await expect(provider.getBranch('missing')).rejects.toThrow(NotFoundError)
    })

    it('URL-encodes branch name', async () => {
      let requestedUrl = ''
      server.use(
        http.get(restUrl('/projects/12345/repository/branches/:name'), ({ request }) => {
          requestedUrl = request.url
          return HttpResponse.json({ name: 'feature/test', commit: { id: 'sha-1' } })
        }),
      )

      await provider.getBranch('feature/test')
      expect(requestedUrl).toContain('feature%2Ftest')
    })
  })

  // ─── getLastCommitSha ─────────────────────────────────────

  describe('getLastCommitSha', () => {
    it('returns the head SHA via getBranch', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/branches/main'), () =>
          HttpResponse.json({ name: 'main', commit: { id: 'head-sha-999' } }),
        ),
      )

      const sha = await provider.getLastCommitSha('main')
      expect(sha).toBe('head-sha-999')
    })
  })

  // ─── createBranch ──────────────────────────────────────────

  describe('createBranch', () => {
    it('creates a branch via REST POST', async () => {
      server.use(
        http.post(restUrl('/projects/12345/repository/branches'), async ({ request }) => {
          const body = (await request.json()) as { branch: string; ref: string }
          expect(body.branch).toBe('feature/new')
          expect(body.ref).toBe('from-sha')
          return HttpResponse.json(
            { name: 'feature/new', commit: { id: 'from-sha' } },
            { status: 201 },
          )
        }),
      )

      const branch = await provider.createBranch('feature/new', 'from-sha')
      expect(branch).toEqual({ name: 'feature/new', sha: 'from-sha' })
    })

    it('sends correct authorization header', async () => {
      let authHeader: string | null = null
      server.use(
        http.post(restUrl('/projects/12345/repository/branches'), ({ request }) => {
          authHeader = request.headers.get('Authorization')
          return HttpResponse.json(
            { name: 'test', commit: { id: 'sha1' } },
            { status: 201 },
          )
        }),
      )

      await provider.createBranch('test', 'sha1')
      expect(authHeader).toBe('Bearer test-token')
    })
  })

  // ─── deleteBranch ──────────────────────────────────────────

  describe('deleteBranch', () => {
    it('deletes a branch via REST DELETE', async () => {
      let deleteCalled = false
      server.use(
        http.delete(restUrl('/projects/12345/repository/branches/:name'), () => {
          deleteCalled = true
          return new HttpResponse(null, { status: 204 })
        }),
      )

      await provider.deleteBranch('feature/old')
      expect(deleteCalled).toBe(true)
    })

    it('throws NotFoundError when branch does not exist', async () => {
      server.use(
        http.delete(restUrl('/projects/12345/repository/branches/:name'), () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      )

      await expect(provider.deleteBranch('nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  // ─── commit ────────────────────────────────────────────────

  describe('commit', () => {
    it('sends REST POST with actions', async () => {
      let commitBody: Record<string, unknown> | null = null

      server.use(
        http.post(restUrl('/projects/12345/repository/commits'), async ({ request }) => {
          commitBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json(
            { id: 'new-commit-sha', created_at: '2024-01-01T00:00:00Z' },
            { status: 201 },
          )
        }),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Add file',
        changes: [{ action: 'create', path: 'new-file.md', content: '# New' }],
      })

      expect(result.sha).toBe('new-commit-sha')
      expect(result.date).toBe('2024-01-01T00:00:00Z')
      expect(result.files['new-file.md']).toBeTruthy()
      expect(result.files['new-file.md'].sha).toBeTruthy()

      expect(commitBody!.branch).toBe('main')
      expect(commitBody!.commit_message).toBe('Add file')
      expect((commitBody!.actions as unknown[])).toHaveLength(1)
    })

    it('handles deletions', async () => {
      let commitBody: Record<string, unknown> | null = null

      server.use(
        http.post(restUrl('/projects/12345/repository/commits'), async ({ request }) => {
          commitBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json(
            { id: 'commit-sha', created_at: '2024-01-01T00:00:00Z' },
            { status: 201 },
          )
        }),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Delete file',
        changes: [{ action: 'delete', path: 'old-file.md' }],
      })

      expect(result.sha).toBe('commit-sha')
      expect(result.files['old-file.md']).toBeUndefined()
      const actions = commitBody!.actions as Array<{ action: string; file_path: string }>
      expect(actions[0]).toEqual({ action: 'delete', file_path: 'old-file.md' })
    })

    it('handles moves with previous_path', async () => {
      let commitBody: Record<string, unknown> | null = null

      server.use(
        http.post(restUrl('/projects/12345/repository/commits'), async ({ request }) => {
          commitBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json(
            { id: 'commit-sha', created_at: '2024-01-01T00:00:00Z' },
            { status: 201 },
          )
        }),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Move file',
        changes: [{ action: 'move', path: 'new-path.md', previousPath: 'old-path.md', content: 'moved' }],
      })

      expect(result.files['new-path.md']).toBeTruthy()
      const actions = commitBody!.actions as Array<Record<string, string>>
      expect(actions[0].action).toBe('move')
      expect(actions[0].file_path).toBe('new-path.md')
      expect(actions[0].previous_path).toBe('old-path.md')
      expect(actions[0].encoding).toBe('base64')
    })

    it('handles Uint8Array content', async () => {
      server.use(
        http.post(restUrl('/projects/12345/repository/commits'), () =>
          HttpResponse.json(
            { id: 'commit-sha', created_at: '2024-01-01T00:00:00Z' },
            { status: 201 },
          ),
        ),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Add binary',
        changes: [{ action: 'create', path: 'file.bin', content: new Uint8Array([1, 2, 3]) }],
      })

      expect(result.files['file.bin']).toBeTruthy()
      expect(result.files['file.bin'].sha).toBeTruthy()
    })

    it('handles mixed additions and deletions', async () => {
      server.use(
        http.post(restUrl('/projects/12345/repository/commits'), () =>
          HttpResponse.json(
            { id: 'commit-sha', created_at: '2024-01-01T00:00:00Z' },
            { status: 201 },
          ),
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

      expect(result.files['new.md']).toBeTruthy()
      expect(result.files['updated.md']).toBeTruthy()
      expect(result.files['removed.md']).toBeUndefined()
    })

    it('validates expectedHeadOid (optimistic concurrency)', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/branches/main'), () =>
          HttpResponse.json({ name: 'main', commit: { id: 'current-head' } }),
        ),
      )

      await expect(
        provider.commit({
          branch: 'main',
          message: 'Should fail',
          changes: [{ action: 'create', path: 'test.md', content: 'test' }],
          expectedHeadOid: 'stale-head',
        }),
      ).rejects.toThrow(ConflictError)
    })

    it('succeeds when expectedHeadOid matches', async () => {
      server.use(
        http.get(restUrl('/projects/12345/repository/branches/main'), () =>
          HttpResponse.json({ name: 'main', commit: { id: 'current-head' } }),
        ),
        http.post(restUrl('/projects/12345/repository/commits'), () =>
          HttpResponse.json(
            { id: 'new-commit-sha', created_at: '2024-01-01T00:00:00Z' },
            { status: 201 },
          ),
        ),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'Should succeed',
        changes: [{ action: 'create', path: 'test.md', content: 'test' }],
        expectedHeadOid: 'current-head',
      })

      expect(result.sha).toBe('new-commit-sha')
    })

    it('skips expectedHeadOid check when not provided', async () => {
      server.use(
        http.post(restUrl('/projects/12345/repository/commits'), () =>
          HttpResponse.json(
            { id: 'commit-sha', created_at: '2024-01-01T00:00:00Z' },
            { status: 201 },
          ),
        ),
      )

      const result = await provider.commit({
        branch: 'main',
        message: 'No oid check',
        changes: [{ action: 'create', path: 'test.md', content: 'test' }],
      })

      expect(result.sha).toBe('commit-sha')
    })
  })

  // ─── Custom API URL ────────────────────────────────────────

  describe('custom apiUrl', () => {
    it('uses custom API URL for REST calls', async () => {
      const customProvider = gitlab({
        token: 'test-token',
        projectId: '99',
        apiUrl: 'https://gitlab.example.com',
      })

      server.use(
        http.get('https://gitlab.example.com/api/v4/projects/99/repository/branches/main', () =>
          HttpResponse.json({ name: 'main', commit: { id: 'sha-1' } }),
        ),
      )

      const branch = await customProvider.getBranch('main')
      expect(branch.sha).toBe('sha-1')
    })
  })

  // ─── Project ID encoding ──────────────────────────────────

  describe('projectId encoding', () => {
    it('handles string project IDs with special characters', async () => {
      const specialProvider = gitlab({
        token: 'test-token',
        projectId: 'acme/website',
      })

      server.use(
        http.get(restUrl('/projects/acme%2Fwebsite/repository/branches/main'), () =>
          HttpResponse.json({ name: 'main', commit: { id: 'sha-1' } }),
        ),
      )

      const branch = await specialProvider.getBranch('main')
      expect(branch.sha).toBe('sha-1')
    })

    it('handles numeric project IDs', async () => {
      const numProvider = gitlab({
        token: 'test-token',
        projectId: 42,
      })

      server.use(
        http.get(restUrl('/projects/42/repository/branches/main'), () =>
          HttpResponse.json({ name: 'main', commit: { id: 'sha-2' } }),
        ),
      )

      const branch = await numProvider.getBranch('main')
      expect(branch.sha).toBe('sha-2')
    })
  })
})
