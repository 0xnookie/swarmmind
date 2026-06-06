import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

// Status pushed to the renderer over the `update:status` channel. Kept
// structurally in sync with the UpdateStatus type in
// src/types/swarmmind.d.ts (the two tsconfig projects can't share it directly).
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'none' }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

const SIX_HOURS = 6 * 60 * 60 * 1000

// Wire electron-updater to the renderer: auto-download in the background,
// install on quit, and emit status so the UI can offer a "restart to update"
// banner. No-ops in dev / unpacked builds (there is no app-update.yml feed and
// checkForUpdates would throw); the IPC handlers still answer so the renderer
// can tell updates aren't supported.
export function registerUpdater(getWin: () => BrowserWindow | null): void {
  const supported = app.isPackaged

  const send = (status: UpdateStatus) => {
    const win = getWin()
    if (win && !win.isDestroyed()) win.webContents.send('update:status', status)
  }

  const check = () => {
    autoUpdater.checkForUpdates().catch((err: unknown) =>
      send({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    )
  }

  ipcMain.handle('update:check', () => {
    if (supported) check()
    return { supported }
  })
  ipcMain.handle('update:install', () => {
    if (supported) autoUpdater.quitAndInstall()
  })

  if (!supported) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => send({ state: 'none' }))
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => send({ state: 'error', message: err?.message ?? String(err) }))

  // Check once shortly after launch (let the window settle), then periodically
  // for long-running sessions.
  setTimeout(check, 8000)
  setInterval(check, SIX_HOURS)
}
