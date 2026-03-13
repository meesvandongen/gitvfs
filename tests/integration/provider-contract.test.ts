/**
 * Contract tests: verify that GitHub and GitLab providers produce identical
 * output shapes and semantics for the same logical operations.
 *
 * Uses MSW to mock both APIs and asserts that the GitProvider interface
 * contract is satisfied identically by both implementations.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { github } from '../../src/providers/github'
import { gitlab } from '../../src/providers/gitlab'
import type { GitProvider, BranchInfo, TreeEntry, FileContent, CommitResult } from '../../src/types/provider'
import { NotFoundError, ConflictError } from '../../src/types/errors'

const GH_BASE = 'https://api.github.com'
const GH_GQL = `${GH_BASE}/graphql`
const GL_BASE = 'https://gitlab.com/api/v4'
const GL_GQL = 'https://gitlab.com/api/graphql'

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

type ProviderSetup = {
  name: string
  create: () => GitProvider
  mockGetBranch: (branchName: string, sha: string) => void
  mockGetBranchNotFound: (branchName: string) => void
  mockCreateBranch: (branchName: string, sha: string) => void
  mockDeleteBranch: (branchName: string) => void
  mockGetTree: (branchName: string, entries: TreeEntry[]) => void
  mockGetFile: (ref: string, path: string, content: string, sha: string) => void
  mockGetBlob: (sha: string, content: string) => void
  mockCommit: (result: { sha: string; date: string; treeEntries?: TreeEntry[] }) => void
}

function createGitHubSetup(): ProviderSetup {
  return {
    name: 'GitHub',
    create: () => github({ token: 'gh-token', owner: 'acme', repo: 'website' }),
    mockGetBranch: (name, sha) => {
      server.use(
        http.get(`${GH_BASE}/repos/acme/website/git/ref/heads/${name}`, () =>
          HttpResponse.json({ object: { sha } }),
        ),
      )
    },
    mockGetBranchNotFound: (name) => {
      server.use(
        http.get(`${GH_BASE}/repos/acme/website/git/ref/heads/${name}`, () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      )
    },
    mockCreateBranch: (name, sha) => {
      server.use(
        http.post(`${GH_BASE}/repos/acme/website/git/refs`, () =>
          HttpResponse.json({ object: { sha } }, { status: 201 }),
        ),
      )
    },
    mockDeleteBranch: (name) => {
      server.use(
        http.delete(`${GH_BASE}/repos/acme/website/git/refs/heads/${name}`, () =>
          new HttpResponse(null, { status: 204 }),
        ),
      )
    },
    mockGetTree: (branchName, entries) => {
      const ghTree = entries.map((e) => ({
        path: e.path,
        type: e.type,
        sha: e.sha,
        size: e.size,
      }))
      server.use(
        http.get(`${GH_BASE}/repos/acme/website/git/ref/heads/${branchName}`, () =>
          HttpResponse.json({ object: { sha: 'commit-sha' } }),
        ),
        http.get(`${GH_BASE}/repos/acme/website/git/commits/commit-sha`, () =>
          HttpResponse.json({ tree: { sha: 'tree-sha' } }),
        ),
        http.get(`${GH_BASE}/repos/acme/website/git/trees/tree-sha`, () =>
          HttpResponse.json({ tree: ghTree }),
        ),
      )
    },
    mockGetFile: (ref, path, content, sha) => {
      server.use(
        http.post(GH_GQL, () =>
          HttpResponse.json({
            data: {
              repository: {
                f0: { text: content, oid: sha, byteSize: content.length },
              },
            },
          }),
        ),
      )
    },
    mockGetBlob: (sha, content) => {
      const encoded = btoa(content)
      server.use(
        http.get(`${GH_BASE}/repos/acme/website/git/blobs/${sha}`, () =>
          HttpResponse.json({ content: encoded, encoding: 'base64' }),
        ),
      )
    },
    mockCommit: ({ sha, date, treeEntries }) => {
      server.use(
        http.post(GH_GQL, () =>
          HttpResponse.json({
            data: {
              createCommitOnBranch: {
                commit: { oid: sha, committedDate: date },
              },
            },
          }),
        ),
        http.get(`${GH_BASE}/repos/acme/website/git/ref/heads/main`, () =>
          HttpResponse.json({ object: { sha } }),
        ),
        http.get(`${GH_BASE}/repos/acme/website/git/commits/${sha}`, () =>
          HttpResponse.json({ tree: { sha: 'new-tree' } }),
        ),
        http.get(`${GH_BASE}/repos/acme/website/git/trees/new-tree`, () =>
          HttpResponse.json({ tree: treeEntries ?? [] }),
        ),
      )
    },
  }
}

function createGitLabSetup(): ProviderSetup {
  return {
    name: 'GitLab',
    create: () => gitlab({ token: 'gl-token', projectId: '12345' }),
    mockGetBranch: (name, sha) => {
      server.use(
        http.get(`${GL_BASE}/projects/12345/repository/branches/${encodeURIComponent(name)}`, () =>
          HttpResponse.json({ name, commit: { id: sha } }),
        ),
      )
    },
    mockGetBranchNotFound: (name) => {
      server.use(
        http.get(`${GL_BASE}/projects/12345/repository/branches/${encodeURIComponent(name)}`, () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      )
    },
    mockCreateBranch: (name, sha) => {
      server.use(
        http.post(`${GL_BASE}/projects/12345/repository/branches`, () =>
          HttpResponse.json({ name, commit: { id: sha } }, { status: 201 }),
        ),
      )
    },
    mockDeleteBranch: (name) => {
      server.use(
        http.delete(`${GL_BASE}/projects/12345/repository/branches/${encodeURIComponent(name)}`, () =>
          new HttpResponse(null, { status: 204 }),
        ),
      )
    },
    mockGetTree: (branchName, entries) => {
      const blobs = entries.filter((e) => e.type === 'blob').map((e) => ({
        path: e.path,
        sha: e.sha,
        flatPath: e.path,
        size: e.size ?? 0,
      }))
      const trees = entries.filter((e) => e.type === 'tree').map((e) => ({
        path: e.path,
        sha: e.sha,
      }))
      server.use(
        http.get(`${GL_BASE}/projects/12345`, () =>
          HttpResponse.json({ path_with_namespace: 'acme/website' }),
        ),
        http.post(GL_GQL, () =>
          HttpResponse.json({
            data: {
              project: {
                repository: {
                  tree: {
                    blobs: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: blobs,
                    },
                    trees: { nodes: trees },
                  },
                },
              },
            },
          }),
        ),
      )
    },
    mockGetFile: (ref, path, content, sha) => {
      const encoded = btoa(content)
      server.use(
        http.get(`${GL_BASE}/projects/12345/repository/files/${encodeURIComponent(path)}`, () =>
          HttpResponse.json({
            content: encoded,
            blob_id: sha,
            size: content.length,
            encoding: 'base64',
          }),
        ),
      )
    },
    mockGetBlob: (sha, content) => {
      const encoded = btoa(content)
      server.use(
        http.get(`${GL_BASE}/projects/12345/repository/blobs/${sha}`, () =>
          HttpResponse.json({ content: encoded, encoding: 'base64' }),
        ),
      )
    },
    mockCommit: ({ sha, date }) => {
      server.use(
        http.post(`${GL_BASE}/projects/12345/repository/commits`, () =>
          HttpResponse.json({ id: sha, created_at: date }, { status: 201 }),
        ),
      )
    },
  }
}

const setups: ProviderSetup[] = [createGitHubSetup(), createGitLabSetup()]

describe.each(setups)('Provider contract: $name', (setup) => {
  let provider: GitProvider

  beforeEach(() => {
    provider = setup.create()
  })

  describe('getBranch', () => {
    it('returns { name, sha } shape', async () => {
      setup.mockGetBranch('main', 'abc123')
      const branch = await provider.getBranch('main')

      expect(branch).toEqual<BranchInfo>({ name: 'main', sha: 'abc123' })
      expect(typeof branch.name).toBe('string')
      expect(typeof branch.sha).toBe('string')
    })

    it('throws NotFoundError for missing branch', async () => {
      setup.mockGetBranchNotFound('nonexistent')
      await expect(provider.getBranch('nonexistent')).rejects.toThrow(NotFoundError)
    })
  })

  describe('getLastCommitSha', () => {
    it('returns a string SHA', async () => {
      setup.mockGetBranch('main', 'sha-from-branch')
      const sha = await provider.getLastCommitSha('main')

      expect(typeof sha).toBe('string')
      expect(sha).toBe('sha-from-branch')
    })
  })

  describe('createBranch', () => {
    it('returns { name, sha } shape', async () => {
      setup.mockCreateBranch('new-branch', 'base-sha')
      const branch = await provider.createBranch('new-branch', 'base-sha')

      expect(branch).toEqual<BranchInfo>({ name: 'new-branch', sha: 'base-sha' })
    })
  })

  describe('deleteBranch', () => {
    it('resolves without error', async () => {
      setup.mockDeleteBranch('old-branch')
      await expect(provider.deleteBranch('old-branch')).resolves.toBeUndefined()
    })
  })

  describe('getTree', () => {
    it('returns TreeEntry[] with consistent shape', async () => {
      const entries: TreeEntry[] = [
        { path: 'readme.md', type: 'blob', sha: 'blob-sha', size: 42 },
        { path: 'src', type: 'tree', sha: 'tree-sha' },
      ]
      setup.mockGetTree('main', entries)

      const tree = await provider.getTree('main')

      // Both providers should return blob entries with path, type, sha
      const blob = tree.find((e) => e.type === 'blob')!
      expect(blob.path).toBe('readme.md')
      expect(blob.sha).toBe('blob-sha')
      expect(blob.type).toBe('blob')
      expect(typeof blob.size).toBe('number')

      const treeEntry = tree.find((e) => e.type === 'tree')!
      expect(treeEntry.path).toBe('src')
      expect(treeEntry.sha).toBe('tree-sha')
      expect(treeEntry.type).toBe('tree')
    })

    it('returns empty array for empty tree', async () => {
      setup.mockGetTree('main', [])
      const tree = await provider.getTree('main')
      expect(tree).toEqual([])
    })
  })

  describe('getFile', () => {
    it('returns FileContent with consistent shape', async () => {
      setup.mockGetFile('main', 'readme.md', 'Hello World', 'file-sha')

      const file = await provider.getFile('main', 'readme.md')

      expect(file.path).toBe('readme.md')
      expect(file.sha).toBe('file-sha')
      expect(file.content).toBeInstanceOf(Uint8Array)
      expect(typeof file.size).toBe('number')
      expect(new TextDecoder().decode(file.content)).toBe('Hello World')
    })
  })

  describe('getBlob', () => {
    it('returns Uint8Array', async () => {
      setup.mockGetBlob('blob-sha', 'blob content')

      const blob = await provider.getBlob('blob-sha')

      expect(blob).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(blob)).toBe('blob content')
    })
  })

  describe('commit', () => {
    it('returns CommitResult with { sha, date, files } shape', async () => {
      setup.mockCommit({
        sha: 'commit-sha-new',
        date: '2024-06-15T10:00:00Z',
        treeEntries: [{ path: 'test.md', type: 'blob', sha: 'file-sha', size: 4 }],
      })

      const result = await provider.commit({
        branch: 'main',
        message: 'Test commit',
        changes: [{ action: 'create', path: 'test.md', content: 'test' }],
      })

      expect(typeof result.sha).toBe('string')
      expect(typeof result.date).toBe('string')
      expect(typeof result.files).toBe('object')
      expect(result.sha).toBe('commit-sha-new')
      expect(result.date).toBe('2024-06-15T10:00:00Z')
      // Both should populate files for non-delete changes
      expect(result.files['test.md']).toBeTruthy()
      expect(typeof result.files['test.md'].sha).toBe('string')
    })

    it('excludes deleted files from result.files', async () => {
      setup.mockCommit({
        sha: 'commit-sha',
        date: '2024-06-15T10:00:00Z',
        treeEntries: [],
      })

      const result = await provider.commit({
        branch: 'main',
        message: 'Delete',
        changes: [{ action: 'delete', path: 'gone.md' }],
      })

      expect(result.files['gone.md']).toBeUndefined()
    })
  })
})
