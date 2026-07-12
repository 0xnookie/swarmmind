import { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain, screen } from 'electron'
import { join } from 'path'
import { initAppDb, closeAll } from '../memory/db'
import { getAppState } from '../memory/queries'
import { startMcpServer, stopMcpServer } from '../mcp/server'
import { registerPtyHandlers } from './ipc/pty'
import { registerWorkspaceHandlers, getCurrentWorkspaceId, getCurrentRootPath } from './ipc/workspace'
import { registerMemoryHandlers } from './ipc/memory'
import { registerFsHandlers } from './ipc/filesystem'
import { registerVerifyHandlers } from './ipc/verify'
import { registerAppSettingsHandlers, loadPersistedSettings } from './ipc/appsettings'
import { registerSessionHandlers } from './ipc/sessions'
import { registerGitHandlers } from './ipc/git'
import { registerAgentSkillHandlers } from './ipc/agent-skills'
import { registerEventHandlers } from './ipc/events'
import { registerCheckpointHandlers } from './ipc/checkpoints'
import { registerVoiceCacheHandlers } from './ipc/voice-cache'
import { registerBenchmarkHandlers } from './ipc/benchmarks'
import { registerSwarmAgentHandlers } from './ipc/swarmagent'
import { registerLspHandlers } from './ipc/lsp'
import { shutdownLsp } from './lsp/client'
import { registerUpdater } from './updater'
import { killAll } from './pty-manager'
import { existsSync, mkdirSync } from 'fs'



// Disable GPU acceleration for more stable rendering on all hardware
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')

// SwarmVoice: onnxruntime-web can only run its multi-threaded WASM backend when
// SharedArrayBuffer exists, and SAB normally requires cross-origin isolation —
// which neither the dev server (plain http://localhost) nor the packaged
// renderer (file://) has. Force-enable it process-wide; safe because the
// renderer only ever loads our own bundled code (no remote content).
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

// ── App-level DB (workspaces registry, skills, app_state) ─────────────────────

function initApp(): void {
  const userDataPath = app.getPath('userData')
  if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true })
  initAppDb(join(userDataPath, 'app.db'))
}

// ── Window ────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let widgetWindow: BrowserWindow | null = null
let tray: Tray | null = null
// True once the user explicitly dismisses the widget, so we don't keep
// re-popping it every time the main window minimizes.
let widgetDismissed = false
// In-flight widget→main-window tool calls, keyed by a correlation id, resolved
// when the main window replies via the widget:toolResult channel.
const pendingWidgetTools = new Map<string, (result: string) => void>()
let widgetToolSeq = 0

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

  // Float the chat widget in whenever the main window steps aside, and tuck it
  // away again when the user comes back to the full app.
  win.on('minimize', onMainWindowAway)
  win.on('hide', onMainWindowAway)
  win.on('restore', hideWidget)
  win.on('show', hideWidget)
  win.on('focus', hideWidget)

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

// ── SwarmAgent desktop widget ─────────────────────────────────────────────────
// A small frameless, always-on-top floating window that hosts just the
// SwarmAgent chat. It loads the same renderer bundle with a `#widget` hash so
// the renderer mounts the compact widget instead of the full app. It auto-shows
// when the main window minimizes or hides to the tray, so the assistant stays a
// click away even when SwarmMind is out of the way. Drag it anywhere via its
// header (CSS -webkit-app-region: drag). Tool calls it makes are forwarded to
// the main window (which owns the real workspace state) — see widget:forwardTool.

function widgetUrl(): string {
  const base = process.env['ELECTRON_RENDERER_URL']
  return base ? `${base}#widget` : ''
}

// Transparent gutter (px) around the widget card so its drop shadow renders
// inside the window. Must match the `#root` padding in SwarmAgentWidget.css.
const WIDGET_SHADOW_PAD = 32

function createWidgetWindow(): BrowserWindow {
  // A slim floating bar near the bottom-right of the primary work area. It
  // starts collapsed (just the input bar) and grows upward when a conversation
  // is on screen — the renderer drives height via the widget:resize channel.
  const wa = screen.getPrimaryDisplay().workArea
  // The transparent window is larger than the visible card by WIDGET_SHADOW_PAD
  // on every side, so the card's CSS drop shadow has room to render inside the
  // window instead of being clipped at its edge. The renderer sends the visible
  // card height; widget:resize adds the padding back. The `#root` padding in
  // SwarmAgentWidget.css must equal WIDGET_SHADOW_PAD. GAP offsets from the
  // screen edge. CARD_H matches the renderer's collapsed height (COLLAPSED_H).
  const CARD_W = 420, CARD_H = 58, GAP = 10
  const W = CARD_W + WIDGET_SHADOW_PAD * 2, H = CARD_H + WIDGET_SHADOW_PAD * 2

  const win = new BrowserWindow({
    width: W,
    height: H,
    x: wa.x + wa.width - W - GAP,
    y: wa.y + wa.height - H - GAP,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    icon: resolveIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  // SwarmVoice needs the microphone in the widget window too.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(true))
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const url = widgetUrl()
  if (url) win.loadURL(url)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'widget' })

  win.on('closed', () => { widgetWindow = null })
  return win
}

function showWidget(): void {
  widgetDismissed = false
  if (!widgetWindow || widgetWindow.isDestroyed()) widgetWindow = createWidgetWindow()
  widgetWindow.show()
  widgetWindow.setAlwaysOnTop(true, 'floating')
}

function hideWidget(): void {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide()
}

// Auto-show the widget whenever the main window steps out of the way (minimize
// or hide-to-tray), unless the user has explicitly dismissed it this session.
function onMainWindowAway(): void {
  if (!widgetDismissed) showWidget()
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
    { label: 'Show Chat Widget', click: () => showWidget() },
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
  registerVerifyHandlers()
  registerAppSettingsHandlers()
  loadPersistedSettings()
  registerSessionHandlers()
  registerGitHandlers()
  registerAgentSkillHandlers()
  registerVoiceCacheHandlers()
  registerBenchmarkHandlers()
  registerSwarmAgentHandlers(() => mainWindow)
  registerLspHandlers()

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

  // ── Desktop widget control + tool forwarding ──
  ipcMain.on('widget:show', () => showWidget())
  ipcMain.on('widget:hide', () => { widgetDismissed = true; hideWidget() })
  ipcMain.on('widget:restoreMain', () => { hideWidget(); showMainWindow() })
  // The widget is a slim bar that grows upward when a conversation is showing.
  // Resize anchored to its bottom edge so it expands above the bar, not below.
  ipcMain.on('widget:resize', (_e, height: number) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    const b = widgetWindow.getBounds()
    // `height` is the visible card height; add the shadow gutter for both edges
    // so the window leaves room for the drop shadow. Anchored to the bottom edge.
    const h = Math.max(56, Math.round(height)) + WIDGET_SHADOW_PAD * 2
    widgetWindow.setBounds({ x: b.x, y: b.y + b.height - h, width: b.width, height: h }, false)
  })

  // The widget runs its own SwarmAgent loop but has no workspace state of its
  // own, so it forwards each tool call here; we relay it to the main window
  // (which owns the Zustand store + PTYs), await the result, and hand it back.
  ipcMain.handle('widget:forwardTool', (_e, name: string, args: string) => {
    if (!mainWindow || mainWindow.isDestroyed())
      return 'SwarmMind\'s main window is closed — open it from the tray to run that action.'
    const id = `wt-${widgetToolSeq++}`
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingWidgetTools.delete(id)) resolve('That action timed out.')
      }, 60_000)
      pendingWidgetTools.set(id, (result) => { clearTimeout(timer); resolve(result) })
      mainWindow!.webContents.send('widget:runTool', { id, name, args })
    })
  })
  ipcMain.on('widget:toolResult', (_e, id: string, result: string) => {
    const fn = pendingWidgetTools.get(id)
    if (fn) { pendingWidgetTools.delete(id); fn(result) }
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
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.destroy()
  widgetWindow = null
  tray?.destroy()
  tray = null
  killAll()
  shutdownLsp()
  await stopMcpServer()
  closeAll()
})
