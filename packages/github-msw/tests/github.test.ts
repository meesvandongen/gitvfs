import { setupServer } from 'msw/node'
import { GitFS } from 'gitvfs'
import { github } from 'gitvfs/providers/github'
import { createGitHubHandlers, MockRepository, persistentRepository, type StorageLike } from '../src'

const server = setupServer()
beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

async function setup(files: Record<string, string> = {}) {
  const repository = await MockRepository.create({
    files: {
      'README.md': '# Demo\n',
      'content/posts/hello.md': '---\ntitle: Hello\n---\n\nHi\n',
      'content/posts/second.md': '---\ntitle: Second\n---\n',
      'data/site.json': '{"title":"Site"}\n',
      ...files,
    },
  })
  const changes: string[] = []
  server.use(
    ...createGitHubHandlers({
      repository,
      owner: 'acme',
      repo: 'site',
      onChange: () => void changes.push(repository.branchHead('main')!),
    }),
  )
  const provider = github({ owner: 'acme', repo: 'site', token: 'demo-token' })
  const fs = new GitFS({ provider, branch: 'main', cache: 'none' })
  return { repository, provider, fs, changes }
}

describe('gitvfs against the GitHub mock', () => {
  it('lists directories and reads files', async () => {
    const { fs } = await setup()
    const root = await fs.readdir('')
    expect(root.map((entry) => [entry.name, entry.type]).sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['content', 'tree'],
      ['data', 'tree'],
      ['README.md', 'blob'],
    ])
    expect((await fs.readdir('content/posts')).map((entry) => entry.name).sort()).toEqual(['hello.md', 'second.md'])
    expect(await fs.readFile('content/posts/hello.md', { encoding: 'utf-8' })).toBe('---\ntitle: Hello\n---\n\nHi\n')
    expect(await fs.exists('content/posts/missing.md')).toBe(false)
  })

  it('reads the whole tree recursively', async () => {
    const { fs } = await setup()
    const entries = await fs.readdir('', { recursive: true })
    expect(entries.filter((entry) => entry.type === 'blob').map((entry) => entry.name).sort()).toEqual([
      'README.md',
      'content/posts/hello.md',
      'content/posts/second.md',
      'data/site.json',
    ])
  })

  it('commits creates, updates, renames and deletes', async () => {
    const { fs, repository, changes } = await setup()
    fs.writeFile('content/posts/new.md', '---\ntitle: New\n---\n')
    fs.writeFile('data/site.json', '{"title":"Renamed"}\n')
    fs.rm('content/posts/second.md')
    fs.writeFile('content/posts/2nd.md', '---\ntitle: Second\n---\n')
    fs.rm('README.md')
    const result = await fs.commit('Edit everything')

    expect(result.sha).toBe(repository.branchHead('main'))
    expect(Object.keys(result.files).sort()).toEqual(['content/posts/2nd.md', 'content/posts/new.md', 'data/site.json'])
    expect(Object.keys(repository.files('main')!).sort()).toEqual([
      'content/posts/2nd.md',
      'content/posts/hello.md',
      'content/posts/new.md',
      'data/site.json',
    ])
    expect(new TextDecoder().decode(repository.readFile('main', 'data/site.json')!.content)).toBe('{"title":"Renamed"}\n')
    expect(repository.log('main').map((commit) => commit.message)).toEqual(['Edit everything', 'Initial commit'])
    expect(changes).toEqual([result.sha])

    // A fresh reader sees the new head.
    const reader = new GitFS({ provider: github({ owner: 'acme', repo: 'site', token: 't' }), branch: 'main', cache: 'none' })
    expect(await reader.readFile('content/posts/new.md', { encoding: 'utf-8' })).toBe('---\ntitle: New\n---\n')
  })

  it('rejects commits whose expected head is stale, like GitHub', async () => {
    const { repository } = await setup()
    const stale = repository.branchHead('main')!
    await repository.commit({ branch: 'main', message: 'Someone else', additions: [{ path: 'x.txt', content: new Uint8Array([1]) }] })
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
        variables: {
          input: {
            branch: { repositoryNameWithOwner: 'acme/site', branchName: 'main' },
            expectedHeadOid: stale,
            message: { headline: 'Mine' },
            fileChanges: { additions: [{ path: 'y.txt', contents: btoa('y') }] },
          },
        },
      }),
    })
    const body = await response.json()
    expect(body.errors[0]).toMatchObject({ type: 'STALE_DATA' })
    expect(repository.readFile('main', 'y.txt')).toBeUndefined()
  })

  it('renames files with their content through the real provider', async () => {
    const { fs, repository } = await setup()
    fs.rename('content/posts/hello.md', 'content/posts/hi.md')
    fs.writeFile('content/posts/second.md', '---\ntitle: Second, edited\n---\n')
    fs.rename('content/posts/second.md', 'content/posts/2nd.md')
    await fs.commit('Rename posts')

    const read = (path: string) => {
      const file = repository.readFile('main', path)
      return file && new TextDecoder().decode(file.content)
    }
    expect(read('content/posts/hi.md')).toBe('---\ntitle: Hello\n---\n\nHi\n')
    expect(read('content/posts/2nd.md')).toBe('---\ntitle: Second, edited\n---\n')
    expect(read('content/posts/hello.md')).toBeUndefined()
    expect(read('content/posts/second.md')).toBeUndefined()
  })

  it('tolerates duplicate deletions in one commit', async () => {
    const { repository } = await setup()
    await repository.commit({ branch: 'main', message: 'Delete', deletions: ['README.md', 'README.md'] })
    expect(repository.readFile('main', 'README.md')).toBeUndefined()
  })

  it('creates branches and commits to a separate write branch', async () => {
    const { repository, provider } = await setup()
    const fs = new GitFS({ provider, branch: 'main', writeBranch: 'drafts', cache: 'none' })
    fs.writeFile('content/posts/draft.md', 'draft\n')
    await fs.commit('Draft')
    expect(repository.branchNames().sort()).toEqual(['drafts', 'main'])
    expect(repository.readFile('drafts', 'content/posts/draft.md')).toBeDefined()
    expect(repository.readFile('main', 'content/posts/draft.md')).toBeUndefined()
  })

  it('serves blobs and the signed-in user', async () => {
    const { repository } = await setup()
    const sha = repository.readFile('main', 'README.md')!.sha
    const headers = { Authorization: 'Bearer t' }
    const blob = await (await fetch(`https://api.github.com/repos/acme/site/git/blobs/${sha}`, { headers })).json()
    expect(atob(blob.content)).toBe('# Demo\n')
    expect(await (await fetch('https://api.github.com/user', { headers })).json()).toMatchObject({ login: 'demo' })
  })

  it('requires a token, like GitHub', async () => {
    await setup()
    expect((await fetch('https://api.github.com/repos/acme/site/contents?ref=main')).status).toBe(401)
    expect((await fetch('https://api.github.com/graphql', { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('computes git blob ids', async () => {
    const { repository } = await setup({ 'hello.txt': 'hello\n' })
    // `printf 'hello\n' | git hash-object --stdin`
    expect(repository.readFile('main', 'hello.txt')!.sha).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })
})

describe('persistentRepository', () => {
  function memoryStorage(): StorageLike & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    }
  }

  it('saves changes, restores them, and resets to the seed', async () => {
    const storage = memoryStorage()
    const seed = () => MockRepository.create({ files: { 'a.txt': 'a' } })
    const first = await persistentRepository({ key: 'demo', seed, storage })
    await first.repository.commit({ branch: 'main', message: 'Add b', additions: [{ path: 'b.txt', content: new TextEncoder().encode('b') }] })
    first.save()

    const second = await persistentRepository({ key: 'demo', seed, storage })
    expect(Object.keys(second.repository.files('main')!).sort()).toEqual(['a.txt', 'b.txt'])

    const before = second.repository
    await second.reset()
    expect(second.repository).toBe(before)
    expect(Object.keys(second.repository.files('main')!)).toEqual(['a.txt'])
    expect(JSON.parse(storage.data.get('demo')!).branches.main).toBe(second.repository.branchHead('main'))
  })

  it('starts from the seed when the saved state is unreadable', async () => {
    const storage = memoryStorage()
    storage.setItem('demo', '{broken')
    const { repository } = await persistentRepository({ key: 'demo', seed: () => MockRepository.create({ files: { 'a.txt': 'a' } }), storage })
    expect(Object.keys(repository.files('main')!)).toEqual(['a.txt'])
  })
})
