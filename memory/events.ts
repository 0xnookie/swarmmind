import { v4 as uuidv4 } from 'uuid'
import { getWorkspaceDb, hasWorkspaceDb } from './db'

// ── The Swarm Event Bus ───────────────────────────────────────────────────────
//
// One ordered, append-only log of everything the swarm does. Every mutating MCP
// tool, the PTY manager, and the renderer-side conductor tee their actions here.
// Two consumers read from it:
//   • the Swarm Timeline   — a live "watch the swarm" surface in the renderer
//   • the cost meter        — aggregates `cost` events per pane/workspace
//
// Persistence lives in the per-workspace DB (memory.db → `events` table), so the
// log is naturally scoped to a workspace and survives restarts. In-process
// subscribers (registered via onEventEmitted) are notified synchronously after
// each write so the main process can forward new events to the renderer.

export type SwarmEventType =
  | 'memory_write'
  | 'task_create'
  | 'task_update'
  | 'task_note'
  | 'task_claim'
  | 'task_release'
  | 'task_edit'
  | 'task_delete'
  | 'message'
  | 'agent_spawn'
  | 'agent_exit'
  | 'agent_question'
  | 'dispatch'
  | 'synthesis'
  | 'cost'
  | 'file_changed'
  | 'contention'
  | 'file_intent'
  | 'checkpoint'
  | 'review'

export interface SwarmEvent {
  id: string
  workspace_id: string
  ts: number
  type: SwarmEventType
  agent_id: string | null
  pane_id: string | null
  // Parsed JSON payload; shape depends on `type`. Kept loose on purpose so new
  // event kinds don't require a schema change.
  payload: Record<string, unknown> | null
  created_at: number
}

interface EmitOpts {
  agentId?: string | null
  paneId?: string | null
  payload?: Record<string, unknown> | null
  // Override the event timestamp (defaults to now). Rarely needed.
  ts?: number
}

type Subscriber = (event: SwarmEvent) => void
const subscribers = new Set<Subscriber>()

// Register an in-process listener for newly emitted events. Returns an
// unsubscribe function. Used by the main process to push events to the renderer.
export function onEventEmitted(cb: Subscriber): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

// Append an event to the log and notify subscribers. A no-op (returns null) when
// no workspace is open, so callers never need to guard. Never throws — event
// logging is best-effort and must not break the action that triggered it.
export function eventEmit(
  workspaceId: string,
  type: SwarmEventType,
  opts: EmitOpts = {}
): SwarmEvent | null {
  if (!hasWorkspaceDb()) return null
  try {
    const now = Date.now()
    const event: SwarmEvent = {
      id: uuidv4(),
      workspace_id: workspaceId,
      ts: opts.ts ?? now,
      type,
      agent_id: opts.agentId ?? null,
      pane_id: opts.paneId ?? null,
      payload: opts.payload ?? null,
      created_at: now,
    }
    getWorkspaceDb()
      .prepare(
        'INSERT INTO events (id, workspace_id, ts, type, agent_id, pane_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        event.id,
        event.workspace_id,
        event.ts,
        event.type,
        event.agent_id,
        event.pane_id,
        event.payload ? JSON.stringify(event.payload) : null,
        event.created_at
      )
    for (const cb of subscribers) {
      try { cb(event) } catch { /* a bad subscriber must not break emit */ }
    }
    return event
  } catch {
    return null
  }
}

interface ListOpts {
  // Only events strictly newer than this timestamp (for incremental fetches).
  sinceTs?: number
  // Cap the number of rows returned (newest first). Default 300.
  limit?: number
  // Restrict to these event types.
  types?: SwarmEventType[]
}

interface EventRow {
  id: string
  workspace_id: string
  ts: number
  type: string
  agent_id: string | null
  pane_id: string | null
  payload: string | null
  created_at: number
}

function rowToEvent(r: EventRow): SwarmEvent {
  let payload: Record<string, unknown> | null = null
  if (r.payload) {
    try { payload = JSON.parse(r.payload) as Record<string, unknown> } catch { payload = null }
  }
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    ts: r.ts,
    type: r.type as SwarmEventType,
    agent_id: r.agent_id,
    pane_id: r.pane_id,
    payload,
    created_at: r.created_at,
  }
}

// List events for a workspace, newest first. Returned ascending-by-ts is more
// convenient for a timeline, so we reverse the newest-first window before
// returning (the LIMIT applies to the newest N, then we present oldest→newest).
export function eventList(workspaceId: string, opts: ListOpts = {}): SwarmEvent[] {
  if (!hasWorkspaceDb()) return []
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 2000)
  const clauses = ['workspace_id = ?']
  const params: (string | number)[] = [workspaceId]
  if (opts.sinceTs !== undefined) { clauses.push('ts > ?'); params.push(opts.sinceTs) }
  if (opts.types && opts.types.length) {
    clauses.push(`type IN (${opts.types.map(() => '?').join(',')})`)
    params.push(...opts.types)
  }
  const rows = getWorkspaceDb()
    .prepare(`SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit) as EventRow[]
  return rows.map(rowToEvent).reverse()
}

// Drop the oldest events beyond `keep` so a long-lived workspace's log can't grow
// without bound. Called opportunistically (e.g. on workspace open).
export function eventPrune(workspaceId: string, keep = 5000): void {
  if (!hasWorkspaceDb()) return
  try {
    getWorkspaceDb()
      .prepare(
        `DELETE FROM events WHERE workspace_id = ? AND id NOT IN (
           SELECT id FROM events WHERE workspace_id = ? ORDER BY ts DESC LIMIT ?
         )`
      )
      .run(workspaceId, workspaceId, keep)
  } catch { /* best-effort */ }
}
