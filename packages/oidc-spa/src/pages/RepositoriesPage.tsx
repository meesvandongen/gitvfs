import { Link, useLoaderData } from '@tanstack/react-router'
import type { RepoCard } from '../lib/git-data'

export function RepositoriesPage() {
  const data = useLoaderData({ from: '/repositories' }) as {
    providerName: string
    repositories: RepoCard[]
  }

  return (
    <section className="stack-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Saved Token</p>
          <h1 className="section-title">{data.providerName} repositories</h1>
        </div>
        <p className="section-copy">
          Select a repository to open the routed editor experience powered by <code>git-fs</code>.
        </p>
      </div>

      {data.repositories.length === 0 ? (
        <div className="empty-state">No repositories found for this account.</div>
      ) : (
        <div className="repo-list">
          {data.repositories.map((repo) => (
            <Link
              key={repo.kind === 'github' ? `${repo.owner}/${repo.repo}` : `${repo.projectId}`}
              to="/editor"
              search={repo}
              className="repo-card"
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
