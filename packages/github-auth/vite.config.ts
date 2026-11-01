import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    entry: {
      index: 'src/index.ts',
      server: 'src/server.ts',
    },
    format: ['esm'],
    fixedExtension: false,
    sourcemap: false,
    dts: { sourcemap: false },
    clean: true,
    target: 'esnext',
  },
  test: {
    globals: true,
    environment: 'happy-dom',
  },
})
