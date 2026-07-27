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

// ── Event-driven wake-up ─────────────────────────────────────────────────────
// The conductor is a reconciler: its tick is idempotent, so *when* it runs is
// purely a latency/efficiency question. These are the event types that can
// change what a tick would decide — the task queue (create/update/note), the
// message queue, pane availability (spawn/exit/question), or the review gate.
// Deliberately excluded: `dispatch`/`synthesis` (the conductor's own output —
// waking on them would only echo), and pure telemetry (`cost`, `file_changed`,
// `contention`, `file_intent`, `checkpoint`).
export const CONDUCTOR_WAKE_EVENTS: ReadonlySet<string> = new Set([
  'task_create',
  'task_update',
  'task_note',
  'task_claim',
  'task_release',
  'task_edit',
  'task_delete',
  'message',
  'memory_write',
  'agent_spawn',
  'agent_exit',
  'agent_question',
  'review',
])

export function isWakeEvent(type: string): boolean {
  return CONDUCTOR_WAKE_EVENTS.has(type)
}

// ── Prompt builders ──────────────────────────────────────────────────────────

// Build the single-line prompt injected into a worker's PTY. Kept to one line on
// purpose: embedded newlines would submit prematurely in most CLI agents.
// When `reviewable` is true (a distinct second agent is available to review), the
// worker is told to report `needs_review` instead of `done` so the review gate
// engages; otherwise it reports `done` directly. The worker is also asked to post
// periodic `task_note` progress pings — those are the heartbeat the conductor's
// stuck-watchdog (sweepAction 'escalate') watches, so a long-but-alive task isn't
// mistaken for a stall.
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
    `${finish} For longer work, call task_note on "${task.id}" every major step so the orchestrator can see you are still progressing. ` +
    `If you cannot finish it, call task_update with status "failed".`
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

// Why a task is being handed to the lead to re-plan (see buildEscalationPrompt):
//   failed       — exhausted its automatic retries
//   stalled      — a dispatched worker went silent (no progress heartbeat, never
//                  reported done) past the stuck window
//   unassignable — pending & ready but assigned to an agent with no running pane,
//                  so no worker can ever pick it up (a swarm deadlock)
export type EscalationReason = 'failed' | 'stalled' | 'unassignable'

const ESCALATION_SITUATION: Record<EscalationReason, string> = {
  failed: 'has failed and exhausted its automatic retries',
  stalled: 'has stalled — its worker went silent without reporting progress or completion',
  unassignable: 'is assigned to an agent that has no running pane, so no worker can pick it up',
}

// Prompt the LEAD to re-plan a task the deterministic loop can't resolve on its
// own. This is the escalation brain: rather than silently giving up, the loop
// asks the lead to reassign, re-split, or drop the task. The lead reasons and
// acts via MCP; it must not implement the task itself.
export function buildEscalationPrompt(task: ConductorTask, reason: EscalationReason): string {
  const desc = task.description ? ` (${oneLine(task.description, 120)})` : ''
  return (
    `[SwarmMind orchestrator] Task ${shortId(task.id)} "${task.title}"${desc} ${ESCALATION_SITUATION[reason]}. ` +
    `As the LEAD, decide how to unblock the goal — first read it with task_get id "${task.id}", then either: ` +
    `reassign it (task_update id "${task.id}" with a different assigned_agent and status "pending"); ` +
    `split it into smaller subtasks (task_create for each, then mark this one done or delete it); ` +
    `or drop it if it is no longer needed (task_update status "done"). Do NOT implement the task yourself.`
  )
}

// Optional per-completion report to the lead (feature-flagged): tell the lead a
// task finished so it can course-correct mid-run — spawn a follow-up, reprioritise
// — instead of only learning the outcome at the final synthesis.
export function buildLeadReportPrompt(task: ConductorTask, result: string | null, remaining: number): string {
  const summary = result ? oneLine(result, 240) : '(no result summary was written to shared memory)'
  const left = remaining > 0 ? `${remaining} task(s) still remain.` : 'That was the last task.'
  return (
    `[SwarmMind orchestrator] Progress update — task ${shortId(task.id)} "${task.title}" is done: ${summary} ${left} ` +
    `You are the LEAD: if this result changes the plan, adjust it now (create follow-up tasks with task_create, or reassign existing ones). ` +
    `If nothing needs to change, take no action — do not re-implement completed work.`
  )
}

// ── 1. Completion sweep ──────────────────────────────────────────────────────
// What to do with one dispatched pane→task binding this tick. Every action
// except 'nudge'/'none' frees the pane.

export type SweepAction =
  | 'free_vanished' //   task was deleted — just free the pane
  | 'free_done' //       worker reported done — collect the result, free
  | 'retry' //           worker reported failed, retries remain — reset to pending
  | 'give_up' //         worker reported failed, retries exhausted — escalate/attention
  | 'free_for_review' // worker submitted for review — review routing takes over
  | 'free_pane_exited' // the agent process died mid-task
  | 'nudge' //           idle past the stall window without reporting — remind once
  | 'escalate' //        no progress heartbeat for the stuck window — hand to lead
  | 'none'

// `stallMs` is the short window after which a *waiting* worker gets one nudge;
// `stuckMs` (much longer) is the progress-heartbeat window after which a worker
// that has made no progress at all — whether it went silent while `waiting` or is
// spinning `working` forever — is escalated. `lastProgressAt` is the epoch ms of
// the last progress signal (dispatch time, advanced whenever the task's notes
// change via task_note); its absence of movement is what "stuck" means, which is
// why a genuinely-working task that keeps posting task_note is never escalated.
export function sweepAction(i: {
  task: ConductorTask | undefined
  retries: number
  maxRetries: number
  paneRunning: boolean
  paneWaiting: boolean
  alreadyNudged: boolean
  dispatchedAt: number | undefined
  lastProgressAt: number | undefined
  now: number
  stallMs: number
  stuckMs: number
}): SweepAction {
  if (!i.task) return 'free_vanished'
  if (i.task.status === 'done') return 'free_done'
  if (i.task.status === 'failed') return i.retries < i.maxRetries ? 'retry' : 'give_up'
  if (i.task.status === 'needs_review') return 'free_for_review'
  if (!i.paneRunning) return 'free_pane_exited'
  if (i.paneWaiting && !i.alreadyNudged && i.now - (i.dispatchedAt ?? i.now) > i.stallMs) return 'nudge'
  if (i.now - (i.lastProgressAt ?? i.dispatchedAt ?? i.now) > i.stuckMs) return 'escalate'
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

// ── 3a. Deadlock detection ───────────────────────────────────────────────────
// Ready-to-run tasks (pending, deps met, not skipped) that are pinned to an agent
// which has no running worker pane — no dispatch can ever match them, so they'd
// sit forever. Surfacing them lets the loop escalate to the lead to reassign or
// re-split, rather than deadlocking silently. (Unassigned or busy-agent tasks are
// NOT here — those just wait for a free worker and resolve on their own.)
export function findUnassignable(i: {
  tasks: readonly ConductorTask[]
  workerAgentIds: ReadonlySet<string>
  skippedTaskIds: ReadonlySet<string>
}): ConductorTask[] {
  const doneIds = new Set(i.tasks.filter(t => t.status === 'done').map(t => t.id))
  return i.tasks.filter(
    t =>
      t.status === 'pending' &&
      !i.skippedTaskIds.has(t.id) &&
      !!t.assigned_agent &&
      !i.workerAgentIds.has(t.assigned_agent) &&
      depsMet(t, doneIds)
  )
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

// ── Spend budget ─────────────────────────────────────────────────────────────
//
// `auto` mode dispatches, retries and escalates on its own, for as long as
// there is work — which means it spends money unattended. The PTY manager
// already parses each agent's reported cumulative cost into the store's
// `paneCost`, so the guardrail is simply: stop starting *new* work once the run
// has spent its budget.
//
// The semantics are deliberately narrow. Exceeding the budget pauses dispatch;
// it does not kill in-flight agents (that would strand half-finished work) and
// it does not touch `assisted` mode, where a human already approves every step.

export type BudgetVerdict = 'ok' | 'warn' | 'exceeded'

// Fraction of the budget at which to warn the user that it's nearly gone.
export const BUDGET_WARN_AT = 0.8

// Total spend across every pane in the run.
export function totalSpend(paneCost: Record<string, { usd: number }> | undefined): number {
  let sum = 0
  for (const entry of Object.values(paneCost ?? {})) {
    const usd = Number(entry?.usd)
    if (Number.isFinite(usd) && usd > 0) sum += usd
  }
  return sum
}

// No budget set (null) always reads 'ok' — the guardrail is opt-in, and an
// unset budget must never pause a run.
export function budgetStatus(spentUsd: number, limitUsd: number | null): BudgetVerdict {
  if (limitUsd === null || !(limitUsd > 0)) return 'ok'
  if (spentUsd >= limitUsd) return 'exceeded'
  return spentUsd >= limitUsd * BUDGET_WARN_AT ? 'warn' : 'ok'
}

// Parse the budget field. Blank means "no budget"; anything not a positive
// finite number is rejected rather than silently coerced to 0, which would
// otherwise read as "exceeded" and pause the run immediately.
export function parseBudget(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? '').trim().replace(/^\$/, '')
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`
}

export function buildBudgetHaltNote(spentUsd: number, limitUsd: number): string {
  return `⏸ budget reached — spent ${formatUsd(spentUsd)} of ${formatUsd(limitUsd)}. Dispatch paused; running agents finish. Raise the budget to continue.`
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
