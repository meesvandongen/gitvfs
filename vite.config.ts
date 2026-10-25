import { defineConfig } from 'vite-plus'

export default defineConfig({
  // Mirrors the existing hand-written style; the repo is not formatter-managed.
  fmt: { singleQuote: true, semi: false, printWidth: 100 },
  lint: {
    ignorePatterns: ['**/dist/**'],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
})
