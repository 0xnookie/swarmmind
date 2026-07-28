// Verification for the editor's *view* affordances — the things `tsc` and the
// pure unit tests structurally cannot see, because they only exist once
// CodeMirror has laid out a real document in a real window:
//
//   1. the fold gutter renders our SVG chevron (not CodeMirror's default text
//      glyphs) and actually folds when clicked;
//   2. fold-all / unfold-all from the status bar work;
//   3. the word-wrap toggle really re-wraps and survives a reload (persisted);
//   4. cursor + scroll position are restored when you switch tabs and come back
//      — the whole point of `lib/editorViewState.ts`.
//
// Run after `npm run build`:  node tests/editor-ux-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-uxverify-'))
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-uxws-'))

// Long enough to scroll, with foldable blocks, and one very long line so wrap
// is observable.
const longLine = `export const BANNER = '${'x'.repeat(400)}'`
const body = Array.from({ length: 60 }, (_, i) =>
  `export function fn${i}(a: number): number {\n  const v = a + ${i}\n  return v * 2\n}`
).join('\n')
writeFileSync(join(wsDir, 'big.ts'), `${longLine}\n${body}\n`)
writeFileSync(join(wsDir, 'other.ts'), `export const OTHER = 1\n`)
// A directory, so the explorer has a row that can actually disclose.
mkdirSync(join(wsDir, 'nested'))
writeFileSync(join(wsDir, 'nested', 'inner.ts'), `export const INNER = 1\n`)

const hardTimeout = setTimeout(() => {
  console.error('[ux-verify] TIMEOUT')
  process.exit(1)
}, 180_000)
hardTimeout.unref()

const check = (cond, msg) => { if (!cond) throw new Error(msg) }

let failure = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })

  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'uxverify'), wsDir)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  await win.waitForSelector('[title*="Code view"], [title*="Code-Ansicht"]', { timeout: 30_000 })
  await win.click('[title*="Code view"], [title*="Code-Ansicht"]')

  const openFile = async (name) => {
    await win.waitForSelector(`[title$="${name}"]`, { timeout: 15_000 })
    await win.click(`[title$="${name}"]`)
    await win.waitForSelector('.cm-content', { timeout: 15_000 })
    await win.waitForTimeout(1200)
  }

  // ── 1. The explorer's disclosure chevron ──────────────────────────────────
  // There was none before: a folder announced its state only by swapping its
  // icon. Scoped to explorer rows (`data-row-index`) — a document-wide chevron
  // count would happily pass on the TopBar breadcrumb alone.
  await win.waitForSelector('[data-row-index]', { timeout: 15_000 })
  const readRows = () => win.evaluate(() => {
    const isChevron = (p) => p.getAttribute('points') === '9 18 15 12 9 6'
    return Array.from(document.querySelectorAll('[data-row-index]')).map((row) => {
      const chevron = Array.from(row.querySelectorAll('svg polyline')).find(isChevron)
      const holder = chevron?.closest('span')
      return {
        name: (row.getAttribute('title') || '').split(/[\\/]/).pop(),
        hasChevron: !!chevron,
        // The wrapper carries the rotation; 0° = collapsed, 90° = expanded.
        rotated: holder ? getComputedStyle(holder).transform : null,
      }
    })
  })
  const rowsCollapsed = await readRows()
  console.log('[ux-verify] explorer rows:', JSON.stringify(rowsCollapsed))
  const dirRow = rowsCollapsed.find((r) => r.name === 'nested')
  const fileRow = rowsCollapsed.find((r) => r.name === 'other.ts')
  check(dirRow?.hasChevron === true, 'the folder row has no disclosure chevron')
  check(fileRow?.hasChevron === false, 'a file row drew a disclosure chevron (should be a spacer)')
  check(dirRow.rotated === 'matrix(1, 0, 0, 1, 0, 0)', `collapsed folder chevron is rotated: ${dirRow.rotated}`)

  // Expanding rotates that same chevron rather than swapping in a second glyph.
  await win.click('[title$="nested"]')
  await win.waitForTimeout(500)
  const expandedDir = (await readRows()).find((r) => r.name === 'nested')
  console.log('[ux-verify] folder chevron after expand:', expandedDir.rotated)
  check(
    expandedDir.rotated === 'matrix(0, 1, -1, 0, 0, 0)',
    `expanded folder chevron did not rotate 90° (got ${expandedDir.rotated})`
  )

  await openFile('big.ts')

  // ── 2. Fold gutter draws an SVG marker, not a text glyph ──────────────────
  // NB: CodeMirror puts a zero-height "spacer" marker at the top of every
  // gutter to reserve its width, and the fold gutter builds that spacer from
  // the *closed* state. It is not a real marker — filter it out by height, or
  // the first row you find is an unclickable ghost.
  const foldMarkers = await win.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.cm-foldGutter .cm-fold-marker'))
    const real = all.filter((m) => (m.closest('.cm-gutterElement')?.getBoundingClientRect().height ?? 0) > 0)
    return {
      total: all.length,
      real: real.length,
      svgs: real.filter((m) => m.querySelector('svg')).length,
      // CodeMirror's stock markers are literally these characters.
      textGlyphs: all.filter((m) => /[⌄›]/.test(m.textContent || '')).length,
      closedAtLoad: real.filter((m) => m.dataset.open === 'false').length,
      firstRealIndex: all.indexOf(real[0]),
    }
  })
  console.log('[ux-verify] fold markers:', JSON.stringify(foldMarkers))
  check(foldMarkers.real > 0, 'fold gutter rendered no real markers')
  check(foldMarkers.svgs === foldMarkers.real, 'some fold markers are not SVG')
  check(foldMarkers.textGlyphs === 0, 'default text fold glyphs still present')
  check(foldMarkers.closedAtLoad === 0, 'a region was already folded on load')

  // Clicking one folds its region (a placeholder chip appears in its place).
  const beforeFold = await win.evaluate(() => document.querySelectorAll('.cm-line').length)
  const markerSel = `.cm-foldGutter .cm-fold-marker >> nth=${foldMarkers.firstRealIndex}`
  await win.hover(markerSel) // open markers are revealed on hover, like VS Code
  await win.click(markerSel)
  await win.waitForTimeout(400)
  const afterFold = await win.evaluate(() => ({
    lines: document.querySelectorAll('.cm-line').length,
    placeholders: document.querySelectorAll('.cm-foldPlaceholder').length,
    closedMarkers: document.querySelectorAll('.cm-fold-marker[data-open="false"]').length,
  }))
  console.log('[ux-verify] after clicking a fold marker:', JSON.stringify({ beforeFold, ...afterFold }))
  check(afterFold.placeholders > 0, 'clicking the chevron did not fold (no placeholder)')
  check(afterFold.closedMarkers > 0, 'folded region has no closed-state marker')

  // ── 3. Fold-all / unfold-all from the status bar ──────────────────────────
  const foldAllBtn = '[title*="Fold all"], [title*="einklappen"]'
  const unfoldAllBtn = '[title*="Unfold all"], [title*="ausklappen"]'
  await win.click(foldAllBtn)
  await win.waitForTimeout(400)
  const allFolded = await win.evaluate(() => document.querySelectorAll('.cm-foldPlaceholder').length)
  await win.click(unfoldAllBtn)
  await win.waitForTimeout(400)
  const allUnfolded = await win.evaluate(() => document.querySelectorAll('.cm-foldPlaceholder').length)
  console.log('[ux-verify] fold all ->', allFolded, 'placeholders; unfold all ->', allUnfolded)
  check(allFolded > 1, 'fold-all folded at most one region')
  check(allUnfolded === 0, 'unfold-all left regions folded')

  // ── 4. Word wrap ──────────────────────────────────────────────────────────
  const wrapBtn = '[title*="word wrap"], [title*="Zeilenumbruch"]'
  const measure = () => win.evaluate(() => {
    const sc = document.querySelector('.cm-scroller')
    const first = document.querySelector('.cm-line')
    return {
      overflows: sc.scrollWidth > sc.clientWidth + 4,
      firstLineHeight: first ? Math.round(first.getBoundingClientRect().height) : 0,
      wrapping: getComputedStyle(document.querySelector('.cm-content')).whiteSpace,
    }
  })
  const unwrapped = await measure()
  await win.click(wrapBtn)
  await win.waitForTimeout(500)
  const wrapped = await measure()
  console.log('[ux-verify] wrap off:', JSON.stringify(unwrapped), '-> on:', JSON.stringify(wrapped))
  check(unwrapped.overflows && !wrapped.overflows, 'toggling wrap did not stop horizontal overflow')
  check(
    wrapped.firstLineHeight > unwrapped.firstLineHeight,
    'the long line did not grow taller, so it did not actually wrap'
  )

  // Persisted: it must still be on after a reload.
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[title*="Code view"], [title*="Code-Ansicht"]', { timeout: 30_000 })
  await win.click('[title*="Code view"], [title*="Code-Ansicht"]')
  await openFile('big.ts')
  const afterReload = await measure()
  console.log('[ux-verify] wrap after reload:', JSON.stringify(afterReload))
  check(!afterReload.overflows, 'word wrap did not survive a reload')

  // Turn it back off so the scroll test below measures real vertical scroll.
  await win.click(wrapBtn)
  await win.waitForTimeout(400)

  // ── 5. Cursor + scroll survive a tab round-trip ───────────────────────────
  // Driven through the real UI (click + Ctrl+End) and read back from the status
  // bar, so this asserts what the user actually sees rather than poking at
  // CodeMirror's internals.
  const position = () => win.evaluate(() => {
    const sc = document.querySelector('.cm-scroller')
    const bar = Array.from(document.querySelectorAll('span'))
      .map((s) => s.textContent || '')
      .find((txt) => /^(Ln|Z) \d+, (Col|Sp) \d+/.test(txt))
    return { lnCol: bar ?? null, scrollTop: Math.round(sc.scrollTop) }
  })

  await win.click('.cm-content')
  await win.keyboard.press('Control+End')
  await win.waitForTimeout(600)
  const before = await position()
  check(before.lnCol !== null, 'could not read the Ln/Col status bar')
  check(before.scrollTop > 200, `test setup: editor did not scroll (got ${before.scrollTop})`)

  await openFile('other.ts')
  await openFile('big.ts')
  await win.waitForTimeout(900)
  const after = await position()
  console.log('[ux-verify] position before:', JSON.stringify(before), 'after round-trip:', JSON.stringify(after))
  check(after.lnCol === before.lnCol, `cursor not restored (${before.lnCol} -> ${after.lnCol})`)
  check(
    Math.abs(after.scrollTop - before.scrollTop) < 80,
    `scroll not restored (${before.scrollTop} -> ${after.scrollTop})`
  )

  await win.screenshot({ path: join(root, 'tests', 'editor-ux-verify.png') })
  console.log('[ux-verify] screenshot -> tests/editor-ux-verify.png')
  console.log('[ux-verify] PASS — chevron fold gutter, fold all/unfold all, word wrap, position memory')
} catch (err) {
  failure = err instanceof Error ? err.message : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (failure) {
  console.error('[ux-verify] FAILED:', failure)
  process.exit(1)
}
