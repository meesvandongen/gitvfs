import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'
import { gitlab } from '../../src/providers/gitlab'
import type { GitRepository } from '../../src/types/provider'


async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

describe('GitLab Provider', () => {
  let repository: GitRepository

  beforeEach(() => {
    repository = gitlab({ token: 'test-token' }).repository('acme/website')
    vi.restoreAllMocks()
  })

  it('readdir fetches a directory via repository tree REST API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { path: 'src/index.ts', type: 'blob', id: 'blob-sha-1', name: 'index.ts', mode: '100644' },
          { path: 'src/lib', type: 'tree', id: 'tree-sha-1', name: 'lib', mode: '040000' },
        ]),
        { status: 200 },
      ),
    )

    const entries = await repository.readdir('main', 'src')
    expect(entries).toEqual([
      { path: 'src/index.ts', type: 'blob', sha: 'blob-sha-1' },
      { path: 'src/lib', type: 'tree', sha: 'tree-sha-1' },
    ])
    expect(fetchSpy.mock.calls[0][0]).toContain('/repository/tree?ref=main')
  })

  it('getBranch fetches branch info via REST', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ name: 'main', commit: { id: 'abc123' } }),
        { status: 200 },
      ),
    )

    const branch = await repository.getBranch('main')
    expect(branch).toEqual({ name: 'main', sha: 'abc123' })
  })

  it('createBranch creates via REST', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ name: 'feature/new', commit: { id: 'from-sha' } }),
        { status: 201 },
      ),
    )

    const branch = await repository.createBranch('feature/new', 'from-sha')
    expect(branch.name).toBe('feature/new')
  })

  it('getFile fetches via REST with base64 decoding', async () => {
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

    const file = await repository.getFile('main', 'readme.md')
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

    const result = await repository.commit({
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

describe('GitLab provider (account level)', () => {
  beforeEach(() => vi.restoreAllMocks())

  const project = (fullPath: string, visibility = 'private') => ({
    path_with_namespace: fullPath,
    path: fullPath.split('/').at(-1),
    namespace: { full_path: fullPath.split('/').slice(0, -1).join('/') },
    default_branch: 'main',
    visibility,
    description: null,
    web_url: `https://gitlab.example.com/${fullPath}`,
    last_activity_at: '2026-10-01T00:00:00Z',
  })

  it('lists projects across pages, with subgroups in the owner', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([project('acme/web/site')]), {
        status: 200,
        // No Link header: fall back to X-Next-Page.
        headers: { 'X-Next-Page': '2' },
      }),
    )
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([project('ada/notes', 'public')]), { status: 200 }))

    const repos = await collect(gitlab({ token: 't', apiUrl: 'https://gitlab.example.com/' }).listRepositories())
    expect(repos).toEqual([
      {
        fullName: 'acme/web/site',
        name: 'site',
        owner: 'acme/web',
        defaultBranch: 'main',
        private: true,
        description: null,
        webUrl: 'https://gitlab.example.com/acme/web/site',
        updatedAt: '2026-10-01T00:00:00Z',
      },
      expect.objectContaining({ fullName: 'ada/notes', private: false }),
    ])
    expect((fetchSpy.mock.calls[0][0] as string)).toContain('https://gitlab.example.com/api/v4/projects?membership=true')
    expect(new URL((fetchSpy.mock.calls[1][0] as string)).searchParams.get('page')).toBe('2')
  })

  it('opens projects by full path and skips the path lookup for GraphQL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ name: 'main', commit: { id: 'abc' } }), { status: 200 }),
    )
    const gl = gitlab({ token: 't' })
    expect(gl.name).toBe('gitlab')
    await gl.repository('acme/web/site').getBranch('main')
    expect((fetchSpy.mock.calls[0][0] as string)).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fweb%2Fsite/repository/branches/main',
    )
    expect(() => gl.repository('site')).toThrow(TypeError)
  })

  describe('branches and merge requests', () => {
    let repository: GitRepository
    beforeEach(() => {
      repository = gitlab({ token: 'test-token' }).repository('acme/website')
      vi.restoreAllMocks()
    })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    const mergeRequest = (overrides: Record<string, unknown> = {}) => ({
      iid: 7,
      title: 'Spring update',
      description: null,
      state: 'opened',
      draft: false,
      source_branch: 'cms/spring',
      target_branch: 'main',
      web_url: 'https://gitlab.com/acme/website/-/merge_requests/7',
      author: { username: 'ada' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      detailed_merge_status: 'mergeable',
      ...overrides,
    })

    it('lists branches', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json([{ name: 'main', commit: { id: 'a' } }, { name: 'cms/x', commit: { id: 'b' } }]))
      expect(await repository.listBranches!()).toEqual([{ name: 'main', sha: 'a' }, { name: 'cms/x', sha: 'b' }])
    })

    it('compares from the merge base in both directions', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      fetchSpy.mockResolvedValueOnce(json({
        commits: [{}, {}],
        diffs: [
          { old_path: 'a.md', new_path: 'a.md', new_file: true, renamed_file: false, deleted_file: false },
          { old_path: 'b.md', new_path: 'b.md', new_file: false, renamed_file: false, deleted_file: true },
          { old_path: 'c.md', new_path: 'd.md', new_file: false, renamed_file: true, deleted_file: false },
          { old_path: 'e.md', new_path: 'e.md', new_file: false, renamed_file: false, deleted_file: false },
        ],
      }))
      fetchSpy.mockResolvedValueOnce(json({ commits: [{}], diffs: [] }))

      expect(await repository.compareBranches!('main', 'cms/x')).toEqual({
        ahead: 2,
        behind: 1,
        files: [
          { path: 'a.md', status: 'added' },
          { path: 'b.md', status: 'removed' },
          { path: 'd.md', status: 'renamed', previousPath: 'c.md' },
          { path: 'e.md', status: 'modified' },
        ],
      })
      expect((fetchSpy.mock.calls[0][0] as string)).toContain('/repository/compare?from=main&to=cms%2Fx&straight=false')
      expect((fetchSpy.mock.calls[1][0] as string)).toContain('from=cms%2Fx&to=main')
    })

    it('maps merge requests to pull requests', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(mergeRequest()))
      expect(await repository.getPullRequest!(7)).toEqual({
        number: 7,
        title: 'Spring update',
        body: '',
        state: 'open',
        draft: false,
        head: 'cms/spring',
        base: 'main',
        url: 'https://gitlab.com/acme/website/-/merge_requests/7',
        author: 'ada',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        mergeable: true,
      })
    })

    it('lists closed requests including merged ones', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      fetchSpy.mockResolvedValueOnce(json([mergeRequest({ iid: 1, state: 'closed' })]))
      fetchSpy.mockResolvedValueOnce(json([mergeRequest({ iid: 2, state: 'merged', has_conflicts: false })]))

      const pulls = await repository.listPullRequests!({ head: 'cms/spring', state: 'closed' })
      expect(pulls.map((pull) => [pull.number, pull.state])).toEqual([[1, 'closed'], [2, 'merged']])
      expect((fetchSpy.mock.calls[0][0] as string)).toContain('source_branch=cms%2Fspring&state=closed')
      expect((fetchSpy.mock.calls[1][0] as string)).toContain('state=merged')
    })

    it('opens drafts with the Draft: prefix', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(mergeRequest({ draft: true, detailed_merge_status: 'checking' }), 201))
      const pull = await repository.createPullRequest!({ head: 'cms/spring', base: 'main', title: 'Spring', draft: true })
      expect(JSON.parse((fetchSpy.mock.calls[0][1]?.body as string))).toMatchObject({ source_branch: 'cms/spring', target_branch: 'main', title: 'Draft: Spring' })
      expect(pull).toMatchObject({ draft: true, mergeable: null })
    })

    it('reports a request that cannot be merged as a conflict', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"message":"Branch cannot be merged"}', { status: 406 }))
      await expect(repository.mergePullRequest!(7)).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('merges and closes', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      fetchSpy.mockResolvedValueOnce(json(mergeRequest({ state: 'merged', merge_commit_sha: 'merge-sha', merged_at: '2026-01-03T00:00:00Z' })))
      expect(await repository.mergePullRequest!(7)).toEqual({ sha: 'merge-sha', date: '2026-01-03T00:00:00Z' })
      fetchSpy.mockResolvedValueOnce(json(mergeRequest({ state: 'closed' })))
      expect(await repository.closePullRequest!(7)).toMatchObject({ state: 'closed' })
      expect(JSON.parse((fetchSpy.mock.calls[1][1]?.body as string))).toEqual({ state_event: 'close' })
    })
  })
})
