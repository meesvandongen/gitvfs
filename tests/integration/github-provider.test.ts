import { describe, it, expect, vi, beforeEach } from 'vitest'
import { github } from '../../src/providers/github'
import type { GitProvider } from '../../src/types/provider'

describe('GitHub Provider', () => {
  let provider: GitProvider

  beforeEach(() => {
    provider = github({ token: 'test-token', owner: 'acme', repo: 'website' })
    vi.restoreAllMocks()
  })

  it('getTree fetches recursive tree via REST', async () => {
    const mockTree = {
      tree: [
        { path: 'readme.md', type: 'blob', sha: 'abc123', size: 42 },
        { path: 'src', type: 'tree', sha: 'def456' },
        { path: 'src/index.ts', type: 'blob', sha: 'ghi789', size: 100 },
      ],
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    // First call: get ref
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ object: { sha: 'commit-sha-1' } }), { status: 200 }),
    )
    // Second call: get commit to find tree SHA
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ tree: { sha: 'tree-sha-1' } }), { status: 200 }),
    )
    // Third call: get tree
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockTree), { status: 200 }),
    )

    const tree = await provider.getTree('main')

    expect(tree).toHaveLength(3)
    expect(tree[0]).toEqual({ path: 'readme.md', type: 'blob', sha: 'abc123', size: 42 })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(fetchSpy.mock.calls[2][0]).toContain('git/trees/tree-sha-1?recursive=1')
  })

  it('getBlob fetches blob by SHA', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ content: 'SGVsbG8=', encoding: 'base64' }), { status: 200 }),
    )

    const blob = await provider.getBlob('abc123')
    expect(new TextDecoder().decode(blob)).toBe('Hello')
  })

  it('getBranch returns branch info', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ object: { sha: 'head-sha-1' } }), { status: 200 }),
    )

    const branch = await provider.getBranch('main')
    expect(branch).toEqual({ name: 'main', sha: 'head-sha-1' })
  })

  it('createBranch creates a ref via REST', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ object: { sha: 'from-sha' } }), { status: 201 }),
    )

    const branch = await provider.createBranch('feature/new', 'from-sha')
    expect(branch.name).toBe('feature/new')
    expect(branch.sha).toBe('from-sha')
  })

  it('commit sends GraphQL mutation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // GraphQL mutation response
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            createCommitOnBranch: {
              commit: { oid: 'new-commit-sha', committedDate: '2024-01-01T00:00:00Z' },
            },
          },
        }),
        { status: 200 },
      ),
    )

    // getTree call after commit (for file SHAs): ref lookup
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ object: { sha: 'new-commit-sha' } }), { status: 200 }),
    )
    // commit lookup
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ tree: { sha: 'new-tree-sha' } }), { status: 200 }),
    )
    // tree response
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tree: [{ path: 'new-file.md', type: 'blob', sha: 'file-sha-1', size: 10 }],
        }),
        { status: 200 },
      ),
    )

    const result = await provider.commit({
      branch: 'main',
      message: 'Add file',
      changes: [{ action: 'create', path: 'new-file.md', content: '# New' }],
      expectedHeadOid: 'old-head',
    })

    expect(result.sha).toBe('new-commit-sha')
    expect(result.files['new-file.md'].sha).toBe('file-sha-1')

    // Verify GraphQL was called
    const graphqlCall = fetchSpy.mock.calls[0]
    expect(graphqlCall[0]).toContain('graphql')
  })
})
