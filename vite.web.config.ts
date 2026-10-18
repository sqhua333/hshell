import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Browser-only preview of the renderer. Falls back to a mock SSH backend
// when window.hshell is not present (see src/renderer/src/api.ts).
//
// HSHELL_HOST lets the dev server listen on another interface so a Windows
// host (VM / WSL / LAN) can reach it. Default stays loopback-only.
const host = process.env.HSHELL_HOST || '127.0.0.1'
const port = Number(process.env.HSHELL_PORT || 5174)

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  server: { port, strictPort: true, host },
  preview: { port, strictPort: true, host },
  build: { outDir: resolve('dist-web'), emptyOutDir: true }
})
