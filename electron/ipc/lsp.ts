import { ipcMain } from 'electron'
import { isTsLike } from '../lib/tsLsp'
import { lspClose, lspDefinition, lspDiagnostics, lspHover } from '../lsp/client'
import type { LspDefinition, LspDiagnostic, LspHover } from '../lsp/protocol'

// IPC surface for the TypeScript language service (electron/lsp/*).
//
// The renderer sends the file's live buffer with every request rather than a
// path alone: the editor's unsaved text is the truth, and it keeps the worker
// stateless enough to survive a restart.

export function registerLspHandlers(): void {
  ipcMain.handle(
    'lsp:diagnostics',
    async (_e, path: string, content: string): Promise<LspDiagnostic[]> => {
      if (!path || !isTsLike(path)) return []
      return lspDiagnostics(path, content)
    },
  )

  ipcMain.handle(
    'lsp:hover',
    async (_e, path: string, content: string, offset: number): Promise<LspHover | null> => {
      if (!path || !isTsLike(path)) return null
      return lspHover(path, content, offset)
    },
  )

  ipcMain.handle(
    'lsp:definition',
    async (_e, path: string, content: string, offset: number): Promise<LspDefinition | null> => {
      if (!path || !isTsLike(path)) return null
      return lspDefinition(path, content, offset)
    },
  )

  // The editor closed a tab — drop its overlay so the file falls back to disk.
  ipcMain.handle('lsp:close', async (_e, path: string): Promise<void> => {
    if (path && isTsLike(path)) await lspClose(path)
  })
}
