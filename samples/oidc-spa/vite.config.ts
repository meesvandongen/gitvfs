import { defineConfig } from 'vite'

export default defineConfig({
  // Required for OIDC redirect: the silent-sso.html must be served at /silent-sso.html
  // and the app must be able to handle the redirect back from the OIDC provider.
  server: {
    port: 3000,
  },
})
