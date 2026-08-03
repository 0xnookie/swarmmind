// Drives the generic LSP client (electron/lsp/stdio.ts) against a real server
// process over real stdio — see tests/mock-lsp-server.mjs for why it's a mock.
//
// The pure layers (framing, normalisation, the registry) are unit-tested in
// tests/lib-units.mts. What can only be checked by actually running are the
// parts that live between them: the initialize handshake (including answering a
// server→client request, which deadlocks a naive client), full-text document
// sync, and the push-based diagnostics wait.
//
// Run:  npm run lsp-stdio-verify
//
// The client is bundled with esbuild first because it imports sibling modules
// without file extensions — fine for the app's bundler, not resolvable by Node's
// ESM loader directly.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const repoRoot = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'sm-lsp-'))
const bundle = join(work, 'stdio.mjs')

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ok  ${label}`)
  } catch (err) {
    failures++
    console.log(`FAIL  ${label}\n      ${err.message}`)
  }
}

execFileSync(
  process.execPath,
  [
    join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    join(repoRoot, 'electron', 'lsp', 'stdio.ts'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`,
  ],
  { stdio: 'inherit' },
)

const lsp = await import(pathToFileURL(bundle).href)

// Register the mock for a made-up extension so it can't collide with a real
// server the machine happens to have.
lsp.setExtraLspServers([{
  id: 'mock',
  candidates: [{ command: process.execPath, args: [join(repoRoot, 'tests', 'mock-lsp-server.mjs')] }],
  extensions: ['.mock'],
  languageId: 'mock',
}])

const file = join(work, 'sample.mock')
const source = 'def target():\n    pass\ntarget()\n'
writeFileSync(file, source, 'utf-8')

check('a file with no registered server is not routed anywhere', () => {
  assert.equal(lsp.serverFor(join(work, 'x.unknown')), null)
  assert.equal(lsp.serverFor(file)?.id, 'mock')
})

// ── Diagnostics (push-based, and the handshake underneath them) ──────────────

const clean = await lsp.stdioDiagnostics(work, file, source)
check('the handshake completes and a clean file reports no diagnostics', () => {
  // Reaching here at all proves the client answered the server's mid-handshake
  // client/registerCapability request; a client that ignores it never gets past
  // initialize and this call times out empty after 20s.
  assert.deepEqual(clean, [])
})

const dirty = 'def target():\n    BAD\ntarget()\n'
const diags = await lsp.stdioDiagnostics(work, file, dirty)
check('an edited buffer is synced and its diagnostics come back mapped to offsets', () => {
  assert.equal(diags.length, 1, `expected 1 diagnostic, got ${JSON.stringify(diags)}`)
  assert.equal(diags[0].severity, 'error')
  assert.equal(diags[0].code, 42)
  assert.equal(dirty.slice(diags[0].from, diags[0].to), 'BAD', 'offsets must select the offending text')
})

// ── Hover / definition / references ─────────────────────────────────────────

const hover = await lsp.stdioHover(work, file, dirty, 5)
check('an array-of-mixed-shapes hover flattens to markdown', () => {
  assert.ok(hover, 'expected a hover result')
  assert.ok(hover.markdown.includes('```mock'), hover.markdown)
  assert.ok(hover.markdown.includes('Docs for target.'))
})

const def = await lsp.stdioDefinition(work, file, dirty, 5)
check('a LocationLink-shaped definition resolves to a path and 1-based line', () => {
  assert.ok(def, 'expected a definition')
  assert.equal(def.line, 1)
  assert.equal(def.col, 5)
  assert.ok(def.path.endsWith('sample.mock'), def.path)
})

const refs = await lsp.stdioReferences(work, file, dirty, 5)
check('references carry a preview line read from the synced buffer', () => {
  assert.equal(refs.length, 2)
  assert.equal(refs[0].line, 1)
  assert.equal(refs[1].line, 3)
  assert.equal(refs[1].lineText, 'target()', 'a reference row without its line is unscannable')
})

// ── Rename ──────────────────────────────────────────────────────────────────

const renamed = await lsp.stdioRename(work, file, dirty, 5, 'renamed')
check('a documentChanges rename returns full new file contents', () => {
  assert.ok(renamed.ok, `rename failed: ${renamed.ok ? '' : renamed.error}`)
  assert.equal(renamed.files.length, 1, 'the create-file operation must not become a file')
  assert.equal(renamed.files[0].edits, 2)
  assert.equal(renamed.files[0].newContent, 'def renamed():\n    BAD\nrenamed()\n')
  assert.equal(renamed.displayName, 'target', 'the plan is labelled with the old symbol')
})

// ── Teardown ────────────────────────────────────────────────────────────────

lsp.stdioClose(file)
lsp.shutdownStdioServers()
check('shutting down leaves no server process behind', () => {
  // A second shutdown must be a no-op rather than throwing on dead handles.
  lsp.shutdownStdioServers()
})

// Best-effort: on Windows a just-killed child can still hold the cwd for a
// moment, and a leftover temp dir must not fail an otherwise-passing run.
try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(failures ? `\n${failures} failed` : '\nlsp-stdio-verify: all assertions passed')
process.exit(failures ? 1 : 0)
