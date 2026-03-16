import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'providers/github': 'src/providers/github.ts',
    'providers/gitlab': 'src/providers/gitlab.ts',
    'cache/indexeddb': 'src/cache/indexeddb.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: true,
  target: 'esnext',
  
})
