// Main-process client for the TypeScript language service worker.
//
// Owns the worker's lifecycle and turns its postMessage traffic into promises.
// Everything degrades to "no result" rather than throwing: the editor must keep
// working (AI diagnostics, ghost text, inline edit) even if the language service
// is unavailable — e.g. a repo with no TypeScript at all.

import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LspDefinition, LspDiagnostic, LspHover, LspRequest, LspRequestBody, LspResponse } from './protocol'

const REQUEST_TIMEOUT_MS = 20_000
// A worker that dies *before* its ready ping never loaded (e.g. `typescript`
// missing from the package). Respawning that on every keystroke would thrash, so
// give up after a couple of attempts and leave the editor's other AI features
// untouched.
const MAX_LOAD_FAILURES = 2

type Pending = { resolve: (v: LspResponse) => void; timer: NodeJS.Timeout }

let worker: Worker | null = null
let nextId = 1
let disabled = false
let ready = false
let loadFailures = 0
const pending = new Map<number, Pending>()

function workerPath(): string {
  // Bundled as a sibling entry of the main bundle (see electron.vite.config.ts).
  return join(__dirname, 'lsp-worker.js')
}

function ensureWorker(): Worker | null {
  if (disabled) return null
  if (worker) return worker

  const path = workerPath()
  if (!existsSync(path)) {
    disabled = true
    return null
  }

  ready = false
  const w = new Worker(path)
  w.on('message', (res: LspResponse) => {
    ready = true // the worker loaded `typescript` and is answering
    const p = pending.get(res.id)
    if (!p) return // the 'ready' ping, or a reply that already timed out
    clearTimeout(p.timer)
    pending.delete(res.id)
    p.resolve(res)
  })
  w.on('error', () => teardown())
  w.on('exit', () => teardown())
  worker = w
  return w
}

/**
 * Drop the worker and fail every in-flight request. The next call spawns a fresh
 * one — a crash costs the current results, not the feature, and each request
 * carries its own buffer so there's no state to rebuild.
 */
function teardown(): void {
  if (!ready && ++loadFailures >= MAX_LOAD_FAILURES) disabled = true
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    p.resolve({ id: 0, ok: false, error: 'lsp-unavailable' })
  }
  pending.clear()
  worker = null
}

function request(req: LspRequestBody): Promise<LspResponse> {
  const w = ensureWorker()
  if (!w) return Promise.resolve({ id: 0, ok: false, error: 'lsp-unavailable' })

  const id = nextId++
  return new Promise<LspResponse>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ id, ok: false, error: 'timeout' })
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    w.postMessage({ id, ...req } as LspRequest)
  })
}

export async function lspClose(path: string): Promise<void> {
  await request({ type: 'close', path })
}

// Each query ships the live buffer, so the service always answers against what
// the user is looking at — not the last version saved to disk — and a worker
// restart costs nothing but the in-flight request.

export async function lspDiagnostics(path: string, content: string): Promise<LspDiagnostic[]> {
  const res = await request({ type: 'diagnostics', path, content })
  return res.ok && Array.isArray(res.data) ? (res.data as LspDiagnostic[]) : []
}

export async function lspHover(path: string, content: string, offset: number): Promise<LspHover | null> {
  const res = await request({ type: 'hover', path, content, offset })
  return res.ok && res.data ? (res.data as LspHover) : null
}

export async function lspDefinition(path: string, content: string, offset: number): Promise<LspDefinition | null> {
  const res = await request({ type: 'definition', path, content, offset })
  return res.ok && res.data ? (res.data as LspDefinition) : null
}

export function shutdownLsp(): void {
  if (worker) {
    const w = worker
    worker = null
    void w.terminate()
  }
  teardown()
}
