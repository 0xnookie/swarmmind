import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Two entries: the main process, and the TypeScript language service that
        // runs in a worker_thread (electron/lsp/worker.ts). The client resolves it
        // as `__dirname/lsp-worker.js`, i.e. a sibling of the main bundle — so the
        // names below are load-bearing, not cosmetic.
        input: {
          index: resolve('electron/main.ts'),
          'lsp-worker': resolve('electron/lsp/worker.ts')
        },
        external: ['node-pty', 'better-sqlite3'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
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
