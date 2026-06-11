import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { ptyCreate, ptyCreateShell, ptyCreateLogin, ptyInput, ptyResize, ptyKill, ptyStatus, agentCountsByWorkspace, type ShellStyle } from '../pty-manager'
import { type AgentId, getWorkspaceById } from '../../memory/queries'
import { ensureWorkspaceConnection } from '../../memory/db'

export function registerPtyHandlers(getWin: () => BrowserWindow | null, getWorkspaceId: () => string | null): void {
  ipcMain.handle('pty:create', (_event, paneId: string, agentId: AgentId, cwd: string, shellStyle: ShellStyle, taskContext?: string, cols?: number, rows?: number, resume?: boolean, sessionId?: string, paneWorkspaceId?: string) => {
    const win = getWin()
    const activeWorkspaceId = getWorkspaceId()
    if (!win) return { error: 'No window' }

    // A "mixed workspace" pane carries an explicit owning workspace id that may
    // differ from the foreground one. Bring its DB connection online (without
    // changing the foreground) so the agent's MCP writes route to its own
    // workspace. Fall back to the active workspace for ordinary panes.
    let workspaceId = activeWorkspaceId
    if (paneWorkspaceId && paneWorkspaceId !== activeWorkspaceId) {
      const ws = getWorkspaceById(paneWorkspaceId)
      if (!ws) return { error: `Workspace ${paneWorkspaceId} not found` }
      try {
        ensureWorkspaceConnection(join(ws.root_path, '.swarmmind', 'memory.db'), ws.id)
      } catch (err) {
        return { error: `Could not open workspace ${ws.name}: ${String(err)}` }
      }
      workspaceId = ws.id
    }
    if (!workspaceId) return { error: 'No workspace' }

    try {
      ptyCreate(paneId, agentId, workspaceId, cwd, win, shellStyle, taskContext, cols, rows, resume, sessionId)
      return { ok: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('pty:createShell', (_event, paneId: string, cwd: string, shellStyle: ShellStyle, cols?: number, rows?: number) => {
    const win = getWin()
    if (!win) return { error: 'No window' }
    try {
      ptyCreateShell(paneId, cwd, win, shellStyle, cols, rows)
      return { ok: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // The "connect account" login terminal embedded in Settings — runs the agent
  // CLI's own login flow against an isolated profile dir. No workspace needed.
  ipcMain.handle('pty:createLogin', (_event, paneId: string, agentId: AgentId, profileDir: string, shellStyle: ShellStyle, cols?: number, rows?: number) => {
    const win = getWin()
    if (!win) return { error: 'No window' }
    try {
      ptyCreateLogin(paneId, agentId, profileDir, win, shellStyle, cols, rows)
      return { ok: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.on('pty:input', (_event, paneId: string, data: string) => {
    ptyInput(paneId, data)
  })

  ipcMain.on('pty:resize', (_event, paneId: string, cols: number, rows: number) => {
    ptyResize(paneId, cols, rows)
  })

  ipcMain.handle('pty:kill', (_event, paneId: string, silent?: boolean) => {
    ptyKill(paneId, silent === true)
    return { ok: true }
  })

  ipcMain.handle('pty:status', (_event, paneId: string) => {
    return ptyStatus(paneId)
  })

  // Running agent counts keyed by workspace id — for the sidebar's per-workspace
  // badge (agents persist across workspace switches).
  ipcMain.handle('pty:agentCounts', () => {
    return agentCountsByWorkspace()
  })
}
