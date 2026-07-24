// Verification for the file explorer's IDE file operations: create, rename,
// move, copy, duplicate, permissions, trash — plus the containment guards that
// keep all of them inside the open workspace.
//
// Two layers are checked, because they fail differently:
//   1. the main-process handlers, driven over the real IPC bridge and asserted
//      against actual disk state (this is where a bad guard would be a security
//      bug, not just a UI bug);
//   2. the explorer UI itself, driven with real clicks/keys — the inline
//      "new file" row, F2 rename, Ctrl+D duplicate, Ctrl+X/Ctrl+V move — with
//      the assertion that an open editor tab follows the file it points at.
//
// Run after `npm run build`:  node tests/fileops-verify.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = join(root, 'out', 'main', 'index.js')
const userDataDir = mkdtempSync(join(tmpdir(), 'swarmmind-fsverify-'))

// Temp workspace: a couple of files and a folder to move things into.
const wsDir = mkdtempSync(join(tmpdir(), 'swarmmind-fsws-'))
writeFileSync(join(wsDir, 'alpha.ts'), 'export const alpha = 1\n')
writeFileSync(join(wsDir, 'beta.ts'), 'export const beta = 2\n')
mkdirSync(join(wsDir, 'nested'))
writeFileSync(join(wsDir, 'nested', 'inner.ts'), 'export const inner = 3\n')
// A sibling directory outside the workspace — the containment guards must
// refuse to reach it.
const outsideDir = mkdtempSync(join(tmpdir(), 'swarmmind-outside-'))
writeFileSync(join(outsideDir, 'secret.txt'), 'do not touch\n')

const hardTimeout = setTimeout(() => {
  console.error('[fsverify] TIMEOUT')
  process.exit(1)
}, 150_000)
hardTimeout.unref()

const results = []
let failures = 0
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

let fatal = null
const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
try {
  const win = await app.firstWindow({ timeout: 30_000 })
  win.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  win.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[renderer error]', msg.text())
  })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('#root *', { state: 'attached', timeout: 30_000 })

  // Register the temp workspace, then reload so the store wires up fully.
  await win.evaluate((p) => window.swarmmind.workspaceOpenByPath(p, 'fsverify'), wsDir)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[title*="Code view"], [title*="Code-Ansicht"]', { timeout: 30_000 })

  // ── Layer 1: the IPC handlers against real disk state ─────────────────────

  const ipc = (fn, ...args) => win.evaluate(([f, a]) => window.swarmmind[f](...a), [fn, args])

  // create
  let r = await ipc('fsCreate', wsDir, 'made.ts', 'file')
  check('fsCreate makes a file', r.ok && existsSync(join(wsDir, 'made.ts')), JSON.stringify(r))
  r = await ipc('fsCreate', wsDir, 'madeDir', 'dir')
  check('fsCreate makes a folder', r.ok && existsSync(join(wsDir, 'madeDir')), JSON.stringify(r))
  r = await ipc('fsCreate', wsDir, 'made.ts', 'file')
  check('fsCreate refuses to clobber', !r.ok, r.ok ? 'overwrote!' : r.error)
  r = await ipc('fsCreate', wsDir, '../escaped.ts', 'file')
  check('fsCreate rejects a traversing name', !r.ok && !existsSync(join(wsDir, '..', 'escaped.ts')), JSON.stringify(r))

  // copy + duplicate naming
  r = await ipc('fsDuplicate', join(wsDir, 'alpha.ts'))
  check('fsDuplicate → "alpha copy.ts"', r.ok && existsSync(join(wsDir, 'alpha copy.ts')), JSON.stringify(r))
  r = await ipc('fsDuplicate', join(wsDir, 'alpha.ts'))
  check('second duplicate → "alpha copy 2.ts"', r.ok && existsSync(join(wsDir, 'alpha copy 2.ts')), JSON.stringify(r))
  r = await ipc('fsCopy', join(wsDir, 'beta.ts'), join(wsDir, 'nested'))
  check('fsCopy into a folder', r.ok && existsSync(join(wsDir, 'nested', 'beta.ts')) && existsSync(join(wsDir, 'beta.ts')), JSON.stringify(r))
  r = await ipc('fsCopy', join(wsDir, 'beta.ts'), join(wsDir, 'nested'))
  check('a colliding copy never overwrites', r.ok && existsSync(join(wsDir, 'nested', 'beta copy.ts')), JSON.stringify(r))

  // recursive folder copy
  r = await ipc('fsCopy', join(wsDir, 'nested'), join(wsDir, 'madeDir'))
  check('fsCopy is recursive for folders', r.ok && existsSync(join(wsDir, 'madeDir', 'nested', 'inner.ts')), JSON.stringify(r))

  // move
  r = await ipc('fsMove', join(wsDir, 'made.ts'), join(wsDir, 'nested'))
  check('fsMove relocates', r.ok && existsSync(join(wsDir, 'nested', 'made.ts')) && !existsSync(join(wsDir, 'made.ts')), JSON.stringify(r))
  r = await ipc('fsMove', join(wsDir, 'nested'), join(wsDir, 'nested'))
  check('fsMove refuses a folder into itself', !r.ok, r.ok ? 'allowed!' : r.error)
  // madeDir/nested exists (the recursive copy above put it there), so this
  // exercises the subtree guard itself rather than a missing destination.
  r = await ipc('fsMove', join(wsDir, 'madeDir'), join(wsDir, 'madeDir', 'nested'))
  check(
    'fsMove refuses a folder into its own subtree',
    !r.ok && /inside itself/i.test(r.error ?? '') && existsSync(join(wsDir, 'madeDir', 'nested', 'inner.ts')),
    r.ok ? 'allowed!' : r.error
  )

  // containment: nothing may reach outside the workspace
  r = await ipc('fsMove', join(outsideDir, 'secret.txt'), wsDir)
  check('fsMove refuses an outside source', !r.ok && existsSync(join(outsideDir, 'secret.txt')), JSON.stringify(r))
  r = await ipc('fsMove', join(wsDir, 'alpha.ts'), outsideDir)
  check('fsMove refuses an outside destination', !r.ok && existsSync(join(wsDir, 'alpha.ts')), JSON.stringify(r))
  r = await ipc('fsCreate', outsideDir, 'planted.ts', 'file')
  check('fsCreate refuses an outside folder', !r.ok && !existsSync(join(outsideDir, 'planted.ts')), JSON.stringify(r))
  r = await ipc('fsTrash', join(outsideDir, 'secret.txt'))
  check('fsTrash refuses an outside path', !r.ok && existsSync(join(outsideDir, 'secret.txt')), JSON.stringify(r))
  r = await ipc('fsRename', join(wsDir, '.swarmmind'), 'pwned')
  check('.swarmmind stays off limits', !r.ok, r.ok ? 'renamed!' : r.error)

  // permissions
  const st = await ipc('fsStat', join(wsDir, 'alpha.ts'))
  check('fsStat reports mode + octal', !!st && typeof st.mode === 'number' && /^[0-7]{3}$/.test(st.octal), JSON.stringify(st))
  const roMode = st.mode & 0o777 & ~0o222
  r = await ipc('fsChmod', join(wsDir, 'alpha.ts'), roMode)
  const afterRo = await ipc('fsStat', join(wsDir, 'alpha.ts'))
  check('fsChmod makes a file read-only', r.ok && afterRo.readonly === true, `${JSON.stringify(r)} ${JSON.stringify(afterRo)}`)
  r = await ipc('fsChmod', join(wsDir, 'alpha.ts'), (st.mode & 0o777) | 0o200)
  const afterRw = await ipc('fsStat', join(wsDir, 'alpha.ts'))
  check('fsChmod restores write', r.ok && afterRw.readonly === false, `${JSON.stringify(r)} ${JSON.stringify(afterRw)}`)
  r = await ipc('fsChmod', join(wsDir, 'alpha.ts'), 0o7777)
  check('fsChmod rejects an out-of-range mode', !r.ok, JSON.stringify(r))

  // trash
  r = await ipc('fsTrash', join(wsDir, 'alpha copy 2.ts'))
  check('fsTrash removes the file', r.ok && !existsSync(join(wsDir, 'alpha copy 2.ts')), JSON.stringify(r))

  // ── Layer 2: the explorer UI ──────────────────────────────────────────────

  await win.click('[title*="Code view"], [title*="Code-Ansicht"]')
  await win.waitForSelector('[title$="alpha.ts"]', { timeout: 15_000 })

  // New file via the header toolbar → inline row → name → Enter.
  await win.click('[aria-label="New file"], [aria-label="Neue Datei"]')
  await win.waitForSelector('.file-tree-input, input', { timeout: 5_000 })
  await win.keyboard.type('from-ui.ts')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(900)
  check('UI: New file creates and opens it', existsSync(join(wsDir, 'from-ui.ts')))

  // New folder the same way.
  await win.click('[aria-label="New folder"], [aria-label="Neuer Ordner"]')
  await win.waitForTimeout(300)
  await win.keyboard.type('ui-folder')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(900)
  check('UI: New folder creates it', existsSync(join(wsDir, 'ui-folder')))

  // Select the new file in the tree, then F2-rename it.
  await win.click('[title$="from-ui.ts"]')
  await win.waitForTimeout(400)
  await win.keyboard.press('F2')
  await win.waitForTimeout(300)
  await win.keyboard.press('Control+a')
  await win.keyboard.type('renamed-ui.ts')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(900)
  check(
    'UI: F2 renames on disk',
    existsSync(join(wsDir, 'renamed-ui.ts')) && !existsSync(join(wsDir, 'from-ui.ts'))
  )
  // The tab that was open on the old path must have followed the rename.
  let tabs = await win.evaluate(() =>
    Array.from(document.querySelectorAll('.editor-tabbar > div')).map((d) => d.getAttribute('title'))
  )
  check(
    'UI: the open editor tab followed the rename',
    tabs.some((p) => p && p.endsWith('renamed-ui.ts')) && !tabs.some((p) => p && p.endsWith('from-ui.ts')),
    JSON.stringify(tabs)
  )

  // Ctrl+D duplicates the selected row.
  await win.click('[title$="renamed-ui.ts"]')
  await win.waitForTimeout(300)
  await win.keyboard.press('Control+d')
  await win.waitForTimeout(1000)
  check('UI: Ctrl+D duplicates', existsSync(join(wsDir, 'renamed-ui copy.ts')), readdirSync(wsDir).join(', '))

  // Ctrl+X on the file, click the target folder, Ctrl+V → a real move, and the
  // open tab must follow it into the folder.
  await win.click('[title$="renamed-ui.ts"]')
  await win.waitForTimeout(300)
  await win.keyboard.press('Control+x')
  await win.waitForTimeout(200)
  await win.click('[title$="ui-folder"]')
  await win.waitForTimeout(400)
  await win.keyboard.press('Control+v')
  await win.waitForTimeout(1400)
  check(
    'UI: Ctrl+X / Ctrl+V moves into the folder',
    existsSync(join(wsDir, 'ui-folder', 'renamed-ui.ts')) && !existsSync(join(wsDir, 'renamed-ui.ts')),
    readdirSync(wsDir).join(', ')
  )
  tabs = await win.evaluate(() =>
    Array.from(document.querySelectorAll('.editor-tabbar > div')).map((d) => d.getAttribute('title'))
  )
  check(
    'UI: the open editor tab followed the move',
    tabs.some((p) => p && p.replace(/\\/g, '/').endsWith('ui-folder/renamed-ui.ts')),
    JSON.stringify(tabs)
  )

  // Undo (Ctrl+Z) the move → the file returns to the workspace root.
  await win.locator('[data-row-index="0"]').first().click()
  await win.keyboard.press('Control+z')
  await win.waitForTimeout(1400)
  check(
    'UI: Ctrl+Z undoes the move (file back at root)',
    existsSync(join(wsDir, 'renamed-ui.ts')) && !existsSync(join(wsDir, 'ui-folder', 'renamed-ui.ts')),
    readdirSync(wsDir).join(', ')
  )
  // Undo again → the duplicate is trashed.
  await win.keyboard.press('Control+z')
  await win.waitForTimeout(1400)
  check(
    'UI: Ctrl+Z undoes the duplicate (copy trashed)',
    !existsSync(join(wsDir, 'renamed-ui copy.ts')),
    readdirSync(wsDir).join(', ')
  )

  await win.screenshot({ path: join(root, 'tests', 'fileops-verify.png') })
} catch (err) {
  fatal = err instanceof Error ? (err.stack ?? err.message) : String(err)
} finally {
  await app.close().catch(() => {})
  clearTimeout(hardTimeout)
}

if (fatal) {
  console.error('\n[fsverify] FATAL:', fatal)
  process.exit(1)
}
console.log(`\n[fsverify] ${results.length - failures}/${results.length} checks passed`)
process.exit(failures ? 1 : 0)
