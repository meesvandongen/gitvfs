import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: 'gitvfs/providers/github',
        replacement: fileURLToPath(new URL('../gitvfs/src/providers/github.ts', import.meta.url)),
      },
      {
        find: 'gitvfs/providers/gitlab',
        replacement: fileURLToPath(new URL('../gitvfs/src/providers/gitlab.ts', import.meta.url)),
      },
      {
        find: 'gitvfs',
        replacement: fileURLToPath(new URL('../gitvfs/src/index.ts', import.meta.url)),
      },
    ],
  },
  // Keep a stable port so the sample URL stays predictable in docs.
  server: {
    port: 3000,
    strictPort: true,
  },
})
