// Verification for terminal continuity across a view switch — the "switching to
// canvas mode loses the terminals" bug.
//
// Switching the centre view unmounts every AgentPane. The pty keeps running in
// the main process regardless, so the question this test answers is whether the
// renderer *keeps up with it* while no terminal component exists: output that
// arrives during the gap (a lazily-imported CanvasMode chunk plus its own async
// per-workspace load) used to be delivered to a per-component listener that
// wasn't there, so it was neither drawn nor cached — the pane came back missing
// whatever the shell said in between, which reads as a dead terminal.
//
// Three legs, each of which failed before the fix:
//   1. output produced while the panes are unmounted survives into canvas mode;
//   2. it is still there after switching back to the terminal grid;
//   3. maximizing a canvas terminal card does not re-mount it (the card is
//      styled to fill the viewport in place instead of being re-rendered inside
//      a separate overlay, which used to dispose and rebuild the xterm).
//
// Run after `npm run build`:  node tests/canvas-terminal-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-canvasterm-'))
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-canvastermws-'))

const hardTimeout = setTimeout(() => { console.error('[canvasterm] TIMEOUT'); process.exit(1) }, 180_000)
hardTimeout.unref()

const results = []
let failures = 0
function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

// Read everything xterm has painted for a pane, whichever view hosts it.
const paneText = (win, paneId) =>
  win.evaluate((id) => {
    const el = document.getElementById(`pane-${id}`)
    return el ? el.innerText : ''
  }, paneId)

async function waitForText(win, paneId, needle, ms = 15_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await paneText(win, paneId)).includes(needle)) return true
    await win.waitForTimeout(250)
  }
  return false
}

let fatal = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })
  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'canvastermverify'), wsDir)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[title^="Canvas"]', { timeout: 30_000 })

  // The pane auto-starts an interactive shell; wait until it has really booted
  // (an echo comes back) before timing anything.
  await win.waitForSelector('[id^="pane-"]', { timeout: 30_000 })
  const paneId = await win.evaluate(() => document.querySelector('[id^="pane-"]').id.slice('pane-'.length))
  const send = (line) => win.evaluate(([id, l]) => window.swarmmind.ptyInput(id, l), [paneId, line])

  await send('echo SWARM_BOOTED\r')
  const booted = await waitForText(win, paneId, 'SWARM_BOOTED')
  check('a shell is live in the pane before the switch', booted)

  // ── Leg 1: output produced while NO pane is mounted ───────────────────────
  // Any centre overlay unmounts every AgentPane, so the board is used here to
  // hold that state open for a couple of seconds — a deterministic version of
  // the same window a view switch opens. Everything the shell prints in it must
  // still be there when the grid comes back.
  //
  // Note the marker deliberately has to survive as *output*: the pane is gone
  // before the keystrokes are even sent, so nothing — not the shell's echo of
  // the typed line, not its result — has a mounted listener to reach.
  await win.click('[title="Kanban board"]')
  await win.waitForTimeout(700)
  check('no terminal pane is mounted while an overlay is open',
    await win.locator('[id^="pane-"]').count() === 0)

  await send('echo SWARM_WHILE_HIDDEN\r')
  // The assertion is made against the persisted scrollback, NOT the screen.
  // On Windows, ConPTY repaints the visible viewport when the terminal is
  // resized, so a remounted pane can *look* complete while the renderer-side
  // record has a hole in it — and that record is what the scrollback file, the
  // dev-server URL scan and every readPaneOutput() consumer (SwarmAgent, the
  // conductor) actually read. The debounced save is 2.5s, hence the wait.
  await win.waitForTimeout(4000)
  const hiddenScrollback = await win.evaluate((id) => window.swarmmind.scrollbackLoad(id), paneId)
  check('output produced while the panes were unmounted is recorded, not dropped',
    String(hiddenScrollback ?? '').includes('SWARM_WHILE_HIDDEN'),
    `${String(hiddenScrollback ?? '').length} bytes of scrollback`)

  await win.click('[title="Show terminals"]')
  await win.waitForSelector('[id^="pane-"]', { timeout: 15_000 })
  check('it is on screen again once the grid comes back',
    await waitForText(win, paneId, 'SWARM_WHILE_HIDDEN'))

  // ── Leg 2: the same across the switch into canvas mode ────────────────────
  await win.evaluate(([id, l]) => {
    window.swarmmind.ptyInput(id, l)
    document.querySelector('[title^="Canvas"]').click()
  }, [paneId, 'echo SWARM_DURING_SWITCH\r'])

  await win.waitForSelector('[data-canvas-card]', { timeout: 30_000 })
  const survivedIntoCanvas = await waitForText(win, paneId, 'SWARM_DURING_SWITCH')
  check('output produced across the switch into canvas mode survives', survivedIntoCanvas)

  // The pane must also still be *live* in canvas mode, not just showing a
  // replay: type into it there and expect a fresh response.
  await send('echo SWARM_IN_CANVAS\r')
  check('the canvas terminal card is still connected to the running pty',
    await waitForText(win, paneId, 'SWARM_IN_CANVAS'))

  // ── Leg 3: maximize must not re-mount the pane ────────────────────────────
  // Tag the live terminal node, maximize, and check the very same node is still
  // on screen — a re-mount would have replaced it.
  await win.evaluate((id) => {
    document.getElementById(`pane-${id}`).setAttribute('data-continuity-probe', 'yes')
  }, paneId)
  const maximize = win.locator('[data-canvas-card] button[title="Maximize"]').first()
  if (await maximize.count() > 0) {
    await maximize.click()
    await win.waitForTimeout(800)
    const sameNode = await win.evaluate((id) => {
      const el = document.getElementById(`pane-${id}`)
      return !!el && el.getAttribute('data-continuity-probe') === 'yes'
    }, paneId)
    check('maximizing a terminal card keeps the same mounted pane (no xterm rebuild)', sameNode)
    check('the maximized card still shows the session output',
      (await paneText(win, paneId)).includes('SWARM_IN_CANVAS'))
    await win.locator('button', { hasText: 'Restore' }).first().click().catch(() => {})
    await win.waitForTimeout(500)
  } else {
    check('maximizing a terminal card keeps the same mounted pane (no xterm rebuild)', false, 'no Maximize button found')
  }

  // ── Back to the grid ──────────────────────────────────────────────────────
  await win.evaluate(([id, l]) => {
    window.swarmmind.ptyInput(id, l)
    document.querySelector('[title="Show terminals"]').click()
  }, [paneId, 'echo SWARM_BACK_TO_GRID\r'])
  await win.waitForTimeout(600)
  check('output produced while switching back to the grid survives',
    await waitForText(win, paneId, 'SWARM_BACK_TO_GRID'))

  const finalText = await paneText(win, paneId)
  check('the whole session history is intact after the round trip',
    ['SWARM_BOOTED', 'SWARM_WHILE_HIDDEN', 'SWARM_DURING_SWITCH', 'SWARM_IN_CANVAS', 'SWARM_BACK_TO_GRID'].every(m => finalText.includes(m)),
    finalText.replace(/\s+/g, ' ').slice(-160))

  await win.screenshot({ path: join(root, 'tests', 'canvas-terminal-verify.png') })
} catch (err) {
  fatal = err instanceof Error ? (err.stack ?? err.message) : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (fatal) { console.error('\n[canvasterm] FATAL:', fatal); process.exit(1) }
console.log(`\n[canvasterm] ${results.length - failures}/${results.length} checks passed`)
process.exit(failures ? 1 : 0)
