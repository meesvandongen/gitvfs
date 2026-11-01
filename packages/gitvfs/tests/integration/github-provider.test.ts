import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { github } from '../../src/providers/github'
import type { GitRepository } from '../../src/types/provider'


async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

describe('GitHub Provider', () => {
  let repository: GitRepository

  beforeEach(() => {
    repository = github({ token: 'test-token' }).repository('acme/website')
    vi.restoreAllMocks()
  })

  it('readdir fetches recursive tree via REST when requested', async () => {
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

    const tree = await repository.readdir('main', '', { recursive: true })

    expect(tree).toHaveLength(3)
    expect(tree[0]).toEqual({ path: 'readme.md', type: 'blob', sha: 'abc123', size: 42 })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(fetchSpy.mock.calls[2][0]).toContain('git/trees/tree-sha-1?recursive=1')
  })

  it('readdir fetches a shallow directory via contents API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { path: 'src/index.ts', type: 'file', sha: 'ghi789', size: 100 },
          { path: 'src/lib', type: 'dir', sha: 'dirsha' },
        ]),
        { status: 200 },
      ),
    )

    const entries = await repository.readdir('main', 'src')

    expect(entries).toEqual([
      { path: 'src/index.ts', type: 'blob', sha: 'ghi789', size: 100 },
      { path: 'src/lib', type: 'tree', sha: 'dirsha', size: undefined },
    ])
    expect(fetchSpy.mock.calls[0][0]).toContain('/contents/src?ref=main')
  })

  it('getBlob fetches blob by SHA', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ content: 'SGVsbG8=', encoding: 'base64' }), { status: 200 }),
    )

    const blob = await repository.getBlob('abc123')
    expect(new TextDecoder().decode(blob)).toBe('Hello')
  })

  it('getBranch returns branch info', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ object: { sha: 'head-sha-1' } }), { status: 200 }),
    )

    const branch = await repository.getBranch('main')
    expect(branch).toEqual({ name: 'main', sha: 'head-sha-1' })
  })

  it('createBranch creates a ref via REST', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ object: { sha: 'from-sha' } }), { status: 201 }),
    )

    const branch = await repository.createBranch('feature/new', 'from-sha')
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

    // getFiles call after commit (for file SHAs)
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            repository: {
              f0: { text: '# New', oid: 'file-sha-1', byteSize: 5 },
            },
          },
        }),
        { status: 200 },
      ),
    )

    const result = await repository.commit({
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

describe('GitHub provider (account level)', () => {
  beforeEach(() => vi.restoreAllMocks())

  const repo = (fullName: string, description: string | null = null) => ({
    full_name: fullName,
    name: fullName.split('/')[1],
    owner: { login: fullName.split('/')[0] },
    default_branch: 'main',
    private: fullName.startsWith('acme/'),
    description,
    html_url: `https://github.com/${fullName}`,
    pushed_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  })

  it('lists repositories across pages by following Link headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([repo('acme/site', 'Marketing site')]), {
        status: 200,
        headers: { Link: '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=2>; rel="last"' },
      }),
    )
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([repo('ada/notes')]), { status: 200 }))

    const repos = await collect(github({ token: 'test-token' }).listRepositories())
    expect(repos).toEqual([
      {
        fullName: 'acme/site',
        name: 'site',
        owner: 'acme',
        defaultBranch: 'main',
        private: true,
        description: 'Marketing site',
        webUrl: 'https://github.com/acme/site',
        updatedAt: '2026-10-01T00:00:00Z',
      },
      expect.objectContaining({ fullName: 'ada/notes', private: false }),
    ])
    expect((fetchSpy.mock.calls[0][0] as string)).toContain('/user/repos?per_page=100')
    expect((fetchSpy.mock.calls[1][0] as string)).toBe('https://api.github.com/user/repos?page=2')
    expect(new Headers(fetchSpy.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer test-token')
  })

  it('filters by search text and stops fetching when iteration stops', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([repo('acme/site', 'Docs and blog'), repo('acme/api'), repo('ada/docs')]), {
        status: 200,
        headers: { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
      }),
    )
    const found: string[] = []
    for await (const info of github({ token: 't' }).listRepositories({ search: 'DOCS' })) {
      found.push(info.fullName)
      if (found.length === 2) break
    }
    expect(found).toEqual(['acme/site', 'ada/docs'])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('opens repositories by full name without a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const gh = github({ token: 't', apiUrl: 'https://ghe.example.com/api/v3/' })
    const repository = gh.repository('acme/site')
    expect(gh.name).toBe('github')
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'abc' } }), { status: 200 }))
    await repository.getBranch('main')
    expect((fetchSpy.mock.calls[0][0] as string)).toBe('https://ghe.example.com/api/v3/repos/acme/site/git/ref/heads/main')

    expect(() => gh.repository('acme')).toThrow(TypeError)
    expect(() => gh.repository('acme/site/extra')).toThrow(TypeError)
  })

  it('uses /api/graphql on GitHub Enterprise Server', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { repository: {} } }), { status: 200 }),
    )
    await github({ token: 't', apiUrl: 'https://ghe.example.com/api/v3' }).repository('acme/site').getFiles('main', ['a.md'])
    expect((fetchSpy.mock.calls[0][0] as string)).toBe('https://ghe.example.com/api/graphql')
  })
})
