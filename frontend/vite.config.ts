import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the vendor bundle by package group so no single chunk
        // trips Vite's 500kB-after-minification warning; each group is
        // large but stable, so it also caches independently across
        // deploys that only touch app code.
        codeSplitting: {
          groups: [
            { name: 'vendor-radix', test: /node_modules\/@radix-ui/ },
            { name: 'vendor-supabase', test: /node_modules\/@supabase/ },
            { name: 'vendor-router', test: /node_modules\/react-router/ },
            { name: 'vendor-react', test: /node_modules\/(react|react-dom|scheduler)\// },
            { name: 'vendor', test: /node_modules/ },
          ],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: process.env.PORT ? Number(process.env.PORT) : 5000,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // changeOrigin stays false: the gateway compares the Origin header
      // against the request Host for CSRF, so it must see localhost:5000.
      '/auth': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
      '/db': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
})
