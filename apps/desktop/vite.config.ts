import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) {
            return 'react-vendor'
          }
          if (id.includes('/node_modules/lexical/') || id.includes('/node_modules/@lexical/')) {
            return 'editor-vendor'
          }
          if (/\/node_modules\/(react-markdown|remark-|rehype-|unified|vfile|mdast-|micromark|hast-|unist-)/.test(id)) {
            return 'markdown-vendor'
          }
          if (/\/node_modules\/(@radix-ui|@tabler|radix-ui|sonner|tailwind-merge)\//.test(id)) {
            return 'ui-vendor'
          }
        },
      },
    },
  },
  server: {
    port: 5173,
  },
})
