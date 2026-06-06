// Boot smoke test: launches the built Electron app and asserts the main
// process comes up (native modules load, MCP server + DB init) and the renderer
// mounts. This catches the whole class of failures `tsc` can't see — an ABI
// mismatch in node-pty/better-sqlite3, a crash on startup, a blank renderer.
//
// Run after `npm run build`:  node tests/smoke.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')

// Run against a throwaway profile so the test is hermetic — never touches the
// real app.db / settings and leaves nothing behind between runs.
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-smoke-'))

// Hard ceiling so a hung launch fails the CI job instead of blocking it.
const hardTimeout = setTimeout(() => {
  console.error('[smoke] TIMEOUT — app did not boot within 90s')
  process.exit(1)
}, 90_000)
hardTimeout.unref()

let failure = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })

  // Surface renderer errors for debugging (not a hard failure on their own —
  // a blank render is caught by the #root assertion below).
  win.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[renderer error]', msg.text())
  })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))

  await win.waitForLoadState('domcontentloaded')

  const title = await win.title()
  if (!/swarmmind/i.test(title)) {
    throw new Error(`unexpected window title: "${title}"`)
  }

  // React must mount something into #root (the StartScreen on a fresh profile).
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })

  console.log(`[smoke] booted OK — title="${title}"`)
} catch (err) {
  failure = err instanceof Error ? err.message : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (failure) {
  console.error('[smoke] FAILED:', failure)
  process.exit(1)
}
console.log('[smoke] PASS')
