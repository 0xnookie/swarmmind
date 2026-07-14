// End-to-end verification of the TypeScript language service in the REAL app:
// boots Electron against a throwaway profile, opens a temp workspace holding a
// tsconfig + a file with one deliberate type error, opens that file in the
// editor, and asserts the whole chain actually lit up:
//
//   FileEditor debounce → lsp:diagnostics IPC → worker_thread language service
//     → merged lint list → CodeMirror squiggle + gutter marker + status bar
//
// It also drives go-to-definition (F12) across two files. Nothing here is
// mocked; a green run means a user typing a type error sees a red underline.
//
// Run after `npm run build`:  node tests/lsp-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-lspverify-'))
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-lspws-'))

writeFileSync(
  join(wsDir, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' }, include: ['*.ts'] }, null, 2)
)

// The definition target lives in a second file, so F12 has to cross a file
// boundary (the case a single-file service would get wrong).
writeFileSync(join(wsDir, 'lib.ts'), `export function double(n: number): number {\n  return n * 2\n}\n`)

// Exactly one error: `double` wants a number, gets a string. Everything else
// must stay clean, or a false positive would make this test pass for the wrong reason.
writeFileSync(
  join(wsDir, 'main.ts'),
  `import { double } from './lib'

const ok: number = double(21)
const bad: number = double('nope')

console.log(ok, bad)
`
)

const hardTimeout = setTimeout(() => {
  console.error('[lsp-verify] TIMEOUT')
  process.exit(1)
}, 150_000)
hardTimeout.unref()

let failure = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })

  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'lspverify'), wsDir)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  await win.waitForSelector('[title*="Code view"], [title*="Code-Ansicht"]', { timeout: 30_000 })
  await win.click('[title*="Code view"], [title*="Code-Ansicht"]')

  await win.waitForSelector('[title$="main.ts"]', { timeout: 15_000 })
  await win.click('[title$="main.ts"]')
  await win.waitForSelector('.cm-content', { timeout: 15_000 })

  // First-run onboarding coachmark floats over the editor and eats pointer
  // events. Unrelated to what we're testing — drop it so hovers/clicks land.
  await win.evaluate(() => document.querySelectorAll('.tb-coachmark').forEach((e) => e.remove()))

  // ── 1. The squiggle. Cold program build takes a beat; the debounce adds more.
  await win.waitForSelector('.cm-lintRange-error', { timeout: 45_000 })
  const diag = await win.evaluate(() => {
    const marks = Array.from(document.querySelectorAll('.cm-lintRange-error'))
    const gutter = document.querySelectorAll('.cm-lint-marker-error')
    return { marks: marks.length, underlined: marks.map((m) => m.textContent), gutterMarkers: gutter.length }
  })
  console.log('[lsp-verify] diagnostics in the DOM:', JSON.stringify(diag))
  if (diag.marks !== 1) throw new Error(`expected exactly 1 error range, got ${diag.marks}`)
  // The compiler's span should sit on the bad argument, not the whole line.
  if (!diag.underlined[0].includes('nope')) {
    throw new Error(`error underlines the wrong text: ${JSON.stringify(diag.underlined)}`)
  }
  if (diag.gutterMarkers < 1) throw new Error('no lint gutter marker rendered')

  // ── 2. The status bar reports the compiler's count (live, no click).
  const status = await win.evaluate(() => {
    const el = Array.from(document.querySelectorAll('span')).find((s) => /error\(s\)|Fehler/.test(s.textContent || ''))
    return el ? el.textContent.trim() : null
  })
  console.log('[lsp-verify] status bar:', JSON.stringify(status))
  if (!status || !status.includes('1')) throw new Error(`status bar did not report 1 error (got ${status})`)

  // ── 3. Hovering the error must surface the compiler's message, and the lint
  //       tooltip must carry the "Fix with AI" action — the payoff of merging
  //       real diagnostics into the existing AI pipeline.
  await win.hover('.cm-lintRange-error')
  await win.waitForSelector('.cm-tooltip-lint', { timeout: 10_000 })
  const tip = await win.evaluate(() => {
    const t = document.querySelector('.cm-tooltip-lint')
    return t ? t.textContent : null
  })
  console.log('[lsp-verify] lint tooltip:', JSON.stringify(tip))
  if (!tip || !/not assignable/i.test(tip)) throw new Error(`tooltip lacks the TS message: ${tip}`)
  if (!/Fix with AI|Mit KI beheben/.test(tip)) throw new Error('real type error did not get the "Fix with AI" action')

  // The money shot: squiggle + compiler message + Fix-with-AI, all at once.
  await win.screenshot({ path: join(root, 'tests', 'lsp-verify-error.png') })
  console.log('[lsp-verify] screenshot -> tests/lsp-verify-error.png')

  // ── 4. Go-to-definition across files: click the `double` call on the `const ok`
  //       line (a real click, so the cursor lands exactly where a user's would),
  //       then F12. The definition lives in lib.ts, so this only passes if the
  //       service resolved an import — the thing a single-file checker cannot do.
  const callSite = win.locator('.cm-line').filter({ hasText: 'const ok' }).getByText('double', { exact: true })
  await callSite.click()
  await win.keyboard.press('F12')

  await win
    .waitForFunction(
      () => (document.querySelector('.cm-content')?.textContent || '').includes('export function double'),
      null,
      { timeout: 20_000 }
    )
    .catch(() => {})
  const opened = await win.evaluate(() => document.querySelector('.cm-content')?.textContent?.slice(0, 60) ?? null)
  console.log('[lsp-verify] after F12, editor shows:', JSON.stringify(opened))
  if (!opened || !opened.includes('export function double')) {
    throw new Error('F12 did not navigate to the definition in lib.ts')
  }

  await win.screenshot({ path: join(root, 'tests', 'lsp-verify.png') })
  console.log('[lsp-verify] screenshot -> tests/lsp-verify.png')

  // ── 5. Find references (Shift+F12): from the definition in lib.ts, the drawer
  //       must list usages in BOTH files, and clicking a main.ts row navigates.
  const defSite = win.locator('.cm-line').filter({ hasText: 'export function double' }).getByText('double', { exact: true })
  await defSite.click()
  await win.keyboard.press('Shift+F12')
  await win.waitForSelector('text=/References to|Verweise auf/', { timeout: 20_000 })
  // Rows render as buttons "file.ts:line  <line text>"; wait for the cross-file hit.
  const mainRow = win.locator('button').filter({ hasText: /main\.ts:/ }).first()
  await mainRow.waitFor({ timeout: 20_000 }).catch(async (err) => {
    const drawer = await win.evaluate(() => {
      const title = Array.from(document.querySelectorAll('span')).find((s) => /References to|Verweise auf/.test(s.textContent || ''))
      const panel = title?.closest('div')?.parentElement
      return panel ? panel.textContent : '(drawer not found)'
    })
    console.error('[lsp-verify] drawer contents at failure:', JSON.stringify(drawer))
    throw err
  })
  const refRows = await win.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('button')).filter((b) => /\.ts:\d+/.test(b.textContent || ''))
    return rows.map((r) => (r.textContent || '').slice(0, 60))
  })
  console.log('[lsp-verify] reference rows:', JSON.stringify(refRows))
  if (!refRows.some((r) => r.includes('lib.ts:'))) throw new Error('references drawer lacks the lib.ts definition row')
  if (!refRows.some((r) => r.includes('main.ts:'))) throw new Error('references drawer lacks the main.ts usage rows')
  await win.screenshot({ path: join(root, 'tests', 'lsp-verify-refs.png') })
  console.log('[lsp-verify] screenshot -> tests/lsp-verify-refs.png')

  await mainRow.click()
  await win.waitForFunction(
    () => (document.querySelector('.cm-content')?.textContent || '').includes('import { double }'),
    null,
    { timeout: 20_000 }
  )
  console.log('[lsp-verify] clicking a reference row navigated back to main.ts')
  // The cross-file jump remounts the editor (peek-style), dismissing the drawer.

  // ── 6. Compiler-exact rename (F2): renaming `double` at a call site must land
  //       in the Composer with a pre-built two-file plan — no model round-trip.
  const renameSite = win.locator('.cm-line').filter({ hasText: 'const ok' }).getByText('double', { exact: true })
  await renameSite.click()
  await win.keyboard.press('F2')
  await win.waitForSelector('text=/Rename symbol|Symbol umbenennen/', { timeout: 10_000 }).catch(async (err) => {
    const state = await win.evaluate(() => ({
      focused: document.activeElement?.className ?? null,
      selection: window.getSelection()?.toString() ?? null,
      cmFocused: !!document.querySelector('.cm-editor.cm-focused'),
      bodySnippet: (document.body.textContent || '').includes('Rename') ? 'has-rename-text' : 'no-rename-text',
    }))
    console.error('[lsp-verify] F2 state at failure:', JSON.stringify(state))
    await win.screenshot({ path: join(root, 'tests', 'lsp-verify-f2-fail.png') })
    throw err
  })
  await win.keyboard.type('twice')
  await win.keyboard.press('Enter')
  await win.waitForFunction(
    () => /compiler-exact/.test(document.body.textContent || ''),
    null,
    { timeout: 30_000 }
  )
  const composerText = await win.evaluate(() => document.body.textContent || '')
  // The plan summary counts its own files — the tab bar also says "lib.ts", so
  // asserting on the summary (not mere presence of the names) keeps this honest.
  if (!/across 2 files/.test(composerText)) {
    throw new Error('rename did not propagate to both files (expected "across 2 files" in the plan summary)')
  }
  if (!composerText.includes('twice(21)')) {
    throw new Error('Composer diff does not show the renamed call site')
  }
  console.log('[lsp-verify] F2 rename produced a compiler-exact Composer plan across both files')
  await win.screenshot({ path: join(root, 'tests', 'lsp-verify-rename.png') })
  console.log('[lsp-verify] screenshot -> tests/lsp-verify-rename.png')

  console.log('[lsp-verify] PASS — squiggle + Fix-with-AI, F12, Shift+F12 references, F2 exact rename')
} catch (err) {
  failure = err instanceof Error ? err.message : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (failure) {
  console.error('[lsp-verify] FAILED:', failure)
  process.exit(1)
}
