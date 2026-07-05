// Pure decision logic for the Conductor (useConductor.ts) — the autonomous
// orchestration loop. Every per-tick decision lives here as a function over
// plain data: what to do with each dispatched pane (sweepAction), whether the
// lead's decomposition has stalled (decomposeAction), which pending task goes
// to which free worker (planDispatches), who reviews a submitted task
// (planReviews), when the lead may synthesise (readyForSynthesis), and which
// pane receives a queued agent-to-agent message (planMessageDelivery). The hook
// keeps only the impure shell (store reads, IPC, PTY injection, timers), so a
// silent autonomy regression here is caught by `npm test`, not discovered in a
// live run. Imports nothing — strip-and-runs straight from source.

export type TaskStatus = 'pending' | 'in_progress' | 'needs_review' | 'done' | 'failed'

// Shape of a task as returned by window.swarmmind.taskList().
export interface ConductorTask {
  id: string
  title: string
  description: string | null
  notes: string | null
  status: TaskStatus
  assigned_agent: string | null
  depends_on: string | null
}

export interface WorkerPane {
  id: string
  agentId: string
}

// ── Small shared helpers ─────────────────────────────────────────────────────

export function parseDeps(depends_on: string | null): string[] {
  return depends_on ? depends_on.split(',').map(s => s.trim()).filter(Boolean) : []
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function oneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n) + '…' : flat
}

export function depsMet(task: ConductorTask, doneIds: ReadonlySet<string>): boolean {
  return parseDeps(task.depends_on).every(d => doneIds.has(d))
}

// The review gate engages only when a *distinct* second agent exists to review
// (no self-review); otherwise workers report done directly.
export function canReview(workers: readonly WorkerPane[]): boolean {
  return new Set(workers.map(w => w.agentId)).size >= 2
}

// ── Prompt builders ──────────────────────────────────────────────────────────

// Build the single-line prompt injected into a worker's PTY. Kept to one line on
// purpose: embedded newlines would submit prematurely in most CLI agents.
// When `reviewable` is true (a distinct second agent is available to review), the
// worker is told to report `needs_review` instead of `done` so the review gate
// engages; otherwise it reports `done` directly.
export function buildDispatchPrompt(task: ConductorTask, reviewable: boolean): string {
  const deps = parseDeps(task.depends_on)
  const depHint = deps.length
    ? ` Prerequisite results are in shared memory under keys ${deps.map(d => `result:${d}`).join(', ')} — read them with memory_read first.`
    : ''
  const desc = task.description ? ` ${task.description}` : ''
  const finish = reviewable
    ? `When finished, call MCP memory_write with key "result:${task.id}", type "context", and a concise summary of what you did, then call task_update with id "${task.id}" and status "needs_review" (another agent will review it).`
    : `When finished, call MCP task_update with id "${task.id}" and status "done", and memory_write with key "result:${task.id}", type "context", and a concise summary of what you did.`
  return (
    `[SwarmMind orchestrator] Please work on task ${shortId(task.id)} "${task.title}".${desc}${depHint} ` +
    `${finish} If you cannot finish it, call task_update with status "failed".`
  )
}

// Prompt for a reviewer pane: inspect another agent's submitted work and record
// an approve/reject verdict via the task_review MCP tool.
export function buildReviewPrompt(task: ConductorTask): string {
  return (
    `[SwarmMind orchestrator] Please REVIEW task ${shortId(task.id)} "${task.title}", which another agent completed and submitted for review. ` +
    `Read its summary with memory_read key "result:${task.id}" and inspect the actual changed files. ` +
    `If it is correct and complete, call MCP task_review with id "${task.id}" and verdict "approve". ` +
    `Otherwise call task_review with verdict "reject" and a comment describing what needs to change.`
  )
}

export function buildDecomposePrompt(goal: string, workers: string[]): string {
  const agents = workers.length ? workers.join(', ') : 'the worker panes'
  return (
    `[SwarmMind orchestrator] You are the LEAD agent. Break the following goal into small, parallelizable subtasks and create each one with the ` +
    `task_create MCP tool. Set assigned_agent for each subtask and use depends_on (passing the ids task_create returns) wherever ordering matters. ` +
    `Do NOT implement the subtasks yourself — only create them. Available worker agents: ${agents}. GOAL: ${goal}`
  )
}

export function buildSynthesisPrompt(goal: string, results: { title: string; value: string }[]): string {
  const joined = results.length
    ? results.map(r => `${r.title}: ${truncate(r.value, 400)}`).join(' | ')
    : '(no result summaries were written to shared memory)'
  return (
    `[SwarmMind orchestrator] All subtasks are complete. Results — ${joined}. ` +
    `Please synthesise the final outcome for the goal "${goal}" and note any follow-ups.`
  )
}

export function buildNudgePrompt(taskId: string): string {
  return `[SwarmMind orchestrator] If task ${shortId(taskId)} is finished, call MCP task_update with status "done" and memory_write key "result:${taskId}". If you are blocked, call task_update with status "failed".`
}

// ── 1. Completion sweep ──────────────────────────────────────────────────────
// What to do with one dispatched pane→task binding this tick. Every action
// except 'nudge'/'none' frees the pane.

export type SweepAction =
  | 'free_vanished' //   task was deleted — just free the pane
  | 'free_done' //       worker reported done — collect the result, free
  | 'retry' //           worker reported failed, retries remain — reset to pending
  | 'give_up' //         worker reported failed, retries exhausted — needs attention
  | 'free_for_review' // worker submitted for review — review routing takes over
  | 'free_pane_exited' // the agent process died mid-task
  | 'nudge' //           idle past the stall window without reporting — remind once
  | 'none'

export function sweepAction(i: {
  task: ConductorTask | undefined
  retries: number
  maxRetries: number
  paneRunning: boolean
  paneWaiting: boolean
  alreadyNudged: boolean
  dispatchedAt: number | undefined
  now: number
  stallMs: number
}): SweepAction {
  if (!i.task) return 'free_vanished'
  if (i.task.status === 'done') return 'free_done'
  if (i.task.status === 'failed') return i.retries < i.maxRetries ? 'retry' : 'give_up'
  if (i.task.status === 'needs_review') return 'free_for_review'
  if (!i.paneRunning) return 'free_pane_exited'
  if (i.paneWaiting && !i.alreadyNudged && i.now - (i.dispatchedAt ?? i.now) > i.stallMs) return 'nudge'
  return 'none'
}

// ── 2. Decomposition watchdog ────────────────────────────────────────────────
// The lead was asked to decompose but no tasks have appeared. Re-prompt once,
// then give up so a goal-driven run can't hang silently. 'none' while tasks
// exist, the window hasn't elapsed, or the watchdog already gave up.

export function decomposeAction(i: {
  attempts: number //  0 = not asked, 1 = asked once, 2 = re-prompted, 3 = gave up
  askedAt: number | null
  now: number
  timeoutMs: number
  taskCount: number
  leadRunning: boolean
}): 'reprompt' | 'give_up' | 'none' {
  if (i.taskCount > 0 || i.attempts < 1 || i.attempts >= 3) return 'none'
  if (i.askedAt === null || i.now - i.askedAt <= i.timeoutMs) return 'none'
  return i.attempts === 1 && i.leadRunning ? 'reprompt' : 'give_up'
}

// ── 2b. Review-completion sweep ──────────────────────────────────────────────
// What to do with one reviewer pane→task binding: the verdict landed
// (task_review moved the task to done=approved or pending=changes-requested),
// the task vanished, or the reviewer pane died — all of which unbind.

export function reviewSweepAction(
  task: ConductorTask | undefined,
  paneRunning: boolean,
): 'approved' | 'rejected' | 'unbind' | 'none' {
  if (!task) return 'unbind'
  if (task.status === 'done') return 'approved'
  if (task.status === 'pending') return 'rejected'
  if (!paneRunning) return 'unbind'
  return 'none'
}

// ── 3. Dispatch matching ─────────────────────────────────────────────────────
// Match dispatchable tasks (pending, deps met, not skipped/already active) to
// free workers, preferring a worker whose agent matches the task's assignment
// (an unassigned task takes any free worker). Claims panes and tasks as it
// goes, so two tasks never land on one pane in the same tick. `limit` caps the
// number of pairings (assisted mode proposes one at a time).

export interface Assignment<W extends WorkerPane> {
  task: ConductorTask
  worker: W
}

export function planDispatches<W extends WorkerPane>(i: {
  tasks: readonly ConductorTask[]
  workers: readonly W[]
  occupiedPaneIds: ReadonlySet<string>
  workingPaneIds: ReadonlySet<string>
  activeTaskIds: ReadonlySet<string>
  skippedTaskIds: ReadonlySet<string>
  limit?: number
}): Assignment<W>[] {
  const doneIds = new Set(i.tasks.filter(t => t.status === 'done').map(t => t.id))
  const claimedPanes = new Set(i.occupiedPaneIds)
  const claimedTasks = new Set(i.activeTaskIds)
  const out: Assignment<W>[] = []

  const isFree = (w: W) => !claimedPanes.has(w.id) && !i.workingPaneIds.has(w.id)

  for (const task of i.tasks) {
    if (out.length >= (i.limit ?? Infinity)) break
    if (task.status !== 'pending' || i.skippedTaskIds.has(task.id) || claimedTasks.has(task.id)) continue
    if (!depsMet(task, doneIds)) continue
    const worker = i.workers.find(w => isFree(w) && (!task.assigned_agent || w.agentId === task.assigned_agent))
    if (!worker) continue
    claimedPanes.add(worker.id)
    claimedTasks.add(task.id)
    out.push({ task, worker })
  }
  return out
}

// ── 3b. Review routing ───────────────────────────────────────────────────────
// Assign each unreviewed `needs_review` task to a free worker of a *different*
// agent than the author (no self-review). An unassigned author means any free
// worker qualifies.

export function planReviews<W extends WorkerPane>(i: {
  tasks: readonly ConductorTask[]
  workers: readonly W[]
  occupiedPaneIds: ReadonlySet<string>
  workingPaneIds: ReadonlySet<string>
  underReviewTaskIds: ReadonlySet<string>
  skippedTaskIds: ReadonlySet<string>
}): Assignment<W>[] {
  const claimedPanes = new Set(i.occupiedPaneIds)
  const out: Assignment<W>[] = []

  for (const task of i.tasks) {
    if (task.status !== 'needs_review' || i.underReviewTaskIds.has(task.id) || i.skippedTaskIds.has(task.id)) continue
    const reviewer = i.workers.find(
      w => !claimedPanes.has(w.id) && !i.workingPaneIds.has(w.id) && w.agentId !== task.assigned_agent
    )
    if (!reviewer) continue
    claimedPanes.add(reviewer.id)
    out.push({ task, worker: reviewer })
  }
  return out
}

// ── 4. Lead synthesis gate ───────────────────────────────────────────────────
// Synthesis may fire once tasks exist and none is still open (pending,
// in_progress, or awaiting review) — so the review gate holds synthesis back.

export function readyForSynthesis(tasks: readonly ConductorTask[]): boolean {
  if (tasks.length === 0) return false
  return !tasks.some(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'needs_review')
}

// ── Message delivery ─────────────────────────────────────────────────────────
// Pair each queued agent-to-agent message with a free running pane of the
// recipient agent: at most one message per pane per tick, never a pane that's
// mid-output. An unmatched message is left for a later tick.

export interface MessagePane {
  id: string
  agentId: string | null
  running: boolean
  working: boolean
}

export function planMessageDelivery<M extends { to_agent: string }, P extends MessagePane>(
  messages: readonly M[],
  panes: readonly P[],
): { message: M; pane: P }[] {
  const usedPanes = new Set<string>()
  const out: { message: M; pane: P }[] = []
  for (const message of messages) {
    const pane = panes.find(
      p => p.agentId === message.to_agent && p.running && !usedPanes.has(p.id) && !p.working
    )
    if (!pane) continue
    usedPanes.add(pane.id)
    out.push({ message, pane })
  }
  return out
}
