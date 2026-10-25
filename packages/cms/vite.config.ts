import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, lazyPlugins } from 'vite-plus'

export default defineConfig({
  // `vp dev` serves the in-memory playground in ./playground.
  root: 'playground',
  plugins: lazyPlugins(() => [react()]),
  resolve: {
    alias: [
      {
        find: /^gitvfs$/,
        replacement: fileURLToPath(new URL('../gitvfs/src/index.ts', import.meta.url)),
      },
    ],
  },
  server: {
    port: 3001,
    strictPort: true,
  },
  pack: {
    entry: {
      index: 'src/index.ts',
      'react/index': 'src/react/index.ts',
      'oidc/index': 'src/oidc/index.ts',
    },
    format: ['esm'],
    fixedExtension: false,
    sourcemap: false,
    // Resolve gitvfs through node_modules (its built types) so declarations import it
    // instead of inlining the workspace sources that tsconfig paths point at.
    dts: { sourcemap: false, tsconfig: 'tsconfig.build.json' },
    copy: [{ from: 'src/styles.css', to: 'dist' }],
    clean: true,
    target: 'esnext',
  },
  test: {
    root: '.',
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
