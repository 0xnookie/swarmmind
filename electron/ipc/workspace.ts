import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { join, basename } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { initWorkspaceDb } from '../../memory/db'
import { upsertWorkspace, loadLayout, listWorkspaces, deleteWorkspace, renameWorkspace, getAppState, setAppState } from '../../memory/queries'
import { eventPrune } from '../../memory/events'
import { setActiveWorkspace } from '../../mcp/server'
import { killAll } from '../pty-manager'

interface WorkspaceInfo {
  id: string
  name: string
  rootPath: string
  savedLayout: string | null
}

let activeWorkspaceId: string | null = null
let activeRootPath: string | null = null

export function getCurrentWorkspaceId(): string | null {
  return activeWorkspaceId
}

export function getCurrentRootPath(): string | null {
  return activeRootPath
}

function openWorkspaceDir(rootPath: string, name?: string): WorkspaceInfo {
  killAll()
  const smDir = join(rootPath, '.swarmmind')
  if (!existsSync(smDir)) mkdirSync(smDir, { recursive: true })

  const dbPath = join(smDir, 'memory.db')
  initWorkspaceDb(dbPath)

  const ws = upsertWorkspace(rootPath, name)
  activeWorkspaceId = ws.id
  activeRootPath = rootPath
  setActiveWorkspace(ws.id)
  setAppState('lastWorkspacePath', rootPath)
  // Cap the event log so a long-lived workspace's timeline can't grow unbounded.
  eventPrune(ws.id)

  return { id: ws.id, name: ws.name, rootPath, savedLayout: loadLayout(ws.id) }
}

export function registerWorkspaceHandlers(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('workspace:open', async () => {
    const win = getWin()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open Workspace',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    try {
      return openWorkspaceDir(result.filePaths[0])
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('workspace:get', () => {
    if (!activeWorkspaceId || !activeRootPath) return null
    return { id: activeWorkspaceId, name: basename(activeRootPath), rootPath: activeRootPath, savedLayout: loadLayout(activeWorkspaceId) }
  })

  ipcMain.handle('workspace:list', () => {
    return listWorkspaces()
  })

  ipcMain.handle('workspace:openById', (_event, id: string) => {
    const ws = listWorkspaces().find(w => w.id === id)
    if (!ws) return { error: 'Not found' }
    if (!existsSync(ws.root_path)) return { error: 'Directory no longer exists' }
    try {
      return openWorkspaceDir(ws.root_path)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('workspace:openByPath', (_event, rootPath: string, name?: string) => {
    if (!existsSync(rootPath)) return { error: 'Directory does not exist' }
    try {
      return openWorkspaceDir(rootPath, name)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('workspace:rename', (_event, id: string, name: string) => {
    return renameWorkspace(id, name)
  })

  ipcMain.handle('workspace:delete', (_event, id: string) => {
    if (activeWorkspaceId === id) {
      killAll()
      activeWorkspaceId = null
      activeRootPath = null
      setActiveWorkspace('')
    }
    return deleteWorkspace(id)
  })

  // Pick a folder (for per-pane CWD override)
  ipcMain.handle('folder:pick', async () => {
    const win = getWin()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Select Working Directory',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Auto-open last workspace on startup
  ipcMain.handle('workspace:openLast', () => {
    const lastPath = getAppState('lastWorkspacePath')
    if (!lastPath || !existsSync(lastPath)) return null
    try {
      return openWorkspaceDir(lastPath)
    } catch {
      return null
    }
  })
}
