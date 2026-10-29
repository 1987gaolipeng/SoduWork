import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During development, proxy /api to the local backend (127.0.0.1:9080) so frontend API calls can use relative paths.
// Use SODUWORK_DEV_HUB to target a different local Hub; the default development port is 9080.
const hubTarget = process.env.SODUWORK_DEV_HUB || 'http://127.0.0.1:9080'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: hubTarget, changeOrigin: true },
      // These Hub probes live outside /api; never serve the SPA fallback for them.
      '/healthz': { target: hubTarget, changeOrigin: true },
      '/readyz': { target: hubTarget, changeOrigin: true },
    },
  },
})
