import { ipcMain, BrowserWindow } from 'electron'
import { ptyCreate, ptyCreateShell, ptyInput, ptyResize, ptyKill, ptyStatus, agentCountsByWorkspace, type ShellStyle } from '../pty-manager'
import { type AgentId } from '../../memory/queries'

export function registerPtyHandlers(getWin: () => BrowserWindow | null, getWorkspaceId: () => string | null): void {
  ipcMain.handle('pty:create', (_event, paneId: string, agentId: AgentId, cwd: string, shellStyle: ShellStyle, taskContext?: string, cols?: number, rows?: number, resume?: boolean, sessionId?: string) => {
    const win = getWin()
    const workspaceId = getWorkspaceId()
    if (!win || !workspaceId) return { error: 'No window or workspace' }
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
