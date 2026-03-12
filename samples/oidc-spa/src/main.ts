import { createOidc } from 'oidc-spa/core'
import { renderApp } from './app'
import './style.css'

const appEl = document.getElementById('app')!

async function init() {
  const issuerUri = import.meta.env.VITE_OIDC_ISSUER_URI
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID

  if (!issuerUri || !clientId) {
    appEl.innerHTML = `
      <div class="error-page">
        <h1>Configuration Required</h1>
        <p>Please create a <code>.env</code> file based on <code>.env.example</code> and set:</p>
        <ul>
          <li><code>VITE_OIDC_ISSUER_URI</code> — your OIDC provider issuer URL</li>
          <li><code>VITE_OIDC_CLIENT_ID</code> — your OAuth client ID</li>
          <li><code>VITE_GITHUB_OWNER</code> — GitHub repo owner</li>
          <li><code>VITE_GITHUB_REPO</code> — GitHub repo name</li>
        </ul>
        <p>See <a href="README.md">README.md</a> for setup instructions.</p>
      </div>
    `
    return
  }

  let oidc: Awaited<ReturnType<typeof createOidc>>

  try {
    oidc = await createOidc({
      issuerUri,
      clientId,
      // The redirect URI defaults to the current page URL.
      // After the OIDC provider redirects back, oidc-spa handles the code exchange
      // and then restores the original URL automatically.
    })
  } catch (err) {
    appEl.innerHTML = `
      <div class="error-page">
        <h1>OIDC Initialization Failed</h1>
        <p>${err instanceof Error ? err.message : String(err)}</p>
        <p>Check that your <code>VITE_OIDC_ISSUER_URI</code> and <code>VITE_OIDC_CLIENT_ID</code> are correct.</p>
      </div>
    `
    return
  }

  if (!oidc.isUserLoggedIn) {
    renderLoginPage(oidc)
  } else {
    const { accessToken } = oidc.getTokens()
    renderApp(appEl, accessToken, () => oidc.logout({ redirectTo: 'home' }))
  }
}

function renderLoginPage(oidc: Awaited<ReturnType<typeof createOidc>>) {
  appEl.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
          </svg>
        </div>
        <h1>git-fs Demo</h1>
        <p class="login-description">
          Browse and edit files in a GitHub repository, authenticated via OpenID Connect.
        </p>
        <button id="login-btn" class="btn btn-primary btn-lg">
          Sign In
        </button>
        <p class="login-hint">
          You will be redirected to your identity provider to sign in.
        </p>
      </div>
    </div>
  `

  document.getElementById('login-btn')!.addEventListener('click', async () => {
    await oidc.login({
      doesCurrentHrefRequiresAuth: false,
    })
  })
}

init()
