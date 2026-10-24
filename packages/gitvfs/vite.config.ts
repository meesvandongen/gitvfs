import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    entry: {
      index: 'src/index.ts',
      'providers/github': 'src/providers/github.ts',
      'providers/gitlab': 'src/providers/gitlab.ts',
      'cache/indexeddb': 'src/cache/indexeddb.ts',
    },
    format: ['esm'],
    // Keep the .js / .d.ts names that package.json exports point at.
    fixedExtension: false,
    // tsconfig enables source and declaration maps for editors; the published build ships without them.
    sourcemap: false,
    dts: { sourcemap: false },
    clean: true,
    target: 'esnext',
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    clearMocks: false,
  },
})
