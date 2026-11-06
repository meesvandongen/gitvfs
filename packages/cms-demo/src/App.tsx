import { useMemo, useState, useSyncExternalStore } from 'react'
import { GitVFS } from 'gitvfs'
import { github } from 'gitvfs/providers/github'
import { createCms, nominatimGeocoder, type MapOptions } from 'gitvfs-cms'
import { CmsApp, RepositoryPicker } from 'gitvfs-cms/react'
import type { MockRepository } from 'gitvfs-github-msw'
import { CodeMirrorField } from 'gitvfs-cms/codemirror'
import { MermaidField } from 'gitvfs-cms/mermaid'
import { ColorField } from './ColorField'
import { collections, media, singletons } from './content'
import { AuthorPreview, EventPreview, ShowPreview } from './previews'

const DOCS_URL = 'https://docs.gitvfs.mvd.im/docs/cms'

// Address search on every map field, through OpenStreetMap's public Nominatim instance: searches
// run on Enter only, at most one per second, and repeated ones come from a cache, as its usage
// policy asks (https://operations.osmfoundation.org/policies/nominatim/).
const mapDefaults: MapOptions = { geocoder: nominatimGeocoder({ language: 'en' }) }

// Both optional subpaths: CodeMirror for code fields, and live Mermaid previews (in the field and
// for ```mermaid blocks in markdown). Mermaid fields keep the built-in editor, so the demo shows
// both editors; mermaid itself loads only when a diagram is on screen.
const formComponents = {
  color: ColorField,
  code: CodeMirrorField,
  mermaid: MermaidField,
}

export interface DemoRepository {
  fullName: string
  repository: MockRepository
}

interface AppProps {
  repositories: DemoRepository[]
  subscribe: (listener: () => void) => () => void
  reset: () => Promise<void>
}

const CURRENT_KEY = 'gitvfs-cms-demo:current'

function storedRepository(repositories: DemoRepository[]): string {
  try {
    const stored = localStorage.getItem(CURRENT_KEY)
    if (repositories.some((entry) => entry.fullName === stored)) return stored!
  } catch {
    // Storage blocked: start with the first repository.
  }
  return repositories[0].fullName
}

function timeAgo(date: string): string {
  const seconds = Math.round((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(date).toLocaleDateString()
}

export function App({ repositories, subscribe, reset }: AppProps) {
  // Every GitHub API call goes to the mock in this browser, so any token works.
  const provider = useMemo(() => github({ token: 'demo' }), [])
  const [current, setCurrent] = useState(() => storedRepository(repositories))
  const [picking, setPicking] = useState(false)
  const { repository } = repositories.find((entry) => entry.fullName === current) ?? repositories[0]

  const [generation, setGeneration] = useState(0)

  // A fresh CMS per repository, and after a reset, so no cached file survives it.
  const cms = useMemo(
    () =>
      createCms({
        fs: new GitVFS({ repository: provider.repository(current), branch: 'main' }),
        collections,
        singletons,
        media,
        // Edit in changes: branches that are reviewed in a pull request and merged to publish.
        changes: true,
      }),
    [provider, current, generation],
  )
  // The branch being edited, and its head, which moves on every commit.
  const { branch } = useSyncExternalStore(cms.subscribe, cms.getState)
  const head = useSyncExternalStore(subscribe, () => repository.branchHead(branch))
  const history = useMemo(() => repository.log(branch, 6), [repository, branch, head])

  const resetDemo = async () => {
    if (!window.confirm('Throw away all your changes and start over?')) return
    await reset()
    setGeneration((value) => value + 1)
  }

  const choose = (fullName: string) => {
    setCurrent(fullName)
    setPicking(false)
    try {
      localStorage.setItem(CURRENT_KEY, fullName)
    } catch {
      // Not remembered across reloads; the demo still works.
    }
  }

  return (
    <div className="demo-shell">
      <header className="demo-banner">
        <strong>gitvfs-cms demo</strong>
        <span>
          The real editor, against a GitHub API mocked in your browser: changes become commits in a copy of the repository
          that only you can see.
        </span>
        <a href={DOCS_URL}>Docs</a>
      </header>
      <div className="demo-app">
        {picking ? (
          <RepositoryPicker
            provider={provider}
            title="Choose a repository to edit"
            onSelect={(picked) => choose(picked.fullName)}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <CmsApp
            key={`${current}:${generation}`}
            cms={cms}
            title="Acme content"
            formComponents={formComponents}
            mapDefaults={mapDefaults}
            previews={{ authors: AuthorPreview, events: EventPreview, shows: ShowPreview }}
            sidebarFooter={
              <div className="demo-history">
                <div className="demo-repository">
                  <p className="gcms-nav-heading">Repository</p>
                  <strong>{current}</strong>
                  <button type="button" className="gcms-button gcms-button--small" onClick={() => setPicking(true)}>
                    Switch repository
                  </button>
                </div>
                <p className="gcms-nav-heading">History of {branch}</p>
                <ol>
                  {history.map((commit) => (
                    <li key={commit.sha} title={commit.sha}>
                      <span>{commit.message}</span>
                      <time dateTime={commit.date}>
                        {commit.sha.slice(0, 7)} · {timeAgo(commit.date)}
                      </time>
                    </li>
                  ))}
                </ol>
                <button type="button" className="gcms-button gcms-button--small" onClick={() => void resetDemo()}>
                  Reset demo
                </button>
              </div>
            }
          />
        )}
      </div>
    </div>
  )
}
