import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setupWorker } from 'msw/browser'
import { createGitHubHandlers, MockRepository, persistentRepository } from 'gitvfs-github-msw'
import 'gitvfs-cms/styles.css'
import './demo.css'
import { App } from './App'
import { seedFiles } from './content'

export const repo = { owner: 'acme', repo: 'site', branch: 'main' }

async function start() {
  // The visitor's own copy of the repository, kept in localStorage. Bump the key when the seed
  // changes in incompatible ways.
  const store = await persistentRepository({
    key: 'gitvfs-cms-demo:v1',
    seed: () => MockRepository.create({ files: seedFiles, message: 'Set up the demo site' }),
  })

  const listeners = new Set<() => void>()
  const worker = setupWorker(
    ...createGitHubHandlers({
      repository: store.repository,
      owner: repo.owner,
      repo: repo.repo,
      user: { login: 'demo-editor', name: 'Demo editor' },
      onChange: () => {
        store.save()
        listeners.forEach((listener) => listener())
      },
    }),
  )
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App
        repository={store.repository}
        subscribe={(listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }}
        reset={async () => {
          await store.reset()
          listeners.forEach((listener) => listener())
        }}
      />
    </StrictMode>,
  )
}

start().catch((error: unknown) => {
  document.getElementById('root')!.textContent = `The demo could not start: ${error instanceof Error ? error.message : String(error)}`
})
