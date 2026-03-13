import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'providers/github': 'src/providers/github.ts',
    'providers/gitlab': 'src/providers/gitlab.ts',
    'cache/indexeddb': 'src/cache/indexeddb.ts',
    'discovery/github': 'src/discovery/github.ts',
    'discovery/gitlab': 'src/discovery/gitlab.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  clean: true,
  target: 'es2022',
})
