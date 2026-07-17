// Pure logic for paperclip-style atomic task checkout ("claim").
//
// The DB helper `taskClaim` (memory/queries.ts) does the *atomic* part inside a
// single better-sqlite3 transaction — SQLite's single-writer guarantee is what
// makes the checkout a real lock, so no two agents can grab the same row. This
// module is the *policy* part — which pending task a given agent should get next
// — extracted so it can be unit-tested without a database. Lives in electron/lib
// (main-process pure logic, like aiParse.ts/tsLsp.ts) because queries.ts consumes
// it; it deliberately imports nothing (the dep helpers below are duplicated from
// the renderer's conductor.ts rather than imported across the process bundle
// boundary — keep the two copies in sync, same as isSafeScriptName).

export type TaskStatus = 'pending' | 'in_progress' | 'needs_review' | 'done' | 'failed'

// The minimal shape claim selection needs. Real Task rows (memory/queries.ts)
// satisfy it directly.
export interface ClaimableTask {
  id: string
  status: TaskStatus
  assigned_agent: string | null
  depends_on: string | null
  priority: number
  created_at: number
}

export interface ClaimOptions {
  // Claim this specific task instead of auto-picking the next one. It must still
  // be eligible (pending, deps met, not held by another agent).
  taskId?: string
}

// Duplicated from conductor.ts (renderer) — kept trivial and in sync.
export function parseDeps(depends_on: string | null): string[] {
  return depends_on ? depends_on.split(',').map(s => s.trim()).filter(Boolean) : []
}

export function depsMet(task: Pick<ClaimableTask, 'depends_on'>, doneIds: ReadonlySet<string>): boolean {
  return parseDeps(task.depends_on).every(d => doneIds.has(d))
}

// Is `task` claimable by `agentId` right now?
//  - must be pending (in_progress/review/done/failed are not up for grabs)
//  - must be unclaimed, or already assigned to this same agent (idempotent
//    re-claim / picking up work the human pre-assigned to it)
//  - every prerequisite in depends_on must be done (same gate the conductor uses
//    for dispatch, so pull and push agree on readiness)
export function isClaimable(
  task: ClaimableTask,
  agentId: string,
  doneIds: ReadonlySet<string>,
): boolean {
  if (task.status !== 'pending') return false
  if (task.assigned_agent && task.assigned_agent !== agentId) return false
  return depsMet(task, doneIds)
}

// Order two eligible candidates: higher priority first, then oldest first (FIFO),
// then a stable id tiebreak so selection is deterministic across DB row order.
function compareCandidates(a: ClaimableTask, b: ClaimableTask): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  if (a.created_at !== b.created_at) return a.created_at - b.created_at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// Pick the single task `agentId` should claim next from `tasks`, or null if none
// is available. `doneIds` is the set of completed task ids (for the dep gate).
export function selectClaimable(
  tasks: readonly ClaimableTask[],
  agentId: string,
  doneIds: ReadonlySet<string>,
  opts: ClaimOptions = {},
): ClaimableTask | null {
  if (opts.taskId) {
    const t = tasks.find(x => x.id === opts.taskId)
    return t && isClaimable(t, agentId, doneIds) ? t : null
  }
  const eligible = tasks.filter(t => isClaimable(t, agentId, doneIds))
  if (!eligible.length) return null
  return eligible.slice().sort(compareCandidates)[0]
}

// The set of done task ids, for callers holding the full task list. Mirrors the
// conductor's `doneIds` derivation so claim and dispatch see readiness the same.
export function doneIdSet(tasks: readonly { id: string; status: string }[]): Set<string> {
  return new Set(tasks.filter(t => t.status === 'done').map(t => t.id))
}
