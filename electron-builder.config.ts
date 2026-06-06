import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'dev.swarmmind.app',
  productName: 'SwarmMind',
  copyright: 'Copyright © 2025 SwarmMind',
  directories: {
    output: 'dist',
    buildResources: 'resources'
  },
  files: [
    'out/**/*',
    'memory/**/*',
    'mcp/**/*',
    '!**/*.map'
  ],
  extraResources: [
    { from: 'memory/schema.sql', to: 'memory/schema.sql' },
    // Shipped so the main process can set the BrowserWindow icon at runtime
    // (taskbar / Alt-Tab) on Linux and as a cross-platform fallback.
    { from: 'resources/icon.png', to: 'icon.png' }
  ],
  asar: true,
  asarUnpack: [
    '**/node_modules/node-pty/**',
    '**/node_modules/better-sqlite3/**',
    'out/renderer/ort/**'
  ],
  win: {
    icon: 'resources/icons/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] }
    ]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: 'SwarmMind'
  },
  mac: {
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    category: 'public.app-category.developer-tools'
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Development'
  }
}

export default config
