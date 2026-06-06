import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve('electron/main.ts')
      },
      rollupOptions: {
        external: ['node-pty', 'better-sqlite3'],
        output: {
          entryFileNames: 'index.js'
        }
      }
    },
    resolve: {
      alias: {
        '@memory': resolve('memory'),
        '@mcp': resolve('mcp')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    root: '.',
    build: {
      rollupOptions: {
        input: {
          index: resolve('index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve('src')
      }
    },
    define: {
      // @xenova/transformers reads process.env.NODE_ENV at module scope.
      // nodeIntegration:false means process is undefined in the renderer, so
      // we must inject the value at build/pre-bundle time.
      'process.env.NODE_ENV': JSON.stringify('production')
    }
  }
})
