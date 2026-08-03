// Verification for the canvas board's swarm-awareness layer: semantic zoom,
// frames, live message routes and note→task.
//
// The arithmetic behind each of these is unit-tested (canvasLod / canvasFrames /
// canvasRoutes / canvasAttention in tests/lib-units.mts). What needs the real
// app is the wiring, and specifically the three claims that would be quietly
// wrong rather than visibly broken:
//
//   • **Semantic zoom must not unmount anything.** The tile is only affordable
//     because swapping to it is free; if the live terminal is unmounted instead
//     of hidden, every zoom out disposes an xterm and every zoom in rebuilds it,
//     which is exactly the thrash the tile exists to avoid.
//   • **A frame must carry its contents.** Dragging one has to move the cards
//     inside it by the same delta, or the region is just a rectangle.
//   • **A route must deliver with the board closed.** The whole point of
//     publishing routes to the store is that delivery survives a view switch —
//     wiring that only worked while you were looking at the diagram of it would
//     be a trap. This drives it against two real shells.
//
// Run after `npm run build`:  node tests/canvas-board-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-cvboard-'))
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-cvboardws-'))

const hardTimeout = setTimeout(() => { console.error('[cvboard] TIMEOUT'); process.exit(1) }, 240_000)
hardTimeout.unref()

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const cards = (win) => win.locator('[data-canvas-card]')

// A point on bare board. The board is NOT at the viewport origin (sidebar +
// title bar), so the scan walks the board rect's own right/bottom rather than
// its width/height — elementFromPoint takes viewport coordinates, and a
// width-based loop silently scans a region that isn't the board.
const emptySpot = (win, fromBottom = 160) => win.evaluate((fb) => {
  const board = document.querySelector('[data-canvas-board]')
  const r = board.getBoundingClientRect()
  for (let y = r.bottom - fb; y > r.top + 80; y -= 30) {
    for (let x = r.left + 130; x < r.right - 160; x += 50) {
      const el = document.elementFromPoint(x, y)
      if (el && el.hasAttribute('data-canvas-board')) return { x, y }
    }
  }
  return null
}, fromBottom)

// Geometry of every card, keyed by the pane it hosts (or by index for the rest).
const cardBoxes = (win) => win.evaluate(() =>
  [...document.querySelectorAll('[data-canvas-card]')].map((el, i) => {
    const r = el.getBoundingClientRect()
    return {
      i,
      frame: el.hasAttribute('data-canvas-frame'),
      pane: el.querySelector('[id^="pane-"]')?.id ?? null,
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    }
  }))

const zoomBoard = async (win, times, dir) => {
  const label = dir < 0 ? 'Zoom out' : 'Zoom in'
  for (let i = 0; i < times; i++) {
    await win.click(`[title="${label}"]`)
    await win.waitForTimeout(120)
  }
  await win.waitForTimeout(400)
}

let fatal = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })
  const opened = await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'cvboard'), wsDir)
  const workspaceId = opened?.id
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[title^="Canvas"]', { timeout: 30_000 })

  await win.click('[title^="Canvas"]')
  await win.waitForSelector('[data-canvas-card]', { timeout: 30_000 })

  // A second terminal, so there's something to route to and something to put
  // inside a frame alongside the first.
  const second = await emptySpot(win, 220)
  if (second) {
    await win.click('[title^="Add terminal"]')
    await win.mouse.click(second.x, second.y)
    await win.waitForTimeout(900)
  }
  const paneIds = await win.evaluate(() =>
    [...document.querySelectorAll('[id^="pane-"]')].map(el => el.id.slice('pane-'.length)))
  check('two terminal cards on the board', paneIds.length >= 2, `${paneIds.length} panes`)

  // ── Semantic zoom ─────────────────────────────────────────────────────────
  check('terminals render live at 100%', await win.locator('[data-canvas-tile]').count() === 0)
  const mountedBefore = await win.evaluate(() =>
    [...document.querySelectorAll('[id^="pane-"]')].map(el => el.id).sort().join(','))

  await zoomBoard(win, 4, -1)
  const tiles = await win.locator('[data-canvas-tile]').count()
  check('zoomed out, terminals become status tiles', tiles >= 2, `${tiles} tiles`)

  // The load-bearing half: the panes are HIDDEN, not unmounted. Same ids, same
  // count — so no xterm was disposed to draw a tile.
  const mountedDuring = await win.evaluate(() =>
    [...document.querySelectorAll('[id^="pane-"]')].map(el => el.id).sort().join(','))
  check('the live panes are hidden, never unmounted (no xterm rebuild)',
    mountedDuring === mountedBefore && mountedBefore.length > 0,
    `${mountedDuring.split(',').length} panes kept`)

  check('a tile reports the pane state it was given',
    ['idle', 'working', 'waiting', 'stopped'].includes(
      await win.locator('[data-canvas-tile]').first().getAttribute('data-canvas-tile')))

  // The switch is one click, and it wins over the zoom.
  await win.click('[title*="status tile"]')
  await win.waitForTimeout(400)
  check('turning semantic zoom off brings the live terminals straight back',
    await win.locator('[data-canvas-tile]').count() === 0)
  await win.click('[title*="status tile"]')
  await win.waitForTimeout(400)
  check('and turning it back on re-tiles them', await win.locator('[data-canvas-tile]').count() >= 2)

  await zoomBoard(win, 4, 1)
  check('zoomed back in, the terminals are live again',
    await win.locator('[data-canvas-tile]').count() === 0)

  // ── Routes: draw the arrow ────────────────────────────────────────────────
  // Drawn before the frame work moves the cards around; the relay it triggers is
  // checked at the very end, after the board has been closed.
  const [sourcePane, targetPane] = paneIds
  const centres = await win.evaluate(() =>
    [...document.querySelectorAll('[data-canvas-card]')]
      .map(el => {
        const pane = el.querySelector('[id^="pane-"]')
        if (!pane) return null
        const r = el.getBoundingClientRect()
        return { pane: pane.id.slice('pane-'.length), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })
      .filter(Boolean))
  const from = centres.find(c => c.pane === sourcePane)
  const to = centres.find(c => c.pane === targetPane)

  await win.click('[title^="Connect items"]')
  await win.mouse.click(from.x, from.y)
  await win.waitForTimeout(200)
  await win.mouse.click(to.x, to.y)
  await win.waitForTimeout(500)
  check('an arrow is drawn between the two terminals',
    await win.locator('[data-canvas-board] svg line[marker-end]').count() >= 1)
  await win.click('[title^="Select & move"]')

  // ── Frames ────────────────────────────────────────────────────────────────
  // Placed over a spot that already has cards near it, then dragged; the cards
  // whose centres it covers must come along.
  const framePos = await emptySpot(win, 200)
  await win.click('[title^="Frame"]')
  await win.mouse.click(framePos.x, framePos.y)
  await win.waitForTimeout(600)
  check('a frame card is on the board', await win.locator('[data-canvas-frame]').count() === 1)

  const beforeDrag = await cardBoxes(win)
  const frameBox = beforeDrag.find(b => b.frame)
  // Which cards the frame owns, by the same centre rule the app uses.
  const owned = beforeDrag.filter(b => !b.frame &&
    b.x + b.w / 2 >= frameBox.x && b.x + b.w / 2 <= frameBox.x + frameBox.w &&
    b.y + b.h / 2 >= frameBox.y && b.y + b.h / 2 <= frameBox.y + frameBox.h)
  const outside = beforeDrag.filter(b => !b.frame && !owned.some(o => o.i === b.i))
  check('the frame reports what it contains', owned.length >= 1, `${owned.length} inside`)

  // Drag by the label, which is a sibling drawn just above the frame (a label
  // inside the frame's stacking context would be buried by the first card
  // dropped on it — a frame's normal state).
  const labelBox = await win.evaluate(() => {
    const r = document.querySelector('[data-canvas-frame-label]').getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  })
  check('the frame label sits outside the frame, above its top edge',
    labelBox.y + labelBox.h <= frameBox.y + 1, `label bottom ${labelBox.y + labelBox.h} vs frame top ${frameBox.y}`)
  const grabX = labelBox.x + labelBox.w / 2
  const grabY = labelBox.y + labelBox.h / 2
  await win.mouse.move(grabX, grabY)
  await win.mouse.down()
  await win.mouse.move(grabX - 140, grabY - 90, { steps: 12 })
  await win.mouse.up()
  await win.waitForTimeout(500)

  const afterDrag = await cardBoxes(win)
  const movedFrame = afterDrag.find(b => b.frame)
  const frameDx = movedFrame.x - frameBox.x
  check('the frame moved', Math.abs(frameDx) > 60, `dx ${frameDx}`)
  const carried = owned.every(o => {
    const now = afterDrag.find(b => b.i === o.i)
    return now && Math.abs((now.x - o.x) - frameDx) <= 2
  })
  check('everything inside moved with it, by the same delta', carried, `${owned.length} carried`)
  const stayed = outside.every(o => {
    const now = afterDrag.find(b => b.i === o.i)
    return now && Math.abs(now.x - o.x) <= 2
  })
  check('cards outside the frame stayed where they were', stayed, `${outside.length} untouched`)

  // Empty space inside a frame must still belong to the board, or there would
  // be no marquee select and no "add here" inside the region you organise in.
  // Scanned rather than probed at one corner: the frame overlaps real cards, and
  // hitting one of those would prove nothing either way.
  const insideProbe = await win.evaluate(() => {
    const f = document.querySelector('[data-canvas-frame]').getBoundingClientRect()
    let sawGap = false
    for (let y = f.top + 20; y < f.bottom - 20; y += 24) {
      for (let x = f.left + 20; x < f.right - 20; x += 24) {
        const el = document.elementFromPoint(x, y)
        if (!el) continue
        if (el.hasAttribute('data-canvas-board')) { sawGap = true; continue }
        // Anything that isn't the board must be a real card, never the frame.
        if (el.closest('[data-canvas-frame]')) return { ok: false, at: { x, y } }
      }
    }
    return { ok: sawGap, at: null }
  })
  check('the frame interior does not swallow clicks meant for the board',
    insideProbe.ok, insideProbe.at ? `blocked at ${insideProbe.at.x},${insideProbe.at.y}` : '')

  // ── Note → task ───────────────────────────────────────────────────────────
  const tasksBefore = (await win.evaluate(() => window.swarmmind.taskList())).length
  const notePos = await emptySpot(win, 240)
  await win.click('[title^="Sticky note"]')
  await win.mouse.click(notePos.x, notePos.y)
  await win.waitForTimeout(500)
  const noteArea = win.locator('[data-canvas-card] textarea').last()
  await noteArea.click()
  await noteArea.type('Fix the flaky auth test')
  await win.waitForTimeout(300)
  await win.mouse.click(notePos.x, notePos.y - 60)  // blur the textarea

  const cardsBeforeConvert = await cards(win).count()
  await win.mouse.click(notePos.x, notePos.y, { button: 'right' })
  await win.waitForTimeout(300)
  const convert = win.locator('.ctx-menu-item', { hasText: 'Turn into a task' })
  check('a note offers to become a task', await convert.count() === 1)
  await convert.first().click()
  await win.waitForTimeout(1200)

  const tasksAfter = await win.evaluate(() => window.swarmmind.taskList())
  check('converting a note inserts a real task row',
    tasksAfter.length === tasksBefore + 1, `${tasksBefore} → ${tasksAfter.length}`)
  check('the task carries the note\'s text as its title',
    tasksAfter.some(tk => tk.title === 'Fix the flaky auth test'),
    tasksAfter.map(tk => tk.title).join(' | '))
  check('the note is replaced, not duplicated alongside the task',
    await cards(win).count() === cardsBeforeConvert)

  // ── Routes: the relay ─────────────────────────────────────────────────────
  // Leave the board. This is the assertion that matters: the wiring is
  // published to the store, so it has to keep working with CanvasMode unmounted.
  await win.click('[title="Show terminals"]')
  await win.waitForSelector('[id^="pane-"]', { timeout: 15_000 })

  // A relay rides on the working→waiting edge, and `pty:state` is only emitted
  // for panes that spawned an *agent* — a bare shell never reports a turn. So
  // both panes are re-spawned as an agent whose executable is redirected, via
  // the app's own signed settings path, to a harmless built-in. That leaves a
  // live interactive shell (the wrapper is `-NoExit`) carrying an agentId, which
  // is exactly the pty shape a real agent has, with nothing installed.
  await win.evaluate(() => window.swarmmind.setAgentConfig('kilo', { executablePath: 'cd' }))
  for (const id of [sourcePane, targetPane]) {
    await win.evaluate(([pid, cwd, ws]) =>
      window.swarmmind.ptyCreate(pid, 'kilo', cwd, 'powershell', undefined, 80, 24, false, undefined, ws),
      [id, wsDir, workspaceId])
  }
  await win.waitForTimeout(4000)

  await win.evaluate(([id]) => window.swarmmind.ptyInput(id, 'echo SWARM_ROUTE_TRIGGER_LINE\r'), [sourcePane])
  // The source has to fall quiet for the idle timer (4s) before pty:state flips
  // it to `waiting`, which is the edge a relay rides on. Then the injected
  // prompt has to reach the target's shell and be echoed back, and the
  // scrollback save is debounced by another 2.5s on top.
  await win.waitForTimeout(14_000)

  const targetOut = await win.evaluate((id) => window.swarmmind.scrollbackLoad(id), targetPane)
  check('the finished turn was relayed downstream with the board closed',
    String(targetOut ?? '').includes('SwarmMind relay'),
    `${String(targetOut ?? '').length} bytes of target scrollback`)

  // …and only downstream. An arrow is directional; the source must not receive
  // its own relay, which is what a symmetric implementation would produce.
  const sourceOut = await win.evaluate((id) => window.swarmmind.scrollbackLoad(id), sourcePane)
  check('the source did not receive its own relay',
    !String(sourceOut ?? '').includes('SwarmMind relay ←'))
} catch (err) {
  fatal = err
  check('run completed without throwing', false, String(err && err.message || err))
} finally {
  await app.close().catch(() => {})
}

console.log(`\n[cvboard] ${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`)
if (fatal) console.error(fatal)
process.exit(failures === 0 ? 0 : 1)
