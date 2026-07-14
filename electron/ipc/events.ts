import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { writeFile } from 'fs/promises'
import { eventList, eventEmit, onEventEmitted, type SwarmEventType } from '../../memory/events'

// Bridges the swarm event bus to the renderer:
//   • events:list          — pull the recent log (initial load / incremental refetch)
//   • events:emit          — let the renderer (the conductor) append events too
//   • swarm:event          — push channel: every newly emitted event is forwarded live
//   • export:saveSession   — save-dialog + write for the timeline's session export
export function registerEventHandlers(
  getWin: () => BrowserWindow | null,
  getWorkspaceId: () => string | null
): void {
  ipcMain.handle('events:list', (_e, sinceTs?: number, limit?: number, types?: string[]) => {
    const wsId = getWorkspaceId()
    if (!wsId) return []
    return eventList(wsId, { sinceTs, limit, types: types as SwarmEventType[] | undefined })
  })

  ipcMain.handle('events:emit', (_e, type: string, payload?: Record<string, unknown>, paneId?: string, agentId?: string) => {
    const wsId = getWorkspaceId()
    if (!wsId) return null
    return eventEmit(wsId, type as SwarmEventType, { payload: payload ?? null, paneId, agentId })
  })

  // Session export: the renderer builds both artifacts (pure src/lib/sessionExport)
  // and the chosen file extension picks which one is written. User-mediated path
  // via the save dialog, so no path validation is needed beyond what the OS does.
  ipcMain.handle('export:saveSession', async (_e, defaultBase: string, html: string, markdown: string) => {
    const win = getWin()
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window' }
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Swarm Session',
      defaultPath: `${defaultBase}.html`,
      filters: [
        { name: 'HTML report', extensions: ['html'] },
        { name: 'Markdown', extensions: ['md'] },
      ],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      const content = result.filePath.toLowerCase().endsWith('.md') ? markdown : html
      await writeFile(result.filePath, content, 'utf8')
      shell.showItemInFolder(result.filePath)
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Forward every emitted event to the renderer. Registered once; the closure
  // re-reads the live window each time so it survives window recreation.
  onEventEmitted((event) => {
    const win = getWin()
    if (win && !win.isDestroyed()) win.webContents.send('swarm:event', event)
  })
}
