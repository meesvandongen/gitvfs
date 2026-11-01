import { useMemo, useState, useSyncExternalStore } from 'react'
import { GitFS } from 'gitvfs'
import { github } from 'gitvfs/providers/github'
import { createCms } from 'gitvfs-cms'
import { CmsApp } from 'gitvfs-cms/react'
import type { MockRepository } from 'gitvfs-github-msw'
import { ColorField } from './ColorField'
import { collections, singletons } from './content'
import { AuthorPreview, EventPreview } from './previews'

const DOCS_URL = 'https://docs.gitvfs.mvd.im/docs/cms'

interface AppProps {
  repository: MockRepository
  subscribe: (listener: () => void) => () => void
  reset: () => Promise<void>
}

function timeAgo(date: string): string {
  const seconds = Math.round((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(date).toLocaleDateString()
}

export function App({ repository, subscribe, reset }: AppProps) {
  // Re-render when the mock repository changes (every commit), to update the history.
  const head = useSyncExternalStore(subscribe, () => repository.branchHead('main'))
  const [generation, setGeneration] = useState(0)

  // A fresh CMS after a reset, so no cached file survives it.
  const cms = useMemo(
    () =>
      createCms({
        fs: new GitFS({ repository: github({ token: 'demo' }).repository('acme/site'), branch: 'main' }),
        collections,
        singletons,
      }),
    [generation],
  )
  const history = useMemo(() => repository.log('main', 6), [repository, head])

  const resetDemo = async () => {
    if (!window.confirm('Throw away all your changes and start over?')) return
    await reset()
    setGeneration((value) => value + 1)
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
        <CmsApp
          key={generation}
          cms={cms}
          title="Acme content"
          formComponents={{ color: ColorField }}
          previews={{ authors: AuthorPreview, events: EventPreview }}
          sidebarFooter={
            <div className="demo-history">
              <p className="gcms-nav-heading">History · acme/site</p>
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
      </div>
    </div>
  )
}
