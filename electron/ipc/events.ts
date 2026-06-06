import { ipcMain, type BrowserWindow } from 'electron'
import { eventList, eventEmit, onEventEmitted, type SwarmEventType } from '../../memory/events'

// Bridges the swarm event bus to the renderer:
//   • events:list   — pull the recent log (initial load / incremental refetch)
//   • events:emit   — let the renderer (the conductor) append events too
//   • swarm:event   — push channel: every newly emitted event is forwarded live
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

  // Forward every emitted event to the renderer. Registered once; the closure
  // re-reads the live window each time so it survives window recreation.
  onEventEmitted((event) => {
    const win = getWin()
    if (win && !win.isDestroyed()) win.webContents.send('swarm:event', event)
  })
}
