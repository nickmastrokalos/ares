import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: true })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  clearScreen: false,
  build: {
    // The Map view is a single screen that pulls in every map composable
    // and every map-side panel (~2 MB), and the maplibre-gl vendor chunk is
    // another ~1 MB. 2200 KB covers today's reality plus a small growth
    // budget, so the warning only fires when something genuinely surprising
    // slips in (e.g., a heavy new dep). If MapView crosses this, that's a
    // signal to split its panels into async components.
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      output: {
        // Carve maplibre-gl into its own cacheable chunk so it doesn't
        // balloon the MapView bundle — it rarely changes, the app code
        // around it churns.
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'vendor-maplibre'
        }
      }
    }
  },
  server: {
    host: host || false,
    port: 1420,
    strictPort: true,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  }
})
