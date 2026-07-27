// Verification for the PTY output path — the hottest loop in the app and the
// one every terminal depends on.
//
// Main-process output is coalesced into frame-sized batches (OUTPUT_FLUSH_MS in
// electron/pty-manager.ts) instead of one IPC message per node-pty chunk. That
// is a pure performance change, so it must be invisible in behaviour and
// visible in message count. This asserts both:
//
//   1. Correctness — a command's output still reaches the renderer intact and
//      in order, and the tail of a process's output isn't lost when it exits.
//   2. The batching itself — a burst of many lines arrives in far fewer IPC
//      messages than it has lines. Without coalescing this ratio collapses and
//      the test fails, which is what stops the optimisation being silently
//      reverted by a later refactor.
//
// Run after `npm run build`:  node tests/pty-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-ptyverify-'))
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-ptyws-'))

const hardTimeout = setTimeout(() => { console.error('[ptyverify] TIMEOUT'); process.exit(1) }, 120_000)
hardTimeout.unref()

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const shellStyle = process.platform === 'win32' ? 'powershell' : 'bash'

let fatal = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })
  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'ptyverify'), wsDir)

  // Collect every pty:output message for our own pane, keeping the messages
  // separate so we can count them (not just concatenate them).
  await win.evaluate(() => {
    window.__ptyMsgs = []
    window.swarmmind.onPtyOutput((paneId, data) => {
      if (paneId === 'verify-pane') window.__ptyMsgs.push(data)
    })
  })

  await win.evaluate(([cwd, style]) =>
    window.swarmmind.ptyCreateShell('verify-pane', cwd, style, 120, 30), [wsDir, shellStyle])

  // Wait for the shell to reach its prompt before driving it.
  await win.waitForFunction(() => (window.__ptyMsgs ?? []).length > 0, null, { timeout: 30_000 })
  await win.waitForTimeout(2500)

  // ── 1. Correctness: a simple command round-trips ──────────────────────────
  await win.evaluate(() => { window.__ptyMsgs.length = 0 })
  await win.evaluate(() => window.swarmmind.ptyInput('verify-pane', 'echo SWARMMIND_PTY_OK\r'))
  const sawMarker = await win
    .waitForFunction(
      () => (window.__ptyMsgs ?? []).join('').includes('SWARMMIND_PTY_OK'),
      null,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('command output reaches the renderer', sawMarker)

  // ── 2. Batching: a burst of lines arrives coalesced ───────────────────────
  // 400 lines emitted as fast as the shell can write them. Un-batched this is
  // hundreds of IPC messages; batched it should be a small number of frames.
  const LINES = 400
  await win.evaluate(() => { window.__ptyMsgs.length = 0 })
  const burst = process.platform === 'win32'
    ? `1..${LINES} | ForEach-Object { "burstline $_" }\r`
    : `for i in $(seq 1 ${LINES}); do echo "burstline $i"; done\r`
  await win.evaluate((cmd) => window.swarmmind.ptyInput('verify-pane', cmd), burst)

  const gotAll = await win
    .waitForFunction(
      (n) => (window.__ptyMsgs ?? []).join('').includes(`burstline ${n}`),
      LINES,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  check(`all ${LINES} burst lines arrive`, gotAll)

  const stats = await win.evaluate((n) => {
    const msgs = window.__ptyMsgs ?? []
    const joined = msgs.join('')
    // Ordering check: line k must appear before line k+1 in the stream.
    let ordered = true
    let at = 0
    for (let i = 1; i <= n; i++) {
      const idx = joined.indexOf(`burstline ${i}`, at)
      if (idx < 0) { ordered = false; break }
      at = idx
    }
    return { messages: msgs.length, ordered }
  }, LINES)

  check('burst output stays in order', stats.ordered)
  // The real assertion. One message per chunk would be >= LINES here; a frame's
  // worth of coalescing puts it an order of magnitude lower. The bound is loose
  // on purpose — it's catching "batching was removed", not measuring cadence.
  check(
    `burst is coalesced (${stats.messages} IPC messages for ${LINES} lines)`,
    stats.messages < LINES / 4,
    `expected < ${LINES / 4}`,
  )

  // ── 3. The exit flush: a dying pty's last output isn't dropped ────────────
  await win.evaluate(() => { window.__ptyMsgs.length = 0 })
  await win.evaluate(() => window.swarmmind.ptyInput('verify-pane', 'echo FINAL_LINE_BEFORE_EXIT\r'))
  const sawFinal = await win
    .waitForFunction(
      () => (window.__ptyMsgs ?? []).join('').includes('FINAL_LINE_BEFORE_EXIT'),
      null,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('output written just before teardown is flushed', sawFinal)

  await win.evaluate(() => window.swarmmind.ptyKill('verify-pane', true))
} catch (err) {
  fatal = err
} finally {
  await app.close().catch(() => {})
}

if (fatal) {
  console.error('[ptyverify] ERROR', fatal)
  process.exit(1)
}
console.log(failures ? `\n[ptyverify] ${failures} FAILED` : '\n[ptyverify] PASS')
process.exit(failures ? 1 : 0)
