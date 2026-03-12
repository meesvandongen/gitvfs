import { describe, it, expect, vi, beforeEach } from 'vitest'
import { gitlab } from '../../src/providers/gitlab'
import type { GitProvider } from '../../src/types/provider'

describe('GitLab Provider', () => {
  let provider: GitProvider

  beforeEach(() => {
    provider = gitlab({ token: 'test-token', projectId: '12345' })
    vi.restoreAllMocks()
  })

  it('getBranch fetches branch info via REST', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ name: 'main', commit: { id: 'abc123' } }),
        { status: 200 },
      ),
    )

    const branch = await provider.getBranch('main')
    expect(branch).toEqual({ name: 'main', sha: 'abc123' })
  })

  it('createBranch creates via REST', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ name: 'feature/new', commit: { id: 'from-sha' } }),
        { status: 201 },
      ),
    )

    const branch = await provider.createBranch('feature/new', 'from-sha')
    expect(branch.name).toBe('feature/new')
  })

  it('getFile fetches via REST with base64 decoding', async () => {
    // First call: project info (for getFullPath)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // REST call for file
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: 'SGVsbG8=',
          blob_id: 'blob-sha-1',
          size: 5,
          encoding: 'base64',
        }),
        { status: 200 },
      ),
    )

    const file = await provider.getFile('main', 'readme.md')
    expect(new TextDecoder().decode(file.content)).toBe('Hello')
    expect(file.sha).toBe('blob-sha-1')
  })

  it('commit sends REST POST with actions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 'new-commit-sha', created_at: '2024-01-01T00:00:00Z' }),
        { status: 201 },
      ),
    )

    const result = await provider.commit({
      branch: 'main',
      message: 'Add file',
      changes: [
        { action: 'create', path: 'new-file.md', content: '# New' },
        { action: 'delete', path: 'old-file.md' },
      ],
    })

    expect(result.sha).toBe('new-commit-sha')
    // GitLab calculates file SHAs locally
    expect(result.files['new-file.md']).toBeTruthy()
    expect(result.files['old-file.md']).toBeUndefined()

    // Verify REST call
    const call = fetchSpy.mock.calls[0]
    expect(call[0]).toContain('/repository/commits')
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
    expect(body.actions).toHaveLength(2)
    expect(body.actions[0].action).toBe('create')
    expect(body.actions[1].action).toBe('delete')
  })
})
