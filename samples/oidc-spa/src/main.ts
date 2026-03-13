import { createOidc } from 'oidc-spa/core'
import { renderRepoList } from './repos'
import './style.css'

type Provider = 'github' | 'gitlab'

const PROVIDER_KEY = 'git-fs-provider'
const appEl = document.getElementById('app')!

async function init() {
  const githubIssuer = import.meta.env.VITE_GITHUB_OIDC_ISSUER_URI
  const githubClientId = import.meta.env.VITE_GITHUB_OIDC_CLIENT_ID
  const gitlabIssuer = import.meta.env.VITE_GITLAB_OIDC_ISSUER_URI
  const gitlabClientId = import.meta.env.VITE_GITLAB_OIDC_CLIENT_ID

  const hasGitHub = !!(githubIssuer && githubClientId)
  const hasGitLab = !!(gitlabIssuer && gitlabClientId)

  if (!hasGitHub && !hasGitLab) {
    appEl.innerHTML = `
      <div class="error-page">
        <h1>Configuration Required</h1>
        <p>Please create a <code>.env</code> file based on <code>.env.example</code> and configure
           at least one Git provider's OIDC settings.</p>
        <p>See <a href="README.md">README.md</a> for setup instructions.</p>
      </div>
    `
    return
  }

  let selectedProvider = localStorage.getItem(PROVIDER_KEY) as Provider | null

  // Validate stored provider is still configured
  if (selectedProvider === 'github' && !hasGitHub) selectedProvider = null
  if (selectedProvider === 'gitlab' && !hasGitLab) selectedProvider = null

  // Auto-select if only one provider is available
  if (!selectedProvider) {
    if (hasGitHub && !hasGitLab) selectedProvider = 'github'
    else if (hasGitLab && !hasGitHub) selectedProvider = 'gitlab'
  }

  if (!selectedProvider) {
    renderProviderPicker(hasGitHub, hasGitLab)
    return
  }

  const issuerUri = selectedProvider === 'github' ? githubIssuer : gitlabIssuer
  const clientId = selectedProvider === 'github' ? githubClientId : gitlabClientId

  let oidc: Awaited<ReturnType<typeof createOidc>>
  try {
    oidc = await createOidc({ issuerUri, clientId })
  } catch (err) {
    appEl.innerHTML = `
      <div class="error-page">
        <h1>OIDC Initialization Failed</h1>
        <p>${err instanceof Error ? err.message : String(err)}</p>
        <p>Check that your OIDC configuration is correct.</p>
        <button class="btn btn-ghost btn-sm" id="change-provider-btn">← Change Provider</button>
      </div>
    `
    document.getElementById('change-provider-btn')?.addEventListener('click', () => {
      localStorage.removeItem(PROVIDER_KEY)
      location.reload()
    })
    return
  }

  function logout() {
    localStorage.removeItem(PROVIDER_KEY)
    oidc.logout({ redirectTo: 'home' })
  }

  if (!oidc.isUserLoggedIn) {
    renderLoginPage(oidc, selectedProvider, hasGitHub && hasGitLab)
  } else {
    const { accessToken } = oidc.getTokens()
    renderRepoList(appEl, accessToken, selectedProvider, logout)
  }
}

function renderProviderPicker(hasGitHub: boolean, hasGitLab: boolean) {
  appEl.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
          </svg>
        </div>
        <h1>git-fs Demo</h1>
        <p class="login-description">Browse and edit files in your Git repositories.</p>
        <div class="provider-buttons">
          ${hasGitHub ? `
            <button id="github-btn" class="btn btn-provider">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
              </svg>
              Continue with GitHub
            </button>` : ''}
          ${hasGitLab ? `
            <button id="gitlab-btn" class="btn btn-provider">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/>
              </svg>
              Continue with GitLab
            </button>` : ''}
        </div>
      </div>
    </div>
  `

  document.getElementById('github-btn')?.addEventListener('click', () => {
    localStorage.setItem(PROVIDER_KEY, 'github')
    location.reload()
  })
  document.getElementById('gitlab-btn')?.addEventListener('click', () => {
    localStorage.setItem(PROVIDER_KEY, 'gitlab')
    location.reload()
  })
}

function renderLoginPage(
  oidc: Awaited<ReturnType<typeof createOidc>>,
  provider: Provider,
  canSwitch: boolean,
) {
  const providerName = provider === 'github' ? 'GitHub' : 'GitLab'
  appEl.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          ${provider === 'github' ? `
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
            </svg>` : `
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/>
            </svg>`}
        </div>
        <h1>git-fs Demo</h1>
        <p class="login-description">
          Sign in with ${providerName} to browse and edit your repositories.
        </p>
        <button id="login-btn" class="btn btn-primary btn-lg">Sign in with ${providerName}</button>
        ${canSwitch ? `<button id="switch-btn" class="btn btn-ghost btn-sm" style="margin-top:8px">Use a different provider</button>` : ''}
      </div>
    </div>
  `

  document.getElementById('login-btn')!.addEventListener('click', () => {
    oidc.login({ doesCurrentHrefRequiresAuth: false })
  })
  document.getElementById('switch-btn')?.addEventListener('click', () => {
    localStorage.removeItem(PROVIDER_KEY)
    location.reload()
  })
}

init()
