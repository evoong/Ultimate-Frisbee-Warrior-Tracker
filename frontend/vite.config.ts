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
