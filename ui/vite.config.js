import { defineConfig } from 'vite'

// base: './' makes all asset/index paths relative, so the built dist/ works from
// any location — including `cd dist && python3 -m http.server 8000`.
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 4096 },
})
