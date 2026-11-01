import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setupWorker } from 'msw/browser'
import { createGitHubHandlers, MockRepository, persistentRepository } from 'gitvfs-github-msw'
import 'gitvfs-cms/styles.css'
import './demo.css'
import { App, type DemoRepository } from './App'
import { labsSeedFiles, seedFiles } from './content'

async function start() {
  // The visitor's own copies of the repositories, kept in localStorage. Bump a key when its seed
  // changes in incompatible ways.
  const site = await persistentRepository({
    key: 'gitvfs-cms-demo:v1',
    seed: () => MockRepository.create({ files: seedFiles, message: 'Set up the demo site' }),
  })
  const labs = await persistentRepository({
    key: 'gitvfs-cms-demo:labs:v1',
    seed: () => MockRepository.create({ files: labsSeedFiles, message: 'Set up Acme Labs' }),
  })
  const stores = [site, labs]
  const repositories: DemoRepository[] = [
    { fullName: 'acme/site', repository: site.repository },
    { fullName: 'acme/labs', repository: labs.repository },
  ]

  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const worker = setupWorker(
    ...createGitHubHandlers({
      repositories: [
        { owner: 'acme', repo: 'site', repository: site.repository, details: { description: 'The Acme website: every field type and format' } },
        { owner: 'acme', repo: 'labs', repository: labs.repository, details: { description: 'A second site with the same content model', private: true } },
      ],
      user: { login: 'demo-editor', name: 'Demo editor' },
      onChange: (changed) => {
        stores.find((store) => store.repository === changed)?.save()
        notify()
      },
    }),
  )
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App
        repositories={repositories}
        subscribe={(listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }}
        reset={async () => {
          await Promise.all(stores.map((store) => store.reset()))
          notify()
        }}
      />
    </StrictMode>,
  )
}

start().catch((error: unknown) => {
  document.getElementById('root')!.textContent = `The demo could not start: ${error instanceof Error ? error.message : String(error)}`
})
