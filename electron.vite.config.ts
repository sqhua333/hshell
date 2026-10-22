import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // Inlined at build time; shown in the About dialog. Dev runs report the
    // moment `electron-vite dev` started.
    define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
    plugins: [react()]
  }
})
