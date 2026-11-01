import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { msw } from 'msw/vite'
import { defineConfig, lazyPlugins } from 'vite-plus'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  // worker-only: serve mockServiceWorker.js in dev and emit it in the build; the app starts it itself.
  plugins: lazyPlugins(() => [react(), msw({ mode: 'worker-only' })]),
  resolve: {
    // Build the workspace packages from source, so the demo needs no prior package builds.
    alias: [
      { find: /^gitvfs\/providers\/github$/, replacement: source('../gitvfs/src/providers/github.ts') },
      { find: /^gitvfs$/, replacement: source('../gitvfs/src/index.ts') },
      { find: /^gitvfs-cms\/react$/, replacement: source('../cms/src/react/index.ts') },
      { find: /^gitvfs-cms\/styles\.css$/, replacement: source('../cms/src/styles.css') },
      { find: /^gitvfs-cms$/, replacement: source('../cms/src/index.ts') },
      { find: /^gitvfs-github-msw$/, replacement: source('../github-msw/src/index.ts') },
    ],
  },
  // zod, AutoForm, MSW, marked and yaml in one chunk; fine for a demo that loads once.
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    port: 3002,
    strictPort: true,
  },
})
