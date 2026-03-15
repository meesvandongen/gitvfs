import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { AppFrame } from './components/AppFrame'
import { fetchAvailableRepositories } from './lib/git-data'
import { getActiveProviderConfig, getActiveProviderToken } from './lib/provider-config'
import { fetchUserProfile } from './lib/user-profile'
import { EditorPage } from './pages/EditorPage'
import { HomePage } from './pages/HomePage'
import { RepositoriesPage } from './pages/RepositoriesPage'

const editorSearchSchema = z.union([
  z.object({
    kind: z.literal('github'),
    owner: z.string().min(1),
    repo: z.string().min(1),
    branch: z.string().min(1),
  }),
  z.object({
    kind: z.literal('gitlab'),
    projectId: z.string().min(1),
    name: z.string().min(1),
    branch: z.string().min(1),
    apiUrl: z.string().optional(),
  }),
])

function requireProviderAndToken() {
  const providerConfig = getActiveProviderConfig()
  const token = getActiveProviderToken()

  if (token === null) {
    throw redirect({ to: '/' })
  }

  return { providerConfig, token }
}

const rootRoute = createRootRoute({
  component: () => <AppFrame />,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
})

const repositoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/repositories',
  beforeLoad: () => {
    return requireProviderAndToken()
  },
  loader: async ({ context }: { context: { providerConfig: ReturnType<typeof getActiveProviderConfig>; token: string } }) => {
    const { providerConfig, token } = context

    // Kick off profile fetch (caches for later use in components).
    void fetchUserProfile(providerConfig.provider, token, providerConfig.apiUrl)

    const repositories = await fetchAvailableRepositories({
      provider: providerConfig.provider,
      token,
      apiUrl: providerConfig.apiUrl,
    })

    return {
      providerName: providerConfig.provider === 'github' ? 'GitHub' : 'GitLab',
      repositories,
    }
  },
  component: RepositoriesPage,
  pendingComponent: () => (
    <section className="stack-page">
      <div className="loading-inline">
        <div className="spinner spinner-sm"></div>
        Loading repositories…
      </div>
    </section>
  ),
})

const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/editor',
  validateSearch: (search: Record<string, unknown>) => editorSearchSchema.parse(search),
  beforeLoad: ({ search }) => {
    const session = requireProviderAndToken()

    if (search.kind !== session.providerConfig.provider) {
      throw redirect({ to: '/repositories' })
    }

    return session
  },
  component: EditorPage,
})

const routeTree = rootRoute.addChildren([indexRoute, repositoriesRoute, editorRoute])

export const router = createRouter({
  routeTree,
  scrollRestoration: true,
  defaultPreloadStaleTime: 0,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
