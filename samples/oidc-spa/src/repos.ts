import { renderApp } from './app'

export type Provider = 'github' | 'gitlab'

// Minimal shapes from the GitHub / GitLab REST APIs
interface GitHubRepo {
  id: number
  full_name: string
  name: string
  owner: { login: string }
  default_branch: string
  private: boolean
  description: string | null
  pushed_at: string | null
}

interface GitLabProject {
  id: number
  path_with_namespace: string
  name: string
  default_branch: string | null
  visibility: string
  description: string | null
  last_activity_at: string | null
}

export function renderRepoList(
  appEl: HTMLElement,
  token: string,
  provider: Provider,
  onLogout: () => void,
) {
  const providerName = provider === 'github' ? 'GitHub' : 'GitLab'
  appEl.innerHTML = `
    <div class="repos-layout">
      <header class="repos-header">
        <div class="repos-header-left">
          ${providerIcon(provider, 20)}
          <span class="repos-title">${providerName} Repositories</span>
        </div>
        <button id="repos-logout-btn" class="btn btn-ghost btn-sm">Sign Out</button>
      </header>
      <main class="repos-main">
        <div id="repos-container" class="repos-container">
          <div class="loading-inline">
            <div class="spinner spinner-sm"></div>
            Loading repositories…
          </div>
        </div>
      </main>
    </div>
  `

  document.getElementById('repos-logout-btn')!.addEventListener('click', onLogout)

  loadRepos(appEl, token, provider, onLogout)
}

async function loadRepos(
  appEl: HTMLElement,
  token: string,
  provider: Provider,
  onLogout: () => void,
) {
  const container = document.getElementById('repos-container')!

  function onRepoSelected() {
    renderRepoList(appEl, token, provider, onLogout)
  }

  try {
    if (provider === 'github') {
      const repos = await fetchGitHubRepos(token)
      renderGitHubRepos(container, repos, (repo) => {
        renderApp(appEl, token, 'github', {
          owner: repo.owner.login,
          repo: repo.name,
          branch: repo.default_branch,
        }, onRepoSelected, onLogout)
      })
    } else {
      const projects = await fetchGitLabProjects(token)
      renderGitLabProjects(container, projects, (project) => {
        renderApp(appEl, token, 'gitlab', {
          projectId: project.id,
          branch: project.default_branch ?? 'main',
          name: project.path_with_namespace,
          apiUrl: import.meta.env.VITE_GITLAB_API_URL,
        }, onRepoSelected, onLogout)
      })
    }
  } catch (err) {
    container.innerHTML = `<div class="repos-error">Failed to load repositories: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`
  }
}

// ── GitHub API ──────────────────────────────────────────────────────────────

async function fetchGitHubRepos(token: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = []
  let url: string | null =
    'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    })
    if (!res.ok) throw new Error(`GitHub API error ${res.status}`)
    repos.push(...(await res.json() as GitHubRepo[]))
    const link = res.headers.get('Link') ?? ''
    const next = link.match(/<([^>]+)>;\s*rel="next"/)
    url = next ? next[1] : null
  }

  return repos
}

function renderGitHubRepos(
  container: HTMLElement,
  repos: GitHubRepo[],
  onSelect: (repo: GitHubRepo) => void,
) {
  if (repos.length === 0) {
    container.innerHTML = '<div class="repos-empty">No repositories found.</div>'
    return
  }

  container.innerHTML = repos.map((repo, i) => `
    <div class="repo-item" data-index="${i}">
      <div class="repo-item-main">
        <span class="repo-item-name">${escapeHtml(repo.full_name)}</span>
        ${repo.private ? '<span class="repo-badge repo-badge-private">private</span>' : ''}
      </div>
      ${repo.description ? `<div class="repo-item-desc">${escapeHtml(repo.description)}</div>` : ''}
    </div>
  `).join('')

  container.querySelectorAll('.repo-item').forEach((el) => {
    el.addEventListener('click', () => {
      onSelect(repos[parseInt((el as HTMLElement).dataset.index!, 10)])
    })
  })
}

// ── GitLab API ───────────────────────────────────────────────────────────────

async function fetchGitLabProjects(token: string): Promise<GitLabProject[]> {
  const base = (import.meta.env.VITE_GITLAB_API_URL ?? 'https://gitlab.com').replace(/\/$/, '')
  const projects: GitLabProject[] = []
  let page = 1

  while (true) {
    const res = await fetch(
      `${base}/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`GitLab API error ${res.status}`)
    const batch = await res.json() as GitLabProject[]
    projects.push(...batch)
    if (batch.length < 100) break
    page++
  }

  return projects
}

function renderGitLabProjects(
  container: HTMLElement,
  projects: GitLabProject[],
  onSelect: (project: GitLabProject) => void,
) {
  if (projects.length === 0) {
    container.innerHTML = '<div class="repos-empty">No projects found.</div>'
    return
  }

  container.innerHTML = projects.map((project, i) => `
    <div class="repo-item" data-index="${i}">
      <div class="repo-item-main">
        <span class="repo-item-name">${escapeHtml(project.path_with_namespace)}</span>
        ${project.visibility === 'private' ? '<span class="repo-badge repo-badge-private">private</span>' : ''}
      </div>
      ${project.description ? `<div class="repo-item-desc">${escapeHtml(project.description)}</div>` : ''}
    </div>
  `).join('')

  container.querySelectorAll('.repo-item').forEach((el) => {
    el.addEventListener('click', () => {
      onSelect(projects[parseInt((el as HTMLElement).dataset.index!, 10)])
    })
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function providerIcon(provider: Provider, size: number): string {
  if (provider === 'github') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>`
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/>
  </svg>`
}
