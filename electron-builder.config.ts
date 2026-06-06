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
    '!**/*.map',
    // Native-addon debug symbols (node-pty ships ~54 MB of .pdb in its
    // per-platform prebuilds, better-sqlite3 a few more). Never loaded at
    // runtime — the loader resolves build/Release first.
    '!**/*.pdb',
    // C/C++ sources & build intermediates for the two native addons; only
    // needed by node-gyp at rebuild time, not once build/Release/*.node exists.
    // Scoped to these packages so we never strip a JS dep that runs from src/.
    '!**/node_modules/node-pty/{deps,third_party,src,scripts}/**',
    '!**/node_modules/better-sqlite3/{deps,src}/**',
    '!**/*.{o,obj,a,lib}'
  ],
  // Trade a little build time for a noticeably smaller installer/download.
  compression: 'maximum',
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
    shortcutName: 'SwarmMind',
    installerIcon: 'resources/icons/icon.ico',
    uninstallerIcon: 'resources/icons/icon.ico',
    installerHeaderIcon: 'resources/icons/icon.ico'
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
