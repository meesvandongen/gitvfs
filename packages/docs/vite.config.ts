import { fileURLToPath, URL } from 'node:url'
import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import { defineConfig } from 'vite-plus'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  plugins: [fumadocsMdx(), tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
    // Build the workspace packages from source, so the site needs no prior package builds.
    alias: [
      { find: /^gitvfs\/providers\/github$/, replacement: source('../gitvfs/src/providers/github.ts') },
      { find: /^gitvfs$/, replacement: source('../gitvfs/src/index.ts') },
      { find: /^gitvfs-cms\/react$/, replacement: source('../cms/src/react/index.ts') },
      { find: /^gitvfs-cms\/styles\.css$/, replacement: source('../cms/src/styles.css') },
      { find: /^gitvfs-cms$/, replacement: source('../cms/src/index.ts') },
      { find: /^gitvfs-github-auth$/, replacement: source('../github-auth/src/index.ts') },
    ],
  },
})
