import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite-plus'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      // Tests run the real gitvfs GitHub provider against the mock.
      { find: /^gitvfs\/providers\/github$/, replacement: source('../gitvfs/src/providers/github.ts') },
      { find: /^gitvfs$/, replacement: source('../gitvfs/src/index.ts') },
    ],
  },
  pack: {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    fixedExtension: false,
    sourcemap: false,
    dts: { sourcemap: false },
    clean: true,
    target: 'esnext',
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
