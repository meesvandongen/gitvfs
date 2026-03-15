import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: 'git-fs/providers/github',
        replacement: fileURLToPath(new URL('../git-fs/src/providers/github.ts', import.meta.url)),
      },
      {
        find: 'git-fs/providers/gitlab',
        replacement: fileURLToPath(new URL('../git-fs/src/providers/gitlab.ts', import.meta.url)),
      },
      {
        find: 'git-fs',
        replacement: fileURLToPath(new URL('../git-fs/src/index.ts', import.meta.url)),
      },
    ],
  },
  // Keep a stable port so the sample URL stays predictable in docs.
  server: {
    port: 3000,
    strictPort: true,
  },
})
