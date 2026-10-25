import { useMemo, useState, type FormEvent } from 'react'
import { AuthError, GitFS, NotFoundError } from 'gitvfs'
import { github } from 'gitvfs/providers/github'
import { createCms } from 'gitvfs-cms'
import { CmsApp } from 'gitvfs-cms/react'
import 'gitvfs-cms/styles.css'
import { gitConfig } from '@/lib/shared'
import { collections, singletons } from './content'

const TOKEN_KEY = 'gitvfs-docs:github-token'
const BRANCH_KEY = 'gitvfs-docs:branch'

interface Session {
  token: string
  branch: string
}

function readSession(): Session | null {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY)
    return token ? { token, branch: sessionStorage.getItem(BRANCH_KEY) || gitConfig.branch } : null
  } catch {
    return null
  }
}

function writeSession(session: Session | null) {
  try {
    if (session) {
      sessionStorage.setItem(TOKEN_KEY, session.token)
      sessionStorage.setItem(BRANCH_KEY, session.branch)
    } else {
      sessionStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(BRANCH_KEY)
    }
  } catch {
    // Storage can be unavailable (private mode); the session then lasts until reload.
  }
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

export default function AdminApp() {
  const [session, setSession] = useState<Session | null>(readSession)

  const update = (next: Session | null) => {
    writeSession(next)
    setSession(next)
  }

  return session ? (
    <Editor session={session} onSignOut={() => update(null)} />
  ) : (
    <SignIn onSignIn={update} />
  )
}

function Editor({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
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
            <span className="gcms-muted">
              {gitConfig.user}/{gitConfig.repo} @ {session.branch}
            </span>
            <button type="button" className="gcms-button gcms-button--small" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        }
      />
    </div>
  )
}

function SignIn({ onSignIn }: { onSignIn: (session: Session) => void }) {
  const [token, setToken] = useState('')
  const [branch, setBranch] = useState(gitConfig.branch)
  const [status, setStatus] = useState<{ busy: boolean; error?: string }>({ busy: false })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const session = { token: token.trim(), branch: branch.trim() || gitConfig.branch }
    if (!session.token) return
    setStatus({ busy: true })
    try {
      await ensureBranch(session)
      onSignIn(session)
    } catch (error) {
      setStatus({
        busy: false,
        error: error instanceof AuthError
          ? 'GitHub rejected this token.'
          : error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">Edit the gitvfs docs</h1>
        <p className="text-sm text-fd-muted-foreground">
          These docs are MDX files in{' '}
          <code>
            {gitConfig.user}/{gitConfig.repo}
          </code>
          . This editor is gitvfs-cms running in your browser: every save is a commit made with your
          token, which stays in this tab's session storage.
        </p>
      </div>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <label className="flex flex-col gap-1 text-sm font-medium">
          GitHub token
          <input
            type="password"
            autoComplete="off"
            required
            className="rounded-md border bg-fd-background px-3 py-2 font-normal"
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
        <label className="flex flex-col gap-1 text-sm font-medium">
          Branch
          <input
            className="rounded-md border bg-fd-background px-3 py-2 font-normal"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
          <span className="font-normal text-fd-muted-foreground">
            Commits go here. A new branch is created from main; open a pull request to have changes reviewed.
          </span>
        </label>
        {status.error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {status.error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={status.busy}
          className="rounded-full bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground disabled:opacity-60"
        >
          {status.busy ? 'Checking access…' : 'Open editor'}
        </button>
      </form>
    </main>
  )
}
