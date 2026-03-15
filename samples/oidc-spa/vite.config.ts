import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Keep a stable port so the sample URL stays predictable in docs.
  server: {
    port: 3000,
    strictPort: true,
  },
})
