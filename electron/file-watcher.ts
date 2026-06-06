import { watch, type FSWatcher } from 'fs'
import { eventEmit } from '../memory/events'

// ── Per-pane file watcher (shared world model) ────────────────────────────────
//
// Each agent pane works in its own cwd/worktree. We watch that directory so the
// swarm has a live picture of *what changed and who changed it* — the substrate
// for contention detection (two agents editing the same file before merge time)
// and the Changes panel.
//
// Uses Node's built-in recursive fs.watch (supported on win32 — the primary
// platform — and macOS). Where recursive watching isn't available the watch
// call throws and we degrade gracefully to no file awareness rather than
// crashing. No external dependency (keeps the native-module/rebuild story
// unchanged); the trade-off is no glob ignores, so we filter paths ourselves.

interface WatchEntry {
  watcher: FSWatcher
  workspaceId: string
  agentId?: string
}

const watchers = new Map<string, WatchEntry>() // paneId → entry

// path → (paneId → last-touch epoch ms). Drives contention: a path touched by
// two distinct panes within CONTENTION_WINDOW_MS is contended.
const touches = new Map<string, Map<string, number>>()
// Per (paneId|path) debounce so a burst of saves emits one event.
const lastEmit = new Map<string, number>()
// Paths we've already warned about, with the timestamp, so we don't spam a
// contention event on every subsequent keystroke.
const warned = new Map<string, number>()

const EMIT_DEBOUNCE_MS = 600
const CONTENTION_WINDOW_MS = 90_000
const WARN_COOLDOWN_MS = 60_000

// Noise we never care about (VCS internals, deps, build output, our own dir).
const IGNORE_RE = /(^|[\\/])(\.git|node_modules|\.swarmmind|dist|out|build|\.next|\.cache|\.turbo|coverage|__pycache__|\.venv|target)([\\/]|$)/
// Editor/temp scratch files that aren't real source changes.
const TMP_RE = /(\.tmp|\.swp|\.swx|~|\.lock|\.DS_Store|\.partial)$/i

function normalize(rel: string): string {
  return rel.replace(/\\/g, '/')
}

function prune(map: Map<string, number>, now: number, ttl: number): void {
  for (const [k, ts] of map) if (now - ts > ttl) map.delete(k)
}

function onChange(paneId: string, workspaceId: string, agentId: string | undefined, rawRel: string): void {
  if (IGNORE_RE.test(rawRel) || TMP_RE.test(rawRel)) return
  const rel = normalize(rawRel)
  const now = Date.now()

  // Debounce repeated events for the same pane+path.
  const dedupeKey = `${paneId}|${rel}`
  if (now - (lastEmit.get(dedupeKey) ?? 0) < EMIT_DEBOUNCE_MS) return
  lastEmit.set(dedupeKey, now)

  eventEmit(workspaceId, 'file_changed', { agentId, paneId, payload: { path: rel } })

  // ── Contention ──────────────────────────────────────────────────────────────
  let byPane = touches.get(rel)
  if (!byPane) { byPane = new Map(); touches.set(rel, byPane) }
  byPane.set(paneId, now)
  prune(byPane, now, CONTENTION_WINDOW_MS)

  if (byPane.size >= 2 && now - (warned.get(rel) ?? 0) > WARN_COOLDOWN_MS) {
    warned.set(rel, now)
    // Map the contending panes to their agents for a readable warning.
    const agents = Array.from(byPane.keys())
      .map(pid => watchers.get(pid)?.agentId)
      .filter((a): a is string => !!a)
    eventEmit(workspaceId, 'contention', { agentId, paneId, payload: { path: rel, agents } })
  }
}

export function startPaneWatcher(paneId: string, root: string, workspaceId: string, agentId?: string): void {
  stopPaneWatcher(paneId)
  let watcher: FSWatcher
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      onChange(paneId, workspaceId, agentId, filename.toString())
    })
  } catch {
    return // recursive watch unavailable / path gone — degrade to no awareness
  }
  watcher.on('error', () => { /* transient FS errors must not crash */ })
  watchers.set(paneId, { watcher, workspaceId, agentId })
}

export function stopPaneWatcher(paneId: string): void {
  const entry = watchers.get(paneId)
  if (!entry) return
  try { entry.watcher.close() } catch { /* already closed */ }
  watchers.delete(paneId)
  // Forget this pane's contribution to contention bookkeeping.
  for (const byPane of touches.values()) byPane.delete(paneId)
  for (const key of lastEmit.keys()) if (key.startsWith(`${paneId}|`)) lastEmit.delete(key)
}

export function stopAllWatchers(): void {
  for (const paneId of Array.from(watchers.keys())) stopPaneWatcher(paneId)
  touches.clear()
  lastEmit.clear()
  warned.clear()
}
