// Verification for Canvas mode's "capture → annotate → hand off to an agent"
// loop. Two layers, because they fail differently:
//   1. the canvas:saveCapture IPC against real disk state (a bad data-URL guard
//      would be a correctness/security bug, not just a UI bug);
//   2. the UI: place a browser card, screenshot it, and assert an image item
//      lands on the board and its right-click menu offers "Send to agent".
//
// The final PTY injection needs a live agent CLI, which the test env can't
// spawn, so that leg is covered by the pure buildHandoffPrompt unit tests and
// asserted here only up to the menu (which honestly reports "no running
// agents" on a fresh workspace).
//
// Run after `npm run build`:  node tests/canvas-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-canvasverify-'))
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-canvasws-'))

const hardTimeout = setTimeout(() => { console.error('[canvasverify] TIMEOUT'); process.exit(1) }, 150_000)
hardTimeout.unref()

const results = []
let failures = 0
function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

// A 1×1 PNG data URL — the smallest valid capture payload.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let fatal = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })
  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'canvasverify'), wsDir)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[title^="Canvas"]', { timeout: 30_000 })

  // ── Layer 1: the IPC ──────────────────────────────────────────────────────
  const ipc = (fn, ...args) => win.evaluate(([f, a]) => window.swarmmind[f](...a), [fn, args])

  let r = await ipc('canvasSaveCapture', TINY_PNG)
  const savedOk = r.ok && /^\.swarmmind\/canvas-captures\/capture-\d+\.png$/.test(r.rel) && existsSync(r.path)
  check('canvasSaveCapture writes a PNG and returns a repo-relative path', savedOk, JSON.stringify(r))

  r = await ipc('canvasSaveCapture', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
  check('canvasSaveCapture rejects a non-raster (SVG) data URL', !r.ok, JSON.stringify(r))
  r = await ipc('canvasSaveCapture', 'not-a-data-url')
  check('canvasSaveCapture rejects a non-data URL', !r.ok, JSON.stringify(r))

  // ── Layer 2: the UI ───────────────────────────────────────────────────────
  await win.click('[title^="Canvas"]')
  await win.waitForTimeout(600)

  // Place a browser card: select the browser tool (bare-key 'b'), then click an
  // empty patch of board well clear of any auto-created terminal card.
  await win.keyboard.press('b')
  const box = await win.evaluate(() => {
    const el = document.querySelector('#root > div')
    const r = el.getBoundingClientRect()
    return { w: r.width, h: r.height }
  })
  await win.mouse.click(Math.min(box.w - 120, 1000), Math.min(box.h - 160, 620))
  await win.waitForTimeout(700)

  const browserInput = win.locator('input[placeholder="localhost:3000"]').first()
  check('UI: a browser card was placed', await browserInput.count() > 0)

  // The default localhost:3000 isn't served here, so the guest renders Chrome's
  // error page — which is a real, painted page and captures fine. Give it a
  // moment to render before the first shot.
  await win.waitForTimeout(1500)

  // Capture → expect an image card to appear. capturePage can return early
  // before the guest has painted, so re-click while polling.
  const beforeImgs = await win.locator('[data-canvas-card] img[src^="data:"]').count()
  let afterImgs = beforeImgs
  for (let i = 0; i < 20; i++) {
    if (i % 4 === 0) await win.click('[title="Capture screenshot"]').catch(() => {})
    await win.waitForTimeout(350)
    afterImgs = await win.locator('[data-canvas-card] img[src^="data:"]').count()
    if (afterImgs > beforeImgs) break
  }
  check('UI: capturing a browser card adds an image item', afterImgs > beforeImgs, `${beforeImgs} → ${afterImgs}`)

  // Right-click the captured image → its menu must offer "Send to agent".
  if (afterImgs > beforeImgs) {
    const img = win.locator('[data-canvas-card] img[src^="data:"]').last()
    await img.click({ button: 'right' })
    await win.waitForTimeout(400)
    const body = await win.evaluate(() => document.body.innerText)
    check('UI: the image context menu offers "Send to agent"', /Send to agent/i.test(body), '')
    // Fresh workspace → no agent is running, and the menu says so honestly.
    check('UI: reports "No running agents" when none are running', /No running agents/i.test(body), '')
  }

  await win.screenshot({ path: join(root, 'tests', 'canvas-verify.png') })
  console.log('[canvasverify] captures dir:', readdirSync(join(wsDir, '.swarmmind', 'canvas-captures')).join(', '))
} catch (err) {
  fatal = err instanceof Error ? (err.stack ?? err.message) : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (fatal) { console.error('\n[canvasverify] FATAL:', fatal); process.exit(1) }
console.log(`\n[canvasverify] ${results.length - failures}/${results.length} checks passed`)
process.exit(failures ? 1 : 0)
