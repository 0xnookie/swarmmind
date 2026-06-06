import { ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs'
import { getCurrentRootPath } from './workspace'

export interface SessionInfo {
  id: string
  mtime: number
  size: number
  preview: string
}

function claudeProjectsDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return join(home, '.claude', 'projects')
}

// Claude encodes a project directory by replacing path separators / colons with
// dashes, e.g. `D:\cookado` → `D--cookado`.
function encodeCwd(rootPath: string): string {
  return rootPath.replace(/[\\/:]/g, '-')
}

// Pull a short human-readable preview from a session's first meaningful line.
function previewOf(file: string): string {
  try {
    const content = readFileSync(file, 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try { obj = JSON.parse(line) } catch { continue }
      if (typeof obj.summary === 'string' && obj.summary.trim()) return obj.summary.trim().slice(0, 140)
      const msg = obj.message as { role?: string; content?: unknown } | undefined
      if (msg?.role === 'user') {
        const c = msg.content
        if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 140)
        if (Array.isArray(c)) {
          const t = c.find((p): p is { text: string } => typeof (p as { text?: unknown })?.text === 'string')
          if (t) return t.text.trim().slice(0, 140)
        }
      }
    }
  } catch { /* ignore */ }
  return ''
}

function scrollbackDir(): string | null {
  const root = getCurrentRootPath()
  if (!root) return null
  return join(root, '.swarmmind', 'scrollback')
}

export function registerSessionHandlers(): void {
  // List Claude Code sessions recorded for a working directory, newest first.
  ipcMain.handle('session:list', (_e, rootPath: string): SessionInfo[] => {
    try {
      const dir = join(claudeProjectsDir(), encodeCwd(rootPath))
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const full = join(dir, f)
          const st = statSync(full)
          return { id: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, size: st.size, preview: previewOf(full) }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 40)
    } catch {
      return []
    }
  })

  // Per-pane terminal scrollback, persisted under the workspace's .swarmmind dir
  // so reopening shows prior output. Best-effort; failures are swallowed.
  ipcMain.handle('scrollback:load', (_e, paneId: string): string => {
    try {
      const dir = scrollbackDir()
      if (!dir) return ''
      const file = join(dir, `${paneId}.log`)
      if (!existsSync(file)) return ''
      return readFileSync(file, 'utf-8')
    } catch {
      return ''
    }
  })

  ipcMain.handle('scrollback:save', (_e, paneId: string, content: string): void => {
    try {
      const dir = scrollbackDir()
      if (!dir) return
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${paneId}.log`), content, 'utf-8')
    } catch { /* ignore */ }
  })
}
