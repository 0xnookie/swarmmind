// Verification for the floating SwarmVoice widget.
//
// The drag *maths* is unit-tested (src/lib/dragWidget.ts); what this checks is
// the part unit tests can't: that the widget actually appears, that dragging it
// moves it, that the position survives a reload, and that a position saved for
// a bigger window is pulled back on screen instead of being stranded off-edge.
//
// No microphone is involved — recording needs real mic permission and audio,
// which CI has neither of. The widget's dictation controls are covered by the
// vad/useVoice logic tests; this is about the widget as a window citizen.
//
// The pill is small enough that the whole thing is both button and drag handle,
// so the click-vs-drag threshold is load-bearing: a short press must start
// dictation, a longer travel must move the widget and NOT toggle it.
//
// Run after `npm run build`:  node tests/voice-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-voiceverify-'))
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-voicews-'))

const hardTimeout = setTimeout(() => { console.error('[voiceverify] TIMEOUT'); process.exit(1) }, 120_000)
hardTimeout.unref()

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const WIDGET = 'button[aria-label="Dictation"]'

let fatal = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })
  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'voiceverify'), wsDir)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  const voiceBtn = win.locator('button[aria-label="Toggle dictation widget"]')
  await voiceBtn.waitFor({ timeout: 30_000 })
  check('widget is hidden until asked for', await win.locator(WIDGET).count() === 0)

  // ── It has to look like the icons beside it ───────────────────────────────
  // The voice control once hand-rolled its own round button and stood out in
  // the row; it now uses the shared IconBtn. Compare it against a sibling
  // rather than hard-coding 28/6px, so the check follows IconBtn if it changes.
  const geometry = await win.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Toggle dictation widget"]')
    const siblings = [...(btn?.parentElement?.querySelectorAll(':scope > button') ?? [])]
      .filter(b => b !== btn)
    const box = (el) => {
      const cs = getComputedStyle(el)
      return { w: el.offsetWidth, h: el.offsetHeight, r: cs.borderRadius, bw: cs.borderTopWidth }
    }
    return { self: btn ? box(btn) : null, siblings: siblings.map(box) }
  })
  const twin = geometry.siblings.find(sib =>
    sib.w === geometry.self?.w && sib.h === geometry.self?.h)
  check('voice icon matches the neighbouring TopBar icons',
    !!twin && twin.r === geometry.self.r && twin.bw === geometry.self.bw,
    `${JSON.stringify(geometry.self)} vs ${JSON.stringify(twin ?? geometry.siblings[0])}`)

  // ── The TopBar icon shows the pill ────────────────────────────────────────
  await voiceBtn.click()
  const widget = win.locator(WIDGET).first()
  await widget.waitFor({ timeout: 10_000 })
  check('the TopBar voice icon opens the widget', true)

  const card = widget

  const before = await card.boundingBox()
  check('widget starts fully on screen', !!before && before.x >= 0 && before.y >= 0,
    JSON.stringify(before))
  // It stands in for a TopBar button, so it must stay genuinely small.
  check('pill is compact', !!before && before.width < 110 && before.height < 40,
    `${before?.width}x${before?.height}`)

  // ── Drag the pill itself (it is its own handle) ───────────────────────────
  await win.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await win.mouse.down()
  await win.mouse.move(320, 260, { steps: 12 })
  await win.mouse.up()
  await win.waitForTimeout(250)

  const after = await card.boundingBox()
  const moved = !!after && (Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20)
  check('dragging the pill moves the widget', moved,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`)

  const saved = await win.evaluate(() => window.swarmmind.getAppSetting('voiceWidgetPos'))
  const parsed = (() => { try { return JSON.parse(saved) } catch { return null } })()
  check('position is persisted', parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y),
    String(saved))

  // ── Survives a restart ────────────────────────────────────────────────────
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.locator(WIDGET).first().waitFor({ timeout: 20_000 })
  const restored = await win.locator(WIDGET).first().boundingBox()
  const sameSpot = restored && Math.abs(restored.x - after.x) < 6 && Math.abs(restored.y - after.y) < 6
  check('widget reopens where it was left', !!sameSpot,
    `${JSON.stringify(after)} → ${JSON.stringify(restored)}`)

  // ── A position saved for a larger window is pulled back on screen ─────────
  // Simulates reopening on a smaller display: without re-clamping the widget
  // would sit outside the viewport and be impossible to grab.
  await win.evaluate(() =>
    window.swarmmind.setAppSetting('voiceWidgetPos', JSON.stringify({ x: 5000, y: 5000 })))
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.locator(WIDGET).first().waitFor({ timeout: 20_000 })
  await win.waitForTimeout(300)
  const rescued = await win.locator(WIDGET).first().boundingBox()
  const viewport = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const onScreen = rescued &&
    rescued.x >= 0 && rescued.y >= 0 &&
    rescued.x + rescued.width <= viewport.w + 1 &&
    rescued.y + rescued.height <= viewport.h + 1
  check('an off-screen saved position is clamped back into view', !!onScreen,
    `${JSON.stringify(rescued)} in ${JSON.stringify(viewport)}`)

  // ── A short press is a click, not a drag ──────────────────────────────────
  // Below the threshold the pill must stay put (and, with no mic in CI, report
  // "no pane"/mic failure rather than moving).
  const beforeTap = await win.locator(WIDGET).first().boundingBox()
  await win.mouse.move(beforeTap.x + beforeTap.width / 2, beforeTap.y + beforeTap.height / 2)
  await win.mouse.down()
  await win.mouse.move(beforeTap.x + beforeTap.width / 2 + 2, beforeTap.y + beforeTap.height / 2 + 1)
  await win.mouse.up()
  await win.waitForTimeout(200)
  const afterTap = await win.locator(WIDGET).first().boundingBox()
  check('a short press does not move the pill',
    Math.abs(afterTap.x - beforeTap.x) < 3 && Math.abs(afterTap.y - beforeTap.y) < 3,
    `${JSON.stringify(beforeTap)} → ${JSON.stringify(afterTap)}`)

  // ── The TopBar icon is a toggle ───────────────────────────────────────────
  await voiceBtn.click()
  await win.waitForTimeout(200)
  check('the TopBar icon hides the widget again', await win.locator(WIDGET).count() === 0)
  await voiceBtn.click()
  await win.locator(WIDGET).first().waitFor({ timeout: 10_000 })

  // ── Closing it from the pill ──────────────────────────────────────────────
  await win.locator(WIDGET).first().click({ button: 'right' })
  await win.waitForTimeout(200)
  check('right-click dismisses the widget', await win.locator(WIDGET).count() === 0)
} catch (err) {
  fatal = err
} finally {
  await app.close().catch(() => {})
}

if (fatal) {
  console.error('[voiceverify] ERROR', fatal)
  process.exit(1)
}
console.log(failures ? `\n[voiceverify] ${failures} FAILED` : '\n[voiceverify] PASS')
process.exit(failures ? 1 : 0)
