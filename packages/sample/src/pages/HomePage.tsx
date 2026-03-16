import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState, useSyncExternalStore } from 'react'
import {
  clearStoredProviderToken,
  getActiveProviderConfig,
  getConfiguredProviders,
  getProviderDisplayName,
  getProviderSessionSnapshot,
  persistProviderToken,
  persistSelectedProvider,
  subscribeToProviderSession,
  type Provider,
} from '../lib/provider-config'
import { clearCachedUserProfile, fetchUserProfile, type UserProfile } from '../lib/user-profile'

export function HomePage() {
  const navigate = useNavigate()
  const session = useSyncExternalStore(
    subscribeToProviderSession,
    getProviderSessionSnapshot,
    getProviderSessionSnapshot,
  )
  const activeProviderConfig = getActiveProviderConfig()
  const activeProvider = session.activeProvider
  const providerName = getProviderDisplayName(activeProvider)
  const savedToken = session.tokens[activeProvider]

  const [draftToken, setDraftToken] = useState(savedToken ?? '')
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraftToken(savedToken ?? '')
  }, [activeProvider, savedToken])

  useEffect(() => {
    if (savedToken === null) {
      setProfile(null)
      return
    }

    let cancelled = false

    fetchUserProfile(activeProvider, savedToken, activeProviderConfig.apiUrl)
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
  }, [activeProvider, activeProviderConfig.apiUrl, savedToken])

  async function handleSaveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const normalizedToken = draftToken.trim()

    if (normalizedToken.length === 0) {
      setErrorMessage(`Paste a ${providerName} personal access token before saving.`)
      setStatusMessage(null)
      return
    }

    setIsSaving(true)
    setErrorMessage(null)
    setStatusMessage(null)

    persistSelectedProvider(activeProvider)
    persistProviderToken(activeProvider, normalizedToken)
    clearCachedUserProfile()

    try {
      const nextProfile = await fetchUserProfile(activeProvider, normalizedToken, activeProviderConfig.apiUrl)
      setProfile(nextProfile)
      setStatusMessage(`Saved your ${providerName} token in local storage for this browser.`)
      navigate({ to: '/repositories' })
    } catch (error) {
      setProfile(null)
      setErrorMessage(
        `${providerName} rejected that token. It is still saved locally, but you should double-check the token value and scopes. (${error instanceof Error ? error.message : String(error)})`,
      )
    } finally {
      setIsSaving(false)
    }
  }

  function handleProviderSelect(provider: Provider) {
    clearCachedUserProfile()
    persistSelectedProvider(provider)
    setStatusMessage(null)
    setErrorMessage(null)
  }

  function handleClearToken() {
    clearCachedUserProfile()
    clearStoredProviderToken(activeProvider)
    setProfile(null)
    setDraftToken('')
    setErrorMessage(null)
    setStatusMessage(`Removed the saved ${providerName} token from local storage.`)
  }

  return (
    <section className="home-grid">
      <div className="hero-card hero-card-wide">
        <p className="eyebrow">Quick Start</p>
        <div className="hero-row">
          <h1 className="hero-title">Bring your own token and browse away.</h1>
          <div className="status-pill">{savedToken ? `Ready for ${providerName}` : `Waiting for a ${providerName} token`}</div>
        </div>
        <p className="hero-copy">
          This sample uses a direct token flow. Pick GitHub or GitLab, paste a personal access token,
          store it in browser storage, then browse repositories and edit files with routed navigation.
        </p>
        <div className="hero-actions">
          {savedToken === null ? (
            <a href={activeProviderConfig.createTokenUrl} target="_blank" rel="noreferrer" className="btn btn-primary btn-lg">
              Create a {providerName} token
            </a>
          ) : (
            <Link to="/repositories" className="btn btn-primary btn-lg">
              Browse repositories
            </Link>
          )}
          <span className="helper-copy">
            Tokens are saved in <code>localStorage</code> on this device only — gloriously simple, mildly opinionated, and refresh-proof.
          </span>
        </div>
      </div>

      <section className="hero-card">
        <p className="eyebrow">Manual Access</p>
        <h2 className="section-title">Connect {providerName}</h2>
        <p className="section-copy">
          Select a provider, paste a personal access token, and the app will keep it in browser storage for future sessions.
        </p>

        <div className="provider-grid">
          {getConfiguredProviders().map((provider) => {
            return (
              <button
                key={provider}
                type="button"
                className={`provider-card provider-card-${provider} ${provider === activeProvider ? 'provider-card-active' : ''}`}
                aria-pressed={provider === activeProvider}
                onClick={() => handleProviderSelect(provider)}
              >
                <span className="provider-card-title">{getProviderDisplayName(provider)}</span>
                <span className="provider-card-copy">
                  {provider === 'github'
                    ? 'Use a GitHub personal access token to list repositories, read files, and commit edits.'
                    : 'Use a GitLab personal access token to list projects, read files, and commit edits.'}
                </span>
              </button>
            )
          })}
        </div>

        <form className="token-form" onSubmit={(event) => void handleSaveToken(event)}>
          <label htmlFor="personal-access-token" className="field-label">
            Personal access token
          </label>
          <input
            id="personal-access-token"
            className="token-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)}
            placeholder={`Paste your ${providerName} token`}
          />
          <p className="field-help">
            Create one at{' '}
            <a href={activeProviderConfig.createTokenUrl} target="_blank" rel="noreferrer">
              {activeProviderConfig.createTokenUrl}
            </a>
            . {activeProviderConfig.tokenScopesHint}
            {activeProviderConfig.apiUrl ? ` This sample will talk to ${activeProviderConfig.apiUrl}.` : ''}
          </p>

          {savedToken !== null && (
            <div className="token-preview">
              Saved token: {maskToken(savedToken)}
              {profile ? ` • ${profile.name}` : ''}
            </div>
          )}

          {errorMessage ? <div className="callout callout-danger">{errorMessage}</div> : null}
          {statusMessage ? <div className="callout callout-success">{statusMessage}</div> : null}

          <div className="inline-actions">
            <button type="submit" className="btn btn-primary" disabled={isSaving || draftToken.trim().length === 0}>
              {isSaving ? 'Saving…' : 'Save token'}
            </button>
            {savedToken !== null && (
              <Link to="/repositories" className="btn btn-ghost">
                Use saved token
              </Link>
            )}
            {savedToken !== null && (
              <button type="button" className="btn btn-ghost" onClick={handleClearToken}>
                Clear token
              </button>
            )}
          </div>
        </form>
      </section>

      <div className="info-grid">
        <InfoCard
          title="Token-based flow"
          body="The sample asks for a personal access token directly, stores it locally, and uses it for repository access."
        />
        <InfoCard
          title="Browser storage"
          body="Tokens are stored locally in the browser so refreshes are painless and setup stays delightfully boring."
        />
        <InfoCard
          title="Provider-aware"
          body={`The active provider is ${providerName}. You can switch between GitHub and GitLab without changing the code.`}
        />
        <InfoCard
          title="Editor workflow"
          body="Repository selection opens a dedicated editor route that keeps repo metadata in the URL search state."
        />
      </div>
    </section>
  )
}

function InfoCard(props: { title: string; body: string }) {
  const { title, body } = props

  return (
    <article className="info-card">
      <h2>{title}</h2>
      <p>{body}</p>
    </article>
  )
}

function maskToken(token: string): string {
  if (token.length <= 8) {
    return '•'.repeat(token.length)
  }

  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}
