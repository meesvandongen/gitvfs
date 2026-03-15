import { Link, Outlet } from '@tanstack/react-router'
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  clearStoredProviderToken,
  getActiveProviderConfig,
  getProviderDisplayName,
  getProviderSessionSnapshot,
  hasMultipleProvidersConfigured,
  subscribeToProviderSession,
  type Provider,
} from '../lib/provider-config'
import {
  clearCachedUserProfile,
  fetchUserProfile,
  type UserProfile,
} from '../lib/user-profile'

export function AppFrame() {
  const session = useSyncExternalStore(
    subscribeToProviderSession,
    getProviderSessionSnapshot,
    getProviderSessionSnapshot,
  )
  const activeProviderConfig = getActiveProviderConfig()
  const token = session.tokens[session.activeProvider]
  const providerName = getProviderDisplayName(session.activeProvider)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-branding">
          <span className="eyebrow">Sample</span>
          <span className="topbar-title">git-fs · React + TanStack Router</span>
        </div>

        <nav className="topbar-nav">
          <Link to="/" className="topbar-link" activeProps={{ className: 'topbar-link topbar-link-active' }}>
            Home
          </Link>
          {token !== null && (
            <Link
              to="/repositories"
              className="topbar-link"
              activeProps={{ className: 'topbar-link topbar-link-active' }}
            >
              Repositories
            </Link>
          )}
        </nav>

        <div className="topbar-actions">
          <span className="provider-pill">{providerName}</span>
          <TokenButtons provider={session.activeProvider} token={token} apiUrl={activeProviderConfig.apiUrl} />
          {hasMultipleProvidersConfigured() && (
            <Link to="/" className="btn btn-ghost btn-sm">
              Change Provider
            </Link>
          )}
        </div>
      </header>

      <main className="page-shell">
        <Outlet />
      </main>
    </div>
  )
}

function TokenButtons(props: { provider: Provider; token: string | null; apiUrl?: string }) {
  const { provider, token, apiUrl } = props

  if (token === null) {
    return (
      <Link to="/" className="btn btn-primary btn-sm">
        Add Token
      </Link>
    )
  }

  return <ConnectedTokenButtons provider={provider} token={token} apiUrl={apiUrl} />
}

function ConnectedTokenButtons(props: { provider: Provider; token: string; apiUrl?: string }) {
  const { provider, token, apiUrl } = props
  const [profile, setProfile] = useState<UserProfile | null>(null)

  useEffect(() => {
    let cancelled = false

    setProfile(null)

    fetchUserProfile(provider, token, apiUrl)
      .then((result) => {
        if (!cancelled) {
          setProfile(result)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfile(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [apiUrl, provider, token])

  const displayName = profile?.name ?? `${getProviderDisplayName(provider)} token saved`
  const initials = displayName.slice(0, 1).toUpperCase()

  return (
    <div className="auth-group">
      <div className="user-chip" title={displayName}>
        {profile?.avatar ? (
          <img src={profile.avatar} alt={displayName} className="user-avatar" />
        ) : (
          <span className="user-avatar user-avatar-fallback">{initials}</span>
        )}
        <span className="user-name">{displayName}</span>
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          clearCachedUserProfile()
          clearStoredProviderToken(provider)
        }}
      >
        Clear Token
      </button>
    </div>
  )
}
