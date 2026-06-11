// Manual verification: boots the app against a throwaway profile, opens a temp
// workspace with a TypeScript file, switches to Code view, opens the file and
// reports whether syntax-highlight token classes/colors are present.
// Run after `npm run build`:  node tests/editor-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-edverify-'))

// Temp workspace with a representative TS file.
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-edws-'))
writeFileSync(
  join(wsDir, 'test.ts'),
  `// a comment line
import { join } from 'node:path'

export interface Point { x: number; y: number }

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

const GREETING = "hello world"
console.log(GREETING, distance({ x: 0, y: 0 }, { x: 3, y: 4 }))
`
)

const hardTimeout = setTimeout(() => {
  console.error('[verify] TIMEOUT')
  process.exit(1)
}, 120_000)
hardTimeout.unref()

let failure = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  let win = await app.firstWindow({ timeout: 30_000 })
  win.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[renderer ${msg.type()}]`, msg.text())
  })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })

  // Register the temp workspace via IPC (records it as last-opened), then
  // reload so App.tsx's auto-open-last picks it up with full store wiring.
  const wsPath = wsDir.replace(/\\/g, '\\\\')
  const res = await win.evaluate(
    (p) => window.swarmmind.workspaceOpenByPath(p, 'edverify'),
    wsDir
  )
  console.log('[verify] workspaceOpenByPath ->', JSON.stringify(res))
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  // Wait for the TopBar (workspace UI) and switch to Code view.
  await win.waitForSelector('[title*="Code view"], [title*="Code-Ansicht"]', { timeout: 30_000 })
  await win.click('[title*="Code view"], [title*="Code-Ansicht"]')

  // Open test.ts from the explorer (rows carry title=full path).
  await win.waitForSelector('[title$="test.ts"]', { timeout: 15_000 })
  await win.click('[title$="test.ts"]')

  // Editor should mount; give the lazy language import a moment.
  await win.waitForSelector('.cm-content', { timeout: 15_000 })
  await win.waitForTimeout(2500)

  const report = await win.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.cm-line'))
    const spans = Array.from(document.querySelectorAll('.cm-line span'))
    const classed = spans.filter((s) => s.className && s.className.trim().length > 0)
    const colorSet = new Set()
    for (const s of classed) colorSet.add(getComputedStyle(s).color)
    const gutter = document.querySelector('.cm-gutters')
    return {
      lines: lines.length,
      spans: spans.length,
      classedSpans: classed.length,
      sampleClasses: classed.slice(0, 8).map((s) => `${s.className} :: "${s.textContent}" :: ${getComputedStyle(s).color}`),
      distinctColors: Array.from(colorSet),
      gutterBg: gutter ? getComputedStyle(gutter).backgroundColor : 'NO GUTTER',
      editorFont: getComputedStyle(document.querySelector('.cm-scroller')).fontFamily,
      fontSize: getComputedStyle(document.querySelector('.cm-editor')).fontSize,
    }
  })
  console.log('[verify] report:', JSON.stringify(report, null, 2))

  // Font-size plumbing: bump the CSS var and confirm the editor follows.
  const zoomed = await win.evaluate(() => {
    document.documentElement.style.setProperty('--editor-font-size', '18px')
    return getComputedStyle(document.querySelector('.cm-editor')).fontSize
  })
  console.log('[verify] font-size after --editor-font-size=18px ->', zoomed)
  if (zoomed !== '18px') throw new Error(`editor font-size did not follow CSS var (got ${zoomed})`)

  await win.screenshot({ path: join(root, 'tests', 'editor-verify.png') })
  console.log('[verify] screenshot -> tests/editor-verify.png')

  if (report.classedSpans === 0 || report.distinctColors.length < 3) {
    throw new Error('No/too-little syntax highlighting detected')
  }
  console.log('[verify] PASS — highlighting present')
} catch (err) {
  failure = err instanceof Error ? err.message : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (failure) {
  console.error('[verify] FAILED:', failure)
  process.exit(1)
}
