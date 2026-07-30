// Verification for the canvas board's layout tools: eraser, focus mode, tidy /
// align, and lock.
//
// The geometry itself is unit-tested (src/lib/canvasLayout.ts); what needs a
// real app is the wiring, and specifically the two things that would be quietly
// wrong rather than visibly broken:
//   • the eraser must not touch a terminal card — a stray swipe deleting a card
//     would kill a running pty, and nothing on screen would say why;
//   • focus mode must place the panes without re-mounting them, since a
//     re-mount rebuilds the xterm and drops the pane's scrollback.
//
// Run after `npm run build`:  node tests/canvas-tools-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-cvtools-'))
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-cvtoolsws-'))

const hardTimeout = setTimeout(() => { console.error('[cvtools] TIMEOUT'); process.exit(1) }, 180_000)
hardTimeout.unref()

const results = []
let failures = 0
function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const cards = (win) => win.locator('[data-canvas-card]')
const paneCount = (win) => win.locator('[id^="pane-"]').count()

// A point on bare board — no card, no floating chrome under it. The window size
// varies between machines and the board fills with cards as the test runs, so
// every placement/drawing coordinate is found this way rather than hardcoded.
// Must be called with the select tool active: the pen/eraser capture layers
// cover the whole board and would answer for every point.
const emptySpot = (win, fromBottom = 140) => win.evaluate((fb) => {
  const board = document.querySelector('[data-canvas-board]')
  const r = board.getBoundingClientRect()
  for (let y = r.height - fb; y > 80; y -= 30) {
    for (let x = 110; x < r.width - 140; x += 50) {
      const el = document.elementFromPoint(x, y)
      if (el && el.hasAttribute('data-canvas-board')) return { x, y }
    }
  }
  return null
}, fromBottom)

let fatal = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })
  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'cvtools'), wsDir)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[title^="Canvas"]', { timeout: 30_000 })

  await win.click('[title^="Canvas"]')
  await win.waitForSelector('[data-canvas-card]', { timeout: 30_000 })
  const board = await win.evaluate(() => {
    const r = document.querySelector('#root > div').getBoundingClientRect()
    return { w: r.width, h: r.height }
  })

  // Two more terminals, so focus mode has something to dock. Each goes on bare
  // board — the placement click only fires when it lands on empty canvas.
  for (let i = 0; i < 2; i++) {
    const spot = await emptySpot(win, 200)
    if (!spot) break
    await win.click('[title^="Add terminal"]')
    await win.mouse.click(spot.x, spot.y)
    await win.waitForTimeout(700)
  }
  const terminals = await paneCount(win)
  check('three terminal cards on the board', terminals >= 3, `${terminals} panes`)

  // ── Eraser ────────────────────────────────────────────────────────────────
  // Draw a stroke over empty board, then erase it.
  // Tools are picked from the rail rather than by shortcut: clicking into a
  // terminal to create it leaves the keyboard focus inside its xterm, where the
  // board's bare-key shortcuts are deliberately suppressed (you don't want "p"
  // to change tools while you're typing at an agent). The shortcut path is
  // checked separately below, after clicking back onto bare board.
  const strokes = () => win.evaluate(() => document.querySelectorAll('[data-canvas-draw]').length)
  const pen = await emptySpot(win, 120)
  check('found bare board to draw on', !!pen, JSON.stringify(pen))
  const swipe = async () => {
    await win.mouse.move(pen.x, pen.y)
    await win.mouse.down()
    for (let i = 1; i <= 8; i++) await win.mouse.move(pen.x + i * 12, pen.y + (i % 2) * 10)
    await win.mouse.up()
    await win.waitForTimeout(400)
  }

  await win.click('[title^="Draw"]')
  await win.waitForTimeout(200)
  await swipe()
  const drawn = await strokes()
  check('the pen leaves a stroke on the board', drawn > 0, `${drawn} strokes`)

  await win.click('[title^="Erase"]')
  await win.waitForTimeout(200)
  await swipe()
  const left = await strokes()
  check('the eraser removes the stroke', left < drawn, `${drawn} → ${left}`)

  // The important half: swiping the eraser across a terminal card must leave it
  // (and its pty) completely alone.
  const before = await cards(win).count()
  const panesBefore = await paneCount(win)
  const box = await cards(win).first().boundingBox()
  await win.mouse.move(box.x + 20, box.y + box.height / 2)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 12 })
  await win.mouse.up()
  await win.waitForTimeout(500)
  check('the eraser will not delete a terminal card',
    await cards(win).count() === before && await paneCount(win) === panesBefore,
    `${before} → ${await cards(win).count()} cards`)
  const body = await win.evaluate(() => document.body.innerText)
  check('and says why instead of silently doing nothing', /aren’t erased|aren't erased/i.test(body))

  // ── Undo the erase ────────────────────────────────────────────────────────
  await win.keyboard.press('Control+z')
  await win.waitForTimeout(400)
  check('Ctrl+Z restores what the eraser removed', await strokes() >= drawn, `${await strokes()} strokes`)

  // Bare-key shortcuts, now that focus is on the board rather than in a pane.
  await win.keyboard.press('e')
  await win.waitForTimeout(200)
  const eraseArmed = await win.evaluate(() =>
    !!document.querySelector('[title^="Erase"]')?.getAttribute('style')?.includes('accent'))
  check('the bare-key tool shortcut works when the board has focus', eraseArmed)
  await win.keyboard.press('v')
  await win.waitForTimeout(200)

  // ── Focus mode ────────────────────────────────────────────────────────────
  // Tag every mounted pane, focus one, and check the same nodes are still there
  // — focus must be a geometry change, not a re-mount.
  await win.evaluate(() => {
    document.querySelectorAll('[id^="pane-"]').forEach((el, i) => el.setAttribute('data-focus-probe', String(i)))
  })
  await win.locator('[data-canvas-card] button[title^="Focus"]').first().click()
  await win.waitForTimeout(700)
  check('focus mode is on', await win.locator('text=Focus mode').count() > 0)
  const probed = await win.evaluate(() =>
    document.querySelectorAll('[id^="pane-"][data-focus-probe]').length)
  check('focusing does not re-mount any pane (no xterm rebuild)', probed === terminals, `${probed}/${terminals} kept`)

  // Stage on the left, the others stacked down the right edge.
  const geom = await win.evaluate(() => {
    const visible = [...document.querySelectorAll('[data-canvas-card]')]
      .filter(el => el.querySelector('[id^="pane-"]') && getComputedStyle(el).display !== 'none')
      .map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
      .sort((a, b) => b.w - a.w)
    return { stage: visible[0], dock: visible.slice(1), total: visible.length }
  })
  check('one terminal is on stage and the rest are docked', geom.total >= 3 && geom.dock.length >= 2,
    `stage + ${geom.dock.length} docked`)
  check('the dock sits to the right of the stage',
    geom.dock.every(d => d.x >= geom.stage.x + geom.stage.w - 2),
    JSON.stringify(geom.dock.map(d => Math.round(d.x))))
  check('docked terminals are stacked, not piled on each other',
    geom.dock.every((d, i) => i === 0 || d.y >= geom.dock[i - 1].y + geom.dock[i - 1].h - 2))
  check('nothing in the dock hangs off the bottom of the board',
    geom.dock.every(d => d.y + d.h <= board.h + 2))

  await win.screenshot({ path: join(root, 'tests', 'canvas-tools-verify.png') })

  // Escape leaves focus mode and the board comes back intact.
  await win.keyboard.press('Escape')
  await win.waitForTimeout(600)
  check('Escape leaves focus mode', await win.locator('text=Focus mode').count() === 0)
  check('every pane survived the round trip', await paneCount(win) === terminals)

  // ── Tidy ──────────────────────────────────────────────────────────────────
  const rects = () => win.evaluate(() => [...document.querySelectorAll('[data-canvas-card]')]
    .map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }))
  const overlapCount = (rs) => {
    let n = 0
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++
    }
    return n
  }
  await win.keyboard.press('u')
  await win.waitForTimeout(700)
  check('tidy leaves no overlapping cards', overlapCount(await rects()) === 0)
  check('tidy keeps every card', await cards(win).count() === before, `${await cards(win).count()} cards`)

  // ── Lock ──────────────────────────────────────────────────────────────────
  // A locked card must not move, and must not be deletable by the Delete key.
  const target = cards(win).first()
  await target.click({ button: 'right' })
  await win.waitForTimeout(300)
  await win.locator('.ctx-menu-item', { hasText: 'Lock in place' }).first().click()
  await win.waitForTimeout(300)
  const lockedBox = await target.boundingBox()
  const header = await target.locator('div').first().boundingBox()
  await win.mouse.move(header.x + 60, header.y + 10)
  await win.mouse.down()
  await win.mouse.move(header.x + 260, header.y + 180, { steps: 8 })
  await win.mouse.up()
  await win.waitForTimeout(400)
  const afterBox = await target.boundingBox()
  check('a locked card cannot be dragged',
    Math.abs(afterBox.x - lockedBox.x) < 3 && Math.abs(afterBox.y - lockedBox.y) < 3,
    `${Math.round(lockedBox.x)},${Math.round(lockedBox.y)} → ${Math.round(afterBox.x)},${Math.round(afterBox.y)}`)

  // ── Shortcut sheet ────────────────────────────────────────────────────────
  await win.click('[data-canvas-board]', { position: { x: 60, y: 60 } }).catch(() => {})
  await win.keyboard.press('Shift+Slash')
  await win.waitForTimeout(500)
  const sheetOpen = await win.locator('text=Keyboard shortcuts').count() > 0
  check('? opens the shortcut sheet', sheetOpen)
  if (sheetOpen) {
    await win.screenshot({ path: join(root, 'tests', 'canvas-tools-shortcuts.png') })
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    check('Escape closes it', await win.locator('text=Keyboard shortcuts').count() === 0)
  }
} catch (err) {
  fatal = err instanceof Error ? (err.stack ?? err.message) : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (fatal) { console.error('\n[cvtools] FATAL:', fatal); process.exit(1) }
console.log(`\n[cvtools] ${results.length - failures}/${results.length} checks passed`)
process.exit(failures ? 1 : 0)
