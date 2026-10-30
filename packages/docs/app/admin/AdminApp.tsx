import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AuthError, GitFS, NotFoundError, type TokenProvider } from 'gitvfs'
import { github } from 'gitvfs/providers/github'
import { createCms } from 'gitvfs-cms'
import { CmsApp } from 'gitvfs-cms/react'
import { createGitHubAuth, type GitHubAuth } from 'gitvfs-github-auth'
import 'gitvfs-cms/styles.css'
import { gitConfig } from '@/lib/shared'
import { collections, singletons } from './content'

const TOKEN_KEY = 'gitvfs-docs:github-token'
const BRANCH_KEY = 'gitvfs-docs:branch'

interface Session {
  method: 'github' | 'token'
  token: TokenProvider
  branch: string
}

function storageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode); the session then lasts until reload.
  }
}

function storedBranch(): string {
  return storageGet(BRANCH_KEY) || gitConfig.branch
}

function errorText(error: unknown): string {
  if (error instanceof AuthError) return 'GitHub rejected these credentials.'
  return error instanceof Error ? error.message : String(error)
}

/** Check the token can see the repository, and create the branch from the default one if needed. */
async function ensureBranch({ token, branch }: Session): Promise<void> {
  const provider = github({ owner: gitConfig.user, repo: gitConfig.repo, token })
  try {
    await provider.getBranch(branch)
  } catch (error) {
    if (!(error instanceof NotFoundError) || branch === gitConfig.branch) throw error
    const base = await provider.getBranch(gitConfig.branch)
    await provider.createBranch(branch, base.sha)
  }
}

/**
 * The docs Worker serves the GitHub App's client ID when sign-in is set up for the current
 * origin (see worker/index.ts). Elsewhere, such as on preview URLs, only tokens work.
 */
async function loadGitHubAuth(): Promise<GitHubAuth | null> {
  try {
    const response = await fetch('/api/github/config')
    const config = (await response.json()) as { clientId?: string | null }
    if (!config.clientId) return null
    return createGitHubAuth({
      clientId: config.clientId,
      tokenUrl: '/api/github/token',
      redirectUri: `${location.origin}/admin`,
    })
  } catch {
    return null
  }
}

type Boot =
  | { state: 'loading' }
  | { state: 'ready'; auth: GitHubAuth | null; session: Session | null; error?: string }

export default function AdminApp() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const auth = await loadGitHubAuth()
      let session: Session | null = null
      let error: string | undefined

      const pat = storageGet(TOKEN_KEY)
      if (pat) session = { method: 'token', token: pat, branch: storedBranch() }

      if (auth) {
        try {
          const returned = await auth.handleRedirect()
          if (returned || auth.isSignedIn()) {
            session = { method: 'github', token: auth.token, branch: storedBranch() }
            // The branch may be new: create it right after signing in.
            if (returned) await ensureBranch(session)
          }
        } catch (caught) {
          auth.signOut()
          session = null
          error = caught instanceof NotFoundError
            ? `Signed in, but the GitHub App cannot see ${gitConfig.user}/${gitConfig.repo}. Install the app on the repository and try again.`
            : errorText(caught)
        }
      }
      if (!cancelled) setBoot({ state: 'ready', auth, session, error })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (boot.state === 'loading') {
    return <p className="p-8 text-fd-muted-foreground">Loading editor…</p>
  }

  const signOut = () => {
    if (boot.session?.method === 'github') boot.auth?.signOut()
    storageSet(TOKEN_KEY, null)
    setBoot({ ...boot, session: null, error: undefined })
  }

  return boot.session ? (
    <Editor session={boot.session} auth={boot.auth} onSignOut={signOut} />
  ) : (
    <SignIn
      auth={boot.auth}
      initialError={boot.error}
      onSignIn={(session) => setBoot({ ...boot, session, error: undefined })}
    />
  )
}

function Editor(props: { session: Session; auth: GitHubAuth | null; onSignOut: () => void }) {
  const { session } = props
  const [login, setLogin] = useState<string | null>(null)

  useEffect(() => {
    if (session.method !== 'github' || !props.auth) return
    props.auth.fetchUser().then((user) => setLogin(user.login), () => setLogin(null))
  }, [session, props.auth])

  const cms = useMemo(
    () =>
      createCms({
        fs: new GitFS({
          provider: github({ owner: gitConfig.user, repo: gitConfig.repo, token: session.token }),
          branch: session.branch,
        }),
        collections,
        singletons,
      }),
    [session],
  )

  return (
    <div className="h-screen">
      <CmsApp
        cms={cms}
        title={
          <a href="/docs" className="hover:underline">
            gitvfs docs
          </a>
        }
        sidebarFooter={
          <div className="flex flex-col gap-2 text-xs">
            {login ? <span>Signed in as @{login}</span> : null}
            <span className="gcms-muted">
              {gitConfig.user}/{gitConfig.repo} @ {session.branch}
            </span>
            <button type="button" className="gcms-button gcms-button--small" onClick={props.onSignOut}>
              Sign out
            </button>
          </div>
        }
      />
    </div>
  )
}

const inputClass = 'rounded-md border bg-fd-background px-3 py-2 font-normal'
const primaryButtonClass =
  'rounded-full bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground disabled:opacity-60'

function SignIn(props: {
  auth: GitHubAuth | null
  initialError?: string
  onSignIn: (session: Session) => void
}) {
  const [token, setToken] = useState('')
  const [branch, setBranch] = useState(storedBranch)
  const [status, setStatus] = useState<{ busy: boolean; error?: string }>({
    busy: false,
    error: props.initialError,
  })
  const chosenBranch = () => branch.trim() || gitConfig.branch

  const signInWithGitHub = async () => {
    if (!props.auth) return
    setStatus({ busy: true })
    storageSet(BRANCH_KEY, chosenBranch())
    await props.auth.login()
  }

  const signInWithToken = async (event: FormEvent) => {
    event.preventDefault()
    const session: Session = { method: 'token', token: token.trim(), branch: chosenBranch() }
    if (!token.trim()) return
    setStatus({ busy: true })
    try {
      await ensureBranch(session)
      storageSet(TOKEN_KEY, token.trim())
      storageSet(BRANCH_KEY, session.branch)
      props.onSignIn(session)
    } catch (error) {
      setStatus({ busy: false, error: errorText(error) })
    }
  }

  const tokenForm = (
    <form className="flex flex-col gap-4" onSubmit={signInWithToken}>
      <label className="flex flex-col gap-1 text-sm font-medium">
        GitHub token
        <input
          type="password"
          autoComplete="off"
          required
          className={inputClass}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <span className="font-normal text-fd-muted-foreground">
          A{' '}
          <a
            className="underline"
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noreferrer"
          >
            fine-grained token
          </a>{' '}
          with Contents read and write access to the repository.
        </span>
      </label>
      <button
        type="submit"
        disabled={status.busy}
        className={props.auth ? 'rounded-full border px-4 py-2.5 text-sm font-medium disabled:opacity-60' : primaryButtonClass}
      >
        {status.busy ? 'Checking access…' : 'Open editor'}
      </button>
    </form>
  )

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">Edit the gitvfs docs</h1>
        <p className="text-sm text-fd-muted-foreground">
          These docs are MDX files in{' '}
          <code>
            {gitConfig.user}/{gitConfig.repo}
          </code>
          . This editor is gitvfs-cms running in your browser: every save is a commit made in your
          name, with credentials that stay in this tab's session storage.
        </p>
      </div>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Branch
        <input className={inputClass} value={branch} onChange={(event) => setBranch(event.target.value)} />
        <span className="font-normal text-fd-muted-foreground">
          Commits go here. A new branch is created from main; open a pull request to have changes reviewed.
        </span>
      </label>
      {status.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {status.error}
        </p>
      ) : null}
      {props.auth ? (
        <>
          <button type="button" disabled={status.busy} className={primaryButtonClass} onClick={signInWithGitHub}>
            Sign in with GitHub
          </button>
          <details className="text-sm">
            <summary className="cursor-pointer text-fd-muted-foreground">Use a personal access token instead</summary>
            <div className="mt-4">{tokenForm}</div>
          </details>
        </>
      ) : (
        tokenForm
      )}
    </main>
  )
}
