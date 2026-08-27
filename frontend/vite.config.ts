import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'unreal-file-protocol-html',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          const classicHtml = html
            .replace('type="module" crossorigin', 'defer')
            .replace('<link rel="stylesheet" crossorigin', '<link rel="stylesheet"')

          if (classicHtml === html) {
            throw new Error('Expected Vite to emit a module entry script for the Unreal file:// rewrite.')
          }
          return classicHtml
        },
      },
    },
  ],
  base: './',
  build: {
    target: 'chrome90',
    cssTarget: 'chrome90',
    outDir: '../Web/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'iife',
      },
    },
  },
})
