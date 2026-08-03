import { ipcMain } from 'electron'
import { isTsLike } from '../lib/tsLsp'
import { parseExtraServers } from '../lib/lspServers'
import { lspClose, lspDefinition, lspDiagnostics, lspHover, lspReferences, lspRename } from '../lsp/client'
import {
  serverFor, setExtraLspServers, stdioClose, stdioDefinition, stdioDiagnostics,
  stdioHover, stdioReferences, stdioRename,
} from '../lsp/stdio'
import { getCurrentRootPath } from './workspace'
import { getAppState } from '../../memory/queries'
import type { LspDefinition, LspDiagnostic, LspHover, LspReference, LspRenameResult } from '../lsp/protocol'

// IPC surface for language intelligence.
//
// Two engines sit behind one set of channels, and the split is deliberate:
//
//  - **TypeScript/JavaScript** goes to the in-process `ts.LanguageService`
//    worker. It's a dependency we already ship, it needs no installation, and a
//    worker thread beats a subprocess round trip.
//  - **Everything else** goes to a real external language server over stdio
//    (pyright, rust-analyzer, gopls, clangd) *if the user has one installed*.
//    Nothing is bundled or auto-installed, so an absent server is simply no
//    result — the same degradation as a repo with no TypeScript.
//
// The renderer sends the file's live buffer with every request rather than a
// path alone: the editor's unsaved text is the truth, and it keeps both engines
// stateless enough to survive a restart.

/** External servers need a workspace root to initialize against. */
function root(): string | null {
  return getCurrentRootPath()
}

export function registerLspHandlers(): void {
  // Optional user-defined servers, so a language we ship no default for can be
  // wired up without a release. Read once at startup; malformed JSON is ignored
  // rather than allowed to break the built-in servers.
  try {
    setExtraLspServers(parseExtraServers(getAppState('lspServers')))
  } catch {
    /* setting unreadable — built-in servers still work */
  }

  ipcMain.handle(
    'lsp:diagnostics',
    async (_e, path: string, content: string): Promise<LspDiagnostic[]> => {
      if (!path) return []
      if (isTsLike(path)) return lspDiagnostics(path, content)
      const r = root()
      return r && serverFor(path) ? stdioDiagnostics(r, path, content) : []
    },
  )

  ipcMain.handle(
    'lsp:hover',
    async (_e, path: string, content: string, offset: number): Promise<LspHover | null> => {
      if (!path) return null
      if (isTsLike(path)) return lspHover(path, content, offset)
      const r = root()
      return r && serverFor(path) ? stdioHover(r, path, content, offset) : null
    },
  )

  ipcMain.handle(
    'lsp:definition',
    async (_e, path: string, content: string, offset: number): Promise<LspDefinition | null> => {
      if (!path) return null
      if (isTsLike(path)) return lspDefinition(path, content, offset)
      const r = root()
      return r && serverFor(path) ? stdioDefinition(r, path, content, offset) : null
    },
  )

  ipcMain.handle(
    'lsp:references',
    async (_e, path: string, content: string, offset: number): Promise<LspReference[]> => {
      if (!path) return []
      if (isTsLike(path)) return lspReferences(path, content, offset)
      const r = root()
      return r && serverFor(path) ? stdioReferences(r, path, content, offset) : []
    },
  )

  ipcMain.handle(
    'lsp:rename',
    async (_e, path: string, content: string, offset: number, newName: string): Promise<LspRenameResult> => {
      if (!path) return { ok: false, error: 'no-path' }
      if (isTsLike(path)) return lspRename(path, content, offset, newName)
      const r = root()
      if (!r || !serverFor(path)) return { ok: false, error: 'no-language-server' }
      return stdioRename(r, path, content, offset, newName)
    },
  )

  // The editor closed a tab — drop its overlay so the file falls back to disk.
  ipcMain.handle('lsp:close', async (_e, path: string): Promise<void> => {
    if (!path) return
    if (isTsLike(path)) await lspClose(path)
    else stdioClose(path)
  })
}
