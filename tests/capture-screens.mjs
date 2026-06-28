// README screenshot capture: boots the built Electron app against a throwaway
// profile + temp workspace and screenshots each major view into docs/.
// Run after `npm run build`:  node tests/capture-screens.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const docs = join(root, 'docs')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-shots-'))

// A small but realistic workspace so the file tree / editor look populated.
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-shotws-'))
mkdirSync(join(wsDir, 'src'), { recursive: true })
writeFileSync(join(wsDir, 'package.json'), JSON.stringify({
  name: 'demo-app', version: '1.0.0',
  scripts: { dev: 'vite', build: 'vite build', typecheck: 'tsc --noEmit', test: 'node test.mjs' },
}, null, 2))
writeFileSync(join(wsDir, 'README.md'), '# Demo App\n\nA sample project opened in SwarmMind.\n')
writeFileSync(join(wsDir, 'src', 'geometry.ts'),
`// 2D geometry helpers
import { clamp } from './util'

export interface Point { x: number; y: number }

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

export function lerp(a: Point, b: Point, t: number): Point {
  const k = clamp(t, 0, 1)
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
}

const ORIGIN: Point = { x: 0, y: 0 }
console.log('distance', distance(ORIGIN, { x: 3, y: 4 }))
`)
writeFileSync(join(wsDir, 'src', 'util.ts'),
`export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
`)

const hardTimeout = setTimeout(() => { console.error('[shots] TIMEOUT'); process.exit(1) }, 180_000)
hardTimeout.unref()

const shot = async (win, name) => {
  await win.screenshot({ path: join(docs, name) })
  console.log('[shots]  ->', name)
}
const click = async (win, sel) => {
  const el = await win.waitForSelector(sel, { timeout: 12_000 })
  await el.click()
}

let failure = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  let win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })

  // Consistent, generous window size for crisp README shots.
  const winId = await win.evaluate(() => 0)
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1440, 900)
    w.center()
  }).catch(() => {})
  await win.waitForTimeout(400)

  // 1) Start screen (fresh profile, no workspace yet).
  await win.waitForTimeout(800)
  await shot(win, 'startscreen.png')

  // Open the seeded workspace, then populate the shared memory + task queue
  // over the real IPC so the board / graph aren't empty, then reload so App
  // auto-opens it fully wired.
  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'demo'), wsDir)
  await win.evaluate(async () => {
    const s = window.swarmmind
    // Memory entries (agentId drives the graph's agent → entry links).
    await s.memoryWrite('plan:auth-flow', 'OAuth + refresh-token rotation; store tokens in safeStorage.', 'context', 'claude')
    await s.memoryWrite('result:api-layer', 'REST client with retry/backoff done; 14 endpoints typed.', 'history', 'codex')
    await s.memoryWrite('decision:db', 'Chose SQLite (better-sqlite3) for the local cache.', 'context', 'claude')
    // Task queue across columns, with an assignee + a dependency.
    const a = await s.taskCreate('Design auth flow', 'Spec the OAuth + refresh-token rotation.', 'claude')
    const b = await s.taskCreate('Build API client', 'Typed REST layer with retry/backoff.', 'codex')
    const c = await s.taskCreate('Wire login UI', 'Connect the form to the auth flow.', 'claude', [a?.id])
    await s.taskCreate('Write integration tests', 'Cover the login + token-refresh paths.', 'codex')
    if (a?.id) await s.taskUpdate(a.id, 'done')
    if (b?.id) await s.taskUpdate(b.id, 'in_progress')
    void c
  }).catch((e) => console.log('[shots] seed skipped:', e.message))

  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[title*="Code view"], [title*="Code-Ansicht"]', { timeout: 30_000 })
  await win.waitForTimeout(1000)

  // Dismiss the one-time SwarmAgent coachmark so it doesn't cover the panes.
  await win.click('.tb-coachmark-dismiss', { timeout: 3000 }).catch(() => {})
  await win.waitForTimeout(300)

  // 2) Default terminal-grid / workspace view.
  await shot(win, 'workspace.png')

  // 3) Code editor with syntax highlighting (expand src/ then open the file).
  try {
    await click(win, '[title*="Code view"], [title*="Code-Ansicht"]')
    await win.waitForTimeout(800)
    // Expand the src/ folder if the file isn't already visible.
    const fileSel = '[title$="geometry.ts"]'
    if (!(await win.$(fileSel))) {
      await win.click('[title$="src"], [title$="src/"]', { timeout: 5000 }).catch(() => {})
      await win.waitForTimeout(600)
    }
    await win.waitForSelector(fileSel, { timeout: 15_000 })
    await click(win, fileSel)
    await win.waitForSelector('.cm-content', { timeout: 15_000 })
    await win.waitForTimeout(2000)
    await shot(win, 'editor.png')
  } catch (e) { console.log('[shots] editor skipped:', e.message) }

  // 4) SwarmAgent assistant chat — override the key check + seed a sample
  // conversation so the styled transcript (not the empty/no-key state) renders.
  try {
    await win.evaluate(() => {
      window.swarmmind.swarmAgentHasKey = async () => true
      const history = [
        { role: 'user', content: 'Set up two agents and have them build a login screen.' },
        { role: 'assistant', content: "Done — I split the workspace into two panes:\n\n- **Claude Code** → *Design auth flow*\n- **Codex** → *Build API client*\n\nI dropped both tasks on the board and dispatched them. I'll report back when the first one needs review." },
        { role: 'user', content: 'What changed so far?' },
        { role: 'assistant', content: "Codex finished the typed REST client:\n\n```ts src/api/client.ts\nexport const api = createClient({ retry: 3, backoff: 'exp' })\n```\n\nThe auth flow is **done** and the login UI is unblocked. Want me to **save a checkpoint** before merging?" },
      ]
      localStorage.setItem('swarmagent:history', JSON.stringify(history))
    })
    await click(win, '[title*="SwarmAgent"], [title*="SwarmAgent-Assistent"]')
    await win.waitForTimeout(1500)
    // window.swarmmind is a frozen contextBridge object, so the hasKey override
    // can't take — just hide the "needs a key" notice for the marketing shot.
    await win.evaluate(() => { document.querySelector('.sa-notice')?.remove() })
    await win.waitForTimeout(200)
    await shot(win, 'swarmagent.png')
    await click(win, '[title*="SwarmAgent"], [title*="SwarmAgent-Assistent"]')
    await win.waitForTimeout(400)
  } catch (e) { console.log('[shots] swarmagent skipped:', e.message) }

  // 5) Composer (AI multi-file edits).
  try {
    await click(win, '[title^="Composer"]')
    await win.waitForTimeout(1200)
    await shot(win, 'composer.png')
    await click(win, '[title^="Composer"]')
    await win.waitForTimeout(400)
  } catch (e) { console.log('[shots] composer skipped:', e.message) }

  // 6) Kanban board.
  try {
    await click(win, '[title*="Kanban"]')
    await win.waitForTimeout(1000)
    await shot(win, 'kanban.png')
    await click(win, '[title*="Kanban"]')
    await win.waitForTimeout(400)
  } catch (e) { console.log('[shots] kanban skipped:', e.message) }

  // 7) Memory graph.
  try {
    await click(win, '[title*="Memory graph"], [title*="Speicher-Graph"]')
    await win.waitForTimeout(1200)
    await shot(win, 'memory-graph.png')
  } catch (e) { console.log('[shots] memory-graph skipped:', e.message) }

  console.log('[shots] DONE')
} catch (err) {
  failure = err instanceof Error ? (err.stack || err.message) : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (failure) { console.error('[shots] FAILED:', failure); process.exit(1) }
