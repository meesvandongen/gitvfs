import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { Link } from 'react-router'
import { baseOptions } from '@/lib/layout.shared'

export function meta() {
  return [
    { title: 'gitvfs: Git repositories as a filesystem, and a CMS on top' },
    {
      name: 'description',
      content: 'Browse, edit and commit to GitHub and GitLab repositories from the browser.',
    },
  ]
}

const packages = [
  {
    name: 'gitvfs',
    href: '/docs/gitvfs',
    description: 'A filesystem-style API over the GitHub and GitLab APIs, with staging, caching and commits.',
  },
  {
    name: 'gitvfs-cms',
    href: '/docs/cms',
    description: 'Collections of markdown, JSON and YAML content, edited with forms and a live preview.',
  },
  {
    name: 'gitvfs-cms/oidc',
    href: '/docs/cms/authentication',
    description: 'Sign in with OpenID Connect through oidc-spa and use the session token for the Git API.',
  },
]

export default function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-16">
        <section className="flex flex-col items-start gap-4">
          <h1 className="text-4xl font-bold tracking-tight">Your Git repository is the backend.</h1>
          <p className="max-w-2xl text-lg text-fd-muted-foreground">
            gitvfs reads and writes repositories through the GitHub and GitLab APIs, straight from the
            browser. gitvfs-cms turns that into a content editor. No server, no database, every change a
            commit.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              className="rounded-full bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground"
              to="/docs"
            >
              Read the docs
            </Link>
            <Link className="rounded-full border px-4 py-2.5 text-sm font-medium" to="/admin">
              Edit these docs with gitvfs-cms
            </Link>
          </div>
        </section>
        <section className="grid gap-4 md:grid-cols-3">
          {packages.map((pkg) => (
            <Link
              key={pkg.name}
              to={pkg.href}
              className="rounded-xl border bg-fd-card p-5 transition-colors hover:bg-fd-accent"
            >
              <code className="text-sm font-semibold">{pkg.name}</code>
              <p className="mt-2 text-sm text-fd-muted-foreground">{pkg.description}</p>
            </Link>
          ))}
        </section>
      </main>
    </HomeLayout>
  )
}
