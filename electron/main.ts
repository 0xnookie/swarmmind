import { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain } from 'electron'
import { join } from 'path'
import { initAppDb, closeAll } from '../memory/db'
import { getAppState } from '../memory/queries'
import { startMcpServer, stopMcpServer } from '../mcp/server'
import { registerPtyHandlers } from './ipc/pty'
import { registerWorkspaceHandlers, getCurrentWorkspaceId, getCurrentRootPath } from './ipc/workspace'
import { registerMemoryHandlers } from './ipc/memory'
import { registerFsHandlers } from './ipc/filesystem'
import { registerAppSettingsHandlers, loadPersistedSettings } from './ipc/appsettings'
import { registerSessionHandlers } from './ipc/sessions'
import { registerGitHandlers } from './ipc/git'
import { registerAgentSkillHandlers } from './ipc/agent-skills'
import { registerEventHandlers } from './ipc/events'
import { registerCheckpointHandlers } from './ipc/checkpoints'
import { registerUpdater } from './updater'
import { killAll } from './pty-manager'
import { existsSync, mkdirSync } from 'fs'



// Disable GPU acceleration for more stable rendering on all hardware
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')

// ── App-level DB (workspaces registry, skills, app_state) ─────────────────────

function initApp(): void {
  const userDataPath = app.getPath('userData')
  if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true })
  initAppDb(join(userDataPath, 'app.db'))
}

// ── Window ────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

// Resolve the runtime window icon (taskbar / Alt-Tab). Packaged: shipped via
// extraResources at process.resourcesPath. Dev: the source under resources/
// (main runs from out/main, so two levels up). On Windows the installed app's
// icon comes from the .exe (win.icon), so this mainly helps dev + Linux.
function resolveIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../resources/icon.png')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden',
    backgroundColor: '#1a1816',
    icon: resolveIconPath(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    if (process.env.NODE_ENV === 'development') win.webContents.openDevTools()
  })

  // Allow microphone access for SwarmVoice speech recognition
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(true)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// ── System tray ─────────────────────────────────────────────────────────────────
// Lets the window "close to tray": the custom title bar's close (X) button
// (window:close IPC) hides the window to the tray instead of quitting when the
// `closeToTray` setting is on (default); the minimize button minimizes to the
// taskbar as usual. The tray icon restores the window, and the tray menu's Quit
// is how you actually exit. Mainly a Windows affordance, but Tray works on all
// platforms.

// Bring the window back from the tray (or recreate it if it was closed).
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  // The shipped PNG is large (≈1024px); resize so the tray icon is crisp.
  const icon = nativeImage.createFromPath(resolveIconPath()).resize({ width: 16, height: 16 })
  tray = new Tray(icon.isEmpty() ? resolveIconPath() : icon)
  tray.setToolTip('SwarmMind')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show SwarmMind', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]))
  // Single click is the expected restore gesture on Windows; double-click too.
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

// Whether the close (X) button should hide to tray instead of quitting. Read
// live so the Settings toggle takes effect without a restart; defaults on when
// unset.
function closeToTrayEnabled(): boolean {
  return (getAppState('closeToTray') ?? '1') !== '0'
}

// ── Application menu ──────────────────────────────────────────────────────────

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Workspace…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:openWorkspace')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Tie the running process to its installed shortcut so Windows resolves the
  // taskbar / Alt-Tab icon and toast notifications from the .exe icon instead
  // of falling back to the default Electron icon. Must match `appId` in
  // electron-builder.yml. No-op on other platforms.
  if (process.platform === 'win32') app.setAppUserModelId('dev.swarmmind.app')

  initApp()
  await startMcpServer().catch(err => console.error('[MCP] Failed to start:', err))

  registerPtyHandlers(() => mainWindow, () => getCurrentWorkspaceId())
  registerWorkspaceHandlers(() => mainWindow)
  registerMemoryHandlers(() => getCurrentWorkspaceId())
  registerEventHandlers(() => mainWindow, () => getCurrentWorkspaceId())
  registerCheckpointHandlers(() => getCurrentWorkspaceId(), () => getCurrentRootPath())
  registerFsHandlers()
  registerAppSettingsHandlers()
  loadPersistedSettings()
  registerSessionHandlers()
  registerGitHandlers()
  registerAgentSkillHandlers()

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on('window:close', () => {
    if (closeToTrayEnabled() && tray) mainWindow?.hide()
    else mainWindow?.close()
  })

  buildMenu()
  mainWindow = createWindow()
  createTray()

  // Auto-update (packaged builds only; inert in dev). Registered after the
  // window exists so status events have somewhere to go.
  registerUpdater(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', async () => {
  killAll()
  await stopMcpServer()
  closeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  tray?.destroy()
  tray = null
  killAll()
  await stopMcpServer()
  closeAll()
})
