// Generic LSP client: talks to whatever real language server the user has
// installed, over stdio.
//
// WHY THIS EXISTS: the in-process TypeScript service (worker.ts) covers TS/JS
// beautifully and covers nothing else. The obvious next step — "write a service
// per language" — doesn't scale past the first one. Real language servers
// already exist for every language worth supporting and they all speak the same
// protocol, so the scalable move is to speak it: Python, Rust, Go and C/C++
// become a registry entry each (electron/lib/lspServers.ts) instead of a
// vendored engine each.
//
// WHAT IT DELIBERATELY DOESN'T DO: install or bundle anything. A server is used
// if it's on PATH and ignored if it isn't, and a machine without `gopls`
// degrades to "no results" exactly like a repo with no TypeScript does today.
// Everything here fails soft for the same reason the TS client does — the
// editor's own features (AI diagnostics, ghost text, inline edit) must keep
// working when the language server doesn't.
//
// Document sync is full-text on every request, matching the rest of the app's
// LSP surface: each query ships the editor's live buffer, so a crashed and
// respawned server costs the in-flight call and nothing else.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { decodeMessages, encodeMessage, pathToUri, uriToPath } from '../lib/lspFraming'
import {
  applyRangeEdits, normalizeDiagnostics, normalizeHoverContents, normalizeLocations,
  normalizeWorkspaceEdit, offsetToPosition, positionToOffset, rangeToOffsets,
} from '../lib/lspNormalize'
import { quoteForCmd, resolveServers, serverForPath, type LspServerDef } from '../lib/lspServers'
import type { LspDefinition, LspDiagnostic, LspHover, LspReference, LspRenameResult } from './protocol'

const REQUEST_TIMEOUT_MS = 20_000
// How long a diagnostics call waits for the server to push a fresh batch before
// answering with whatever it last published. Servers publish asynchronously and
// some (rust-analyzer) index for a long time first; blocking the editor on that
// would be worse than a stale-but-instant answer, and the editor re-runs
// diagnostics on every pause anyway.
const DIAGNOSTICS_WAIT_MS = 1500
const MAX_REFERENCES = 300

interface Pending {
  resolve: (value: unknown) => void
  timer: NodeJS.Timeout
}

interface Conn {
  def: LspServerDef
  proc: ChildProcessWithoutNullStreams
  buffer: Buffer
  nextId: number
  pending: Map<number, Pending>
  ready: Promise<boolean>
  /** uri → last diagnostics payload the server pushed. */
  diagnostics: Map<string, unknown>
  /** uri → callbacks waiting for the *next* push. */
  waiters: Map<string, (() => void)[]>
  /** uri → document version, incremented per didChange. */
  versions: Map<string, number>
  /** uri → text as last synced, for offset↔position maths on other files. */
  texts: Map<string, string>
  dead: boolean
}

const conns = new Map<string, Conn>()
// Servers whose binaries aren't installed. Probed once — retrying a spawn on
// every keystroke would fork a process per character typed.
const unavailable = new Set<string>()

let extraServers: LspServerDef[] = []

/** Called at startup with the `lspServers` app setting (see ipc/lsp.ts). */
export function setExtraLspServers(defs: LspServerDef[]): void {
  extraServers = defs
}

export function serverFor(path: string): LspServerDef | null {
  return serverForPath(path, resolveServers(extraServers))
}

// ── Connection lifecycle ─────────────────────────────────────────────────────

function connKey(def: LspServerDef, root: string): string {
  return `${def.id}::${root}`
}

function spawnCandidate(def: LspServerDef, root: string): ChildProcessWithoutNullStreams | null {
  const win = process.platform === 'win32'
  for (const candidate of def.candidates) {
    try {
      // `shell: true` on Windows so a server installed as a .cmd shim
      // (pyright-langserver and every other npm-distributed one) can be launched
      // at all — Node refuses to exec .cmd directly. The cost is that Node then
      // joins command and args into one command line, so each token has to be
      // quoted or a path under "C:\Program Files" splits at the space and looks
      // indistinguishable from "not installed". Tokens come from our own
      // registry or the user's settings, never from repo content.
      const proc = win
        ? spawn(quoteForCmd(candidate.command), candidate.args.map(quoteForCmd), {
            cwd: root, windowsHide: true, shell: true,
          })
        : spawn(candidate.command, candidate.args, { cwd: root, windowsHide: true })
      // A missing binary surfaces asynchronously as an 'error' event, not a
      // throw, so mark the connection dead there rather than trusting the spawn
      // to have succeeded.
      return proc
    } catch {
      continue
    }
  }
  return null
}

function ensureConn(def: LspServerDef, root: string): Conn | null {
  const key = connKey(def, root)
  if (unavailable.has(key)) return null
  const existing = conns.get(key)
  if (existing && !existing.dead) return existing

  const proc = spawnCandidate(def, root)
  if (!proc) {
    unavailable.add(key)
    return null
  }

  const conn: Conn = {
    def, proc,
    buffer: Buffer.alloc(0),
    nextId: 1,
    pending: new Map(),
    ready: Promise.resolve(false),
    diagnostics: new Map(),
    waiters: new Map(),
    versions: new Map(),
    texts: new Map(),
    dead: false,
  }

  proc.stdout.on('data', (chunk: Buffer) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk])
    const { messages, rest } = decodeMessages(conn.buffer)
    conn.buffer = rest
    for (const msg of messages) handleMessage(conn, msg)
  })
  // Servers are chatty on stderr (progress, indexing); it is not an error
  // channel and must not be treated as one.
  proc.stderr.on('data', () => {})
  proc.on('error', () => teardown(key, conn, true))
  proc.on('exit', () => teardown(key, conn, false))

  conns.set(key, conn)
  conn.ready = initialize(conn, root)
  return conn
}

function teardown(key: string, conn: Conn, spawnFailed: boolean): void {
  if (conn.dead) return
  conn.dead = true
  for (const [, p] of conn.pending) {
    clearTimeout(p.timer)
    p.resolve(null)
  }
  conn.pending.clear()
  // Release anyone blocked waiting for diagnostics that will never arrive.
  for (const [, list] of conn.waiters) list.forEach(fn => fn())
  conn.waiters.clear()
  conns.delete(key)
  // A server that never started is missing, not crashed: stop trying. A server
  // that started and later died gets another chance on the next request.
  if (spawnFailed) unavailable.add(key)
}

function send(conn: Conn, payload: unknown): void {
  if (conn.dead || !conn.proc.stdin.writable) return
  try {
    conn.proc.stdin.write(encodeMessage(payload))
  } catch {
    /* the exit handler will tear the connection down */
  }
}

function request(conn: Conn, method: string, params: unknown): Promise<unknown> {
  if (conn.dead) return Promise.resolve(null)
  const id = conn.nextId++
  return new Promise<unknown>(resolve => {
    const timer = setTimeout(() => {
      conn.pending.delete(id)
      resolve(null)
    }, REQUEST_TIMEOUT_MS)
    conn.pending.set(id, { resolve, timer })
    send(conn, { jsonrpc: '2.0', id, method, params })
  })
}

function notify(conn: Conn, method: string, params: unknown): void {
  send(conn, { jsonrpc: '2.0', method, params })
}

function handleMessage(conn: Conn, msg: unknown): void {
  if (!msg || typeof msg !== 'object') return
  const m = msg as Record<string, unknown>

  // Response to something we asked.
  if (typeof m.id === 'number' && (m.result !== undefined || m.error !== undefined)) {
    const p = conn.pending.get(m.id)
    if (p) {
      clearTimeout(p.timer)
      conn.pending.delete(m.id)
      p.resolve(m.error !== undefined ? null : m.result)
    }
    return
  }

  // A *request* from the server (registerCapability, workDoneProgress/create,
  // configuration…). Answering with null is fine for all of them, but not
  // answering is not: several servers block their init sequence on the reply
  // and then look like they hung.
  if (m.id !== undefined && typeof m.method === 'string') {
    send(conn, { jsonrpc: '2.0', id: m.id, result: null })
    return
  }

  if (m.method === 'textDocument/publishDiagnostics') {
    const params = m.params as { uri?: string; diagnostics?: unknown } | undefined
    if (params?.uri) {
      conn.diagnostics.set(params.uri, params.diagnostics ?? [])
      const waiting = conn.waiters.get(params.uri)
      if (waiting) {
        conn.waiters.delete(params.uri)
        waiting.forEach(fn => fn())
      }
    }
  }
}

async function initialize(conn: Conn, root: string): Promise<boolean> {
  const res = await request(conn, 'initialize', {
    processId: process.pid,
    rootUri: pathToUri(root),
    rootPath: root,
    workspaceFolders: [{ uri: pathToUri(root), name: 'workspace' }],
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false },
        publishDiagnostics: { relatedInformation: false },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: { linkSupport: true },
        references: {},
        rename: { prepareSupport: false },
      },
      workspace: { workspaceFolders: true, configuration: false },
    },
    initializationOptions: {},
  })
  if (res === null || conn.dead) return false
  notify(conn, 'initialized', {})
  return true
}

// ── Document sync ────────────────────────────────────────────────────────────

interface SyncResult {
  uri: string
  /** True when this call actually sent didOpen/didChange (so a fresh
   *  publishDiagnostics is on its way and worth waiting for). */
  changed: boolean
}

async function syncDoc(conn: Conn, path: string, content: string): Promise<SyncResult | null> {
  if (!(await conn.ready) || conn.dead) return null
  const uri = pathToUri(path)
  const version = conn.versions.get(uri)

  if (version === undefined) {
    conn.versions.set(uri, 1)
    conn.texts.set(uri, content)
    notify(conn, 'textDocument/didOpen', {
      textDocument: { uri, languageId: conn.def.languageId, version: 1, text: content },
    })
    return { uri, changed: true }
  }
  if (conn.texts.get(uri) !== content) {
    const next = version + 1
    conn.versions.set(uri, next)
    conn.texts.set(uri, content)
    notify(conn, 'textDocument/didChange', {
      textDocument: { uri, version: next },
      contentChanges: [{ text: content }], // full sync
    })
    return { uri, changed: true }
  }
  return { uri, changed: false }
}

/** Text of some other file the server referred to (a definition/reference target). */
function textForUri(conn: Conn, uri: string): string | null {
  const cached = conn.texts.get(uri)
  if (cached !== undefined) return cached
  const path = uriToPath(uri)
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null
  } catch {
    return null
  }
}

// ── Public API (mirrors electron/lsp/client.ts) ──────────────────────────────

async function withConn<T>(
  root: string,
  path: string,
  content: string,
  fallback: T,
  fn: (conn: Conn, sync: SyncResult) => Promise<T>,
): Promise<T> {
  const def = serverFor(path)
  if (!def) return fallback
  const conn = ensureConn(def, root)
  if (!conn) return fallback
  try {
    const sync = await syncDoc(conn, path, content)
    if (!sync) return fallback
    return await fn(conn, sync)
  } catch {
    return fallback
  }
}

export function stdioDiagnostics(root: string, path: string, content: string): Promise<LspDiagnostic[]> {
  return withConn(root, path, content, [] as LspDiagnostic[], async (conn, { uri, changed }) => {
    // Diagnostics are pushed, not requested, so wait briefly for the batch that
    // follows the sync we just sent — then answer with whatever is cached.
    // Nothing was sent and an answer is already cached: there is no new batch
    // coming, so waiting would just add the full timeout to every request for an
    // unedited file.
    const needWait = changed || !conn.diagnostics.has(uri)
    if (needWait) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, DIAGNOSTICS_WAIT_MS)
        const list = conn.waiters.get(uri) ?? []
        list.push(() => { clearTimeout(timer); resolve() })
        conn.waiters.set(uri, list)
      })
    }
    return normalizeDiagnostics(conn.diagnostics.get(uri), content) as LspDiagnostic[]
  })
}

export function stdioHover(root: string, path: string, content: string, offset: number): Promise<LspHover | null> {
  return withConn(root, path, content, null as LspHover | null, async (conn, { uri }) => {
    const res = await request(conn, 'textDocument/hover', {
      textDocument: { uri },
      position: offsetToPosition(content, offset),
    })
    if (!res || typeof res !== 'object') return null
    const hover = res as { contents?: unknown; range?: { start: never; end: never } }
    const markdown = normalizeHoverContents(hover.contents)
    if (!markdown) return null
    // Servers may omit the range; fall back to the queried position so the
    // tooltip still anchors somewhere sensible.
    const span = hover.range ? rangeToOffsets(content, hover.range) : { from: offset, to: offset + 1 }
    return { markdown, from: span.from, to: span.to }
  })
}

export function stdioDefinition(root: string, path: string, content: string, offset: number): Promise<LspDefinition | null> {
  return withConn(root, path, content, null as LspDefinition | null, async (conn, { uri }) => {
    const res = await request(conn, 'textDocument/definition', {
      textDocument: { uri },
      position: offsetToPosition(content, offset),
    })
    const [first] = normalizeLocations(res)
    if (!first) return null
    return {
      path: uriToPath(first.uri),
      line: first.range.start.line + 1,
      col: first.range.start.character + 1,
    }
  })
}

export function stdioReferences(root: string, path: string, content: string, offset: number): Promise<LspReference[]> {
  return withConn(root, path, content, [] as LspReference[], async (conn, { uri }) => {
    const res = await request(conn, 'textDocument/references', {
      textDocument: { uri },
      position: offsetToPosition(content, offset),
      context: { includeDeclaration: true },
    })
    const locations = normalizeLocations(res).slice(0, MAX_REFERENCES)
    const out: LspReference[] = []
    for (const loc of locations) {
      const text = textForUri(conn, loc.uri)
      const line = loc.range.start.line
      // The preview line comes from the file itself; without it a reference row
      // is a path and a number, which is not something you can scan.
      const lineText = text ? (text.split(/\r?\n/)[line] ?? '').trim().slice(0, 200) : ''
      out.push({
        path: uriToPath(loc.uri),
        line: line + 1,
        col: loc.range.start.character + 1,
        lineText,
        // LSP's plain `references` result carries neither flag; the editor
        // renders no badge rather than a guessed one.
        isDefinition: false,
        isWrite: false,
      })
    }
    return out
  })
}

export function stdioRename(root: string, path: string, content: string, offset: number, newName: string): Promise<LspRenameResult> {
  const fallback: LspRenameResult = { ok: false, error: 'lsp-unavailable' }
  return withConn(root, path, content, fallback, async (conn, { uri }) => {
    const res = await request(conn, 'textDocument/rename', {
      textDocument: { uri },
      position: offsetToPosition(content, offset),
      newName,
    })
    const perFile = normalizeWorkspaceEdit(res)
    if (perFile.length === 0) return { ok: false, error: 'no-locations' } as LspRenameResult

    const files: { path: string; newContent: string; edits: number }[] = []
    for (const entry of perFile) {
      const text = textForUri(conn, entry.uri)
      if (text === null) return { ok: false, error: `unreadable: ${uriToPath(entry.uri)}` } as LspRenameResult
      const newContent = applyRangeEdits(text, entry.edits)
      if (newContent === null) return { ok: false, error: `overlapping-edits: ${uriToPath(entry.uri)}` } as LspRenameResult
      files.push({ path: uriToPath(entry.uri), newContent, edits: entry.edits.length })
    }
    // The symbol's own text, taken from the buffer we were given — servers don't
    // report it, and the Composer plan is labelled with it.
    const wordAt = /[A-Za-z0-9_$]+/g
    let displayName = newName
    for (let m = wordAt.exec(content); m; m = wordAt.exec(content)) {
      if (m.index <= offset && offset <= m.index + m[0].length) { displayName = m[0]; break }
    }
    return { ok: true, displayName, files } as LspRenameResult
  })
}

/** The editor closed a tab — tell every server that had it open. */
export function stdioClose(path: string): void {
  const uri = pathToUri(path)
  for (const conn of conns.values()) {
    if (conn.dead || !conn.versions.has(uri)) continue
    notify(conn, 'textDocument/didClose', { textDocument: { uri } })
    conn.versions.delete(uri)
    conn.texts.delete(uri)
    conn.diagnostics.delete(uri)
  }
}

export function shutdownStdioServers(): void {
  for (const [key, conn] of [...conns]) {
    // Ask politely first: `exit` is how the protocol says to stop, and a server
    // that honours it flushes and leaves cleanly.
    try {
      notify(conn, 'shutdown', null)
      notify(conn, 'exit', null)
    } catch { /* already gone */ }
    conn.dead = true
    conns.delete(key)
    killTree(conn.proc)
  }
}

/**
 * Kill a server process, and on Windows its children.
 *
 * On Windows the server is launched through cmd.exe (see spawnCandidate), so
 * `proc.kill()` kills the *shell* and leaves the actual language server running
 * — orphaned, still holding file handles, and invisible to the user who just
 * quit the app. `taskkill /T` is the only way to take the tree down.
 */
function killTree(proc: ChildProcessWithoutNullStreams): void {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      // Already exited (the usual case, since `exit` was sent first) — fall
      // through to the plain kill rather than leaving it running.
    }
  }
  try { proc.kill() } catch { /* ignore */ }
}

// Re-exported for the IPC layer's position maths on non-TS paths.
export { positionToOffset }
