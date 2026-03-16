import { useSuspenseQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { AsyncBoundary } from '../components/AsyncBoundary'
import {
  getDirectoryQueryOptions,
  getRepositoriesQueryOptions,
  type RepoCard,
} from '../lib/git-data'

export function RepositoriesPage() {
  const { providerConfig, token } = useRouteContext({ from: '/repositories' }) as {
    providerConfig: { provider: 'github' | 'gitlab'; apiUrl?: string }
    token: string
  }

  const providerName = providerConfig.provider === 'github' ? 'GitHub' : 'GitLab'

  return (
    <AsyncBoundary
      resetKey={providerConfig.provider}
      fallback={(
        <section className="stack-page">
          <div className="loading-inline">
            <div className="spinner spinner-sm"></div>
            Loading repositories…
          </div>
        </section>
      )}
      errorTitle="Could not load repositories."
    >
      <RepositoriesContent providerName={providerName} provider={providerConfig.provider} token={token} apiUrl={providerConfig.apiUrl} />
    </AsyncBoundary>
  )
}

function RepositoriesContent(props: {
  providerName: string
  provider: 'github' | 'gitlab'
  token: string
  apiUrl?: string
}) {
  const queryClient = useQueryClient()
  const { data: repositories } = useSuspenseQuery(
    getRepositoriesQueryOptions({
      provider: props.provider,
      token: props.token,
      apiUrl: props.apiUrl,
    }),
  )

  return (
    <section className="stack-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Saved Token</p>
          <h1 className="section-title">{props.providerName} repositories</h1>
        </div>
        <p className="section-copy">
          Select a repository to open the routed editor experience powered by <code>gitvfs</code>.
        </p>
      </div>

      {repositories.length === 0 ? (
        <div className="empty-state">No repositories found for this account.</div>
      ) : (
        <div className="repo-list">
          {repositories.map((repo) => (
            <Link
              key={repo.kind === 'github' ? `${repo.owner}/${repo.repo}` : `${repo.projectId}`}
              to="/editor"
              search={repo}
              className="repo-card"
              onMouseEnter={() => {
                queryClient.prefetchQuery(
                  getDirectoryQueryOptions({ ...repo, token: props.token }, ''),
                ).catch(() => {
                  // Ignore warm-up failures — navigation will surface the real error.
                })
              }}
            >
              <div className="repo-card-header">
                <span className="repo-card-name">{repo.label}</span>
                <span className={`repo-visibility repo-visibility-${repo.visibility}`}>{repo.visibility}</span>
              </div>
              {repo.description ? <p className="repo-card-copy">{repo.description}</p> : null}
              <div className="repo-card-meta">
                <span>Branch: {repo.branch}</span>
                <span>{repo.updatedAt ? `Updated ${new Date(repo.updatedAt).toLocaleString()}` : 'No recent activity'}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}
