import { useEffect, useRef } from 'react'
import {
  useWorkspaceStore,
  type AgentId,
  type PaneNode,
  type PaneLeaf,
  type DispatchProposal,
  type OrchestratorLogEntry,
} from '../store/workspace'

// ── The Conductor ───────────────────────────────────────────────────────────
//
// A deterministic control loop that turns SwarmMind's shared task queue + the
// per-pane `working/waiting` signal into autonomous multi-agent orchestration:
//
//   • Lead (optional)  — when a goal-driven run starts, the designated lead pane
//                        is asked to decompose the goal into tasks (via the
//                        task_create MCP tool), and to synthesise the results
//                        once every subtask is done.
//   • Workers          — every other agent pane. The conductor dispatches the
//                        next dispatchable task (pending, dependencies met,
//                        matching the pane's agent) by injecting a prompt into
//                        that pane's PTY.
//   • Completion       — a worker reports done by calling task_update(...,'done')
//                        and memory_write('result:<id>', …) over MCP. The
//                        conductor watches the task list and reacts.
//
// The conductor itself spends zero model tokens: code does the wiring, the LLM
// panes do the thinking.

// Shape of a task as returned by window.swarmmind.taskList().
interface ConductorTask {
  id: string
  title: string
  description: string | null
  notes: string | null
  status: 'pending' | 'in_progress' | 'needs_review' | 'done' | 'failed'
  assigned_agent: string | null
  depends_on: string | null
}

interface WorkerPane {
  id: string
  agentId: AgentId
}

// Module-level handle so the OrchestratorBar (rendered deep in the tree) can
// drive the single conductor instance mounted in App.
export const conductorControls: { approve: () => void; skip: () => void } = {
  approve: () => {},
  skip: () => {},
}

const TICK_MS = 1500

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

function parseDeps(depends_on: string | null): string[] {
  return depends_on ? depends_on.split(',').map(s => s.trim()).filter(Boolean) : []
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// Build the single-line prompt injected into a worker's PTY. Kept to one line on
// purpose: embedded newlines would submit prematurely in most CLI agents.
// When `reviewable` is true (a distinct second agent is available to review), the
// worker is told to report `needs_review` instead of `done` so the review gate
// engages; otherwise it reports `done` directly.
function buildDispatchPrompt(task: ConductorTask, reviewable: boolean): string {
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
function buildReviewPrompt(task: ConductorTask): string {
  return (
    `[SwarmMind orchestrator] Please REVIEW task ${shortId(task.id)} "${task.title}", which another agent completed and submitted for review. ` +
    `Read its summary with memory_read key "result:${task.id}" and inspect the actual changed files. ` +
    `If it is correct and complete, call MCP task_review with id "${task.id}" and verdict "approve". ` +
    `Otherwise call task_review with verdict "reject" and a comment describing what needs to change.`
  )
}

function oneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n) + '…' : flat
}

// The context compiler: assemble a compact, single-line context block to append
// to a worker's dispatch prompt — its dependencies' actual results plus the most
// relevant shared-memory entries (ranked by relevance to the task) — so the
// worker starts informed instead of re-exploring. A few cheap lookups here save
// the worker a lot of flailing tokens. Best-effort: returns '' on any failure.
async function composeContext(task: ConductorTask): Promise<string> {
  const parts: string[] = []
  for (const dep of parseDeps(task.depends_on)) {
    const r = await readResult(dep)
    if (r) parts.push(`result:${shortId(dep)}=${oneLine(r, 200)}`)
  }
  try {
    const query = `${task.title} ${task.description ?? ''}`
    const hits = (await window.swarmmind.memorySearch(query, 3)) as ScoredMemoryEntry[]
    for (const h of hits) {
      if (h.key.startsWith('result:')) continue // dependency results already covered
      parts.push(`${h.key}=${oneLine(h.value, 160)}`)
    }
  } catch { /* search unavailable — dispatch without the memory context */ }
  return parts.length ? ` Relevant context from shared memory — ${parts.join(' ; ')}.` : ''
}

function buildDecomposePrompt(goal: string, workers: AgentId[]): string {
  const agents = workers.length ? workers.join(', ') : 'the worker panes'
  return (
    `[SwarmMind orchestrator] You are the LEAD agent. Break the following goal into small, parallelizable subtasks and create each one with the ` +
    `task_create MCP tool. Set assigned_agent for each subtask and use depends_on (passing the ids task_create returns) wherever ordering matters. ` +
    `Do NOT implement the subtasks yourself — only create them. Available worker agents: ${agents}. GOAL: ${goal}`
  )
}

function buildSynthesisPrompt(goal: string, results: { title: string; value: string }[]): string {
  const joined = results.length
    ? results.map(r => `${r.title}: ${truncate(r.value, 400)}`).join(' | ')
    : '(no result summaries were written to shared memory)'
  return (
    `[SwarmMind orchestrator] All subtasks are complete. Results — ${joined}. ` +
    `Please synthesise the final outcome for the goal "${goal}" and note any follow-ups.`
  )
}

function inject(paneId: string, text: string): void {
  window.swarmmind.ptyInput(paneId, text)
  window.swarmmind.ptyInput(paneId, '\r')
}

async function readResult(taskId: string): Promise<string | null> {
  try {
    const entry = (await window.swarmmind.memoryRead(`result:${taskId}`)) as { value?: string } | null
    return entry?.value ?? null
  } catch {
    return null
  }
}

// Deliver queued agent-to-agent messages by injecting them into a free running
// pane of the recipient agent. Runs every tick regardless of orchestration mode,
// so agents can hand off even during purely manual coordination. At most one
// message per pane per tick, and only to panes that aren't mid-output, so we
// don't interrupt an agent that's actively working.
async function deliverMessages(): Promise<void> {
  let pending: AgentMessage[]
  try {
    pending = await window.swarmmind.messagesUndelivered()
  } catch {
    return
  }
  if (!pending.length) return

  const st = useWorkspaceStore.getState()
  const leaves = collectLeaves(st.rootPane)
  const usedPanes = new Set<string>()

  for (const msg of pending) {
    const pane = leaves.find(
      l =>
        l.agentId === msg.to_agent &&
        l.ptyStatus === 'running' &&
        !usedPanes.has(l.id) &&
        st.paneAttention[l.id] !== 'working'
    )
    if (!pane) continue // no free recipient pane right now — retry next tick
    inject(pane.id, `[SwarmMind message from ${msg.from_agent}] ${msg.body}`)
    usedPanes.add(pane.id)
    await window.swarmmind.messageMarkDelivered(msg.id).catch(() => {})
    st.pushOrchestratorLog(`✉ ${msg.from_agent} → ${msg.to_agent}: ${truncate(msg.body, 60)}`)
  }
}

export function useConductor(): void {
  // Run-scoped bookkeeping (a single goal-driven run between start and reset).
  const decomposedGoalRef = useRef<string | null>(null)
  const synthesizedRef = useRef(false)
  const hadTasksRef = useRef(false)
  const skippedRef = useRef<Set<string>>(new Set())
  const prevPhaseRef = useRef<string>('idle')
  // Guards against overlapping async ticks.
  const busyRef = useRef(false)
  // ── Robustness bookkeeping (session-scoped, reset on each fresh run) ─────────
  // taskId → how many times we've re-dispatched it after a `failed` report.
  const retryCountRef = useRef<Map<string, number>>(new Map())
  // taskId → epoch ms when it was dispatched (for stall detection).
  const dispatchedAtRef = useRef<Map<string, number>>(new Map())
  // taskIds we've already nudged once about a possible stall.
  const nudgedRef = useRef<Set<string>>(new Set())
  // reviewer paneId → taskId currently being reviewed (the review gate).
  const reviewBindingRef = useRef<Map<string, string>>(new Map())
  // When the lead was last asked to decompose, for the no-tasks watchdog.
  const decomposeAtRef = useRef<number | null>(null)
  // 0 = not asked, 1 = asked once, 2 = re-prompted, 3 = gave up.
  const decomposeAttemptsRef = useRef(0)

  // A failed task is retried up to this many times (re-dispatched, possibly to a
  // different free worker) before being surfaced as needing attention.
  const MAX_RETRIES = 1
  // A dispatched worker that has gone idle this long while its task is still
  // in_progress gets one gentle reminder to report completion over MCP.
  const STALL_MS = 30_000
  // If the lead produces no tasks within this window of being asked, re-prompt
  // once, then give up so the run doesn't hang forever.
  const DECOMPOSE_TIMEOUT_MS = 25_000

  // Perform a dispatch: inject the prompt, move the task to in_progress, and
  // record the pane→task binding. Shared by auto mode and assisted approval.
  const dispatch = (p: DispatchProposal) => {
    const st = useWorkspaceStore.getState()
    inject(p.paneId, p.prompt)
    window.swarmmind.taskUpdate(p.taskId, 'in_progress').catch(() => {})
    st.setPaneTask(p.paneId, p.taskId)
    dispatchedAtRef.current.set(p.taskId, Date.now())
    nudgedRef.current.delete(p.taskId)
    st.pushOrchestratorLog(`→ dispatched "${p.title}" to ${p.agentId ?? 'pane'} (${shortId(p.taskId)})`)
    window.swarmmind
      .eventEmit('dispatch', { taskId: p.taskId, title: p.title }, p.paneId, p.agentId ?? undefined)
      .catch(() => {})
  }

  // Wire the UI controls to this instance.
  useEffect(() => {
    conductorControls.approve = () => {
      const p = useWorkspaceStore.getState().orchestratorProposal
      if (!p) return
      dispatch(p)
      useWorkspaceStore.getState().setOrchestratorProposal(null)
    }
    conductorControls.skip = () => {
      const st = useWorkspaceStore.getState()
      const p = st.orchestratorProposal
      if (!p) return
      skippedRef.current.add(p.taskId)
      st.pushOrchestratorLog(`skipped "${p.title}"`)
      st.setOrchestratorProposal(null)
    }
    return () => {
      conductorControls.approve = () => {}
      conductorControls.skip = () => {}
    }
  }, [])

  useEffect(() => {
    const tick = async () => {
      if (busyRef.current) return
      const st = useWorkspaceStore.getState()
      const { orchestrationMode, workspace, leadPaneId, orchestratorPhase } = st
      if (!workspace) return

      busyRef.current = true
      try {
        // Agent-to-agent message delivery runs regardless of orchestration mode.
        await deliverMessages()
        if (orchestrationMode === 'off') return

        // Reset run-scoped state on each fresh goal-driven run (idle → running).
        if (prevPhaseRef.current !== 'running' && orchestratorPhase === 'running') {
          // Auto-checkpoint the workspace so the whole run is rewindable. Best-
          // effort and fire-and-forget (no-op when not a git repo).
          window.swarmmind.checkpointCreate('Before run', 'orchestration').catch(() => {})
          decomposedGoalRef.current = null
          synthesizedRef.current = false
          hadTasksRef.current = false
          skippedRef.current.clear()
          retryCountRef.current.clear()
          dispatchedAtRef.current.clear()
          nudgedRef.current.clear()
          reviewBindingRef.current.clear()
          decomposeAtRef.current = null
          decomposeAttemptsRef.current = 0
        }
        prevPhaseRef.current = orchestratorPhase

        const tasks = (await window.swarmmind.taskList()) as ConductorTask[]
        const byId = new Map(tasks.map(t => [t.id, t]))
        const doneIds = new Set(tasks.filter(t => t.status === 'done').map(t => t.id))
        if (tasks.length > 0) hadTasksRef.current = true

        // Re-read state — taskList awaited above may have raced a UI change.
        const cur = useWorkspaceStore.getState()
        const leaves = collectLeaves(cur.rootPane)
        const runningPaneIds = new Set(
          leaves.filter(l => l.ptyStatus === 'running').map(l => l.id)
        )

        // ── 1. Completion sweep ─────────────────────────────────────────────
        for (const [paneId, taskId] of Object.entries(cur.paneTask)) {
          const task = byId.get(taskId)
          if (!task) {
            // Task vanished (deleted) — free the pane.
            cur.setPaneTask(paneId, null)
            dispatchedAtRef.current.delete(taskId)
            continue
          }
          if (task.status === 'done') {
            const result = await readResult(taskId)
            cur.pushOrchestratorLog(
              `✓ "${task.title}" done${result ? ` — ${truncate(result, 80)}` : ''}`
            )
            cur.setPaneTask(paneId, null)
            dispatchedAtRef.current.delete(taskId)
          } else if (task.status === 'failed') {
            // Retry transient failures by resetting the task to pending so it can
            // be re-dispatched (to any matching free worker) on a later tick.
            const attempts = retryCountRef.current.get(taskId) ?? 0
            if (attempts < MAX_RETRIES) {
              retryCountRef.current.set(taskId, attempts + 1)
              window.swarmmind.taskUpdate(taskId, 'pending').catch(() => {})
              cur.pushOrchestratorLog(`↻ retrying "${task.title}" (attempt ${attempts + 2})`)
            } else {
              cur.pushOrchestratorLog(`✗ "${task.title}" failed after ${attempts + 1} attempt(s) — needs attention`)
            }
            cur.setPaneTask(paneId, null)
            dispatchedAtRef.current.delete(taskId)
          } else if (task.status === 'needs_review') {
            // Author delivered the work and submitted it for review — free their
            // pane; the review-routing pass below assigns a different agent to it.
            cur.pushOrchestratorLog(`⚖ "${task.title}" submitted for review`)
            cur.setPaneTask(paneId, null)
            dispatchedAtRef.current.delete(taskId)
          } else if (!runningPaneIds.has(paneId)) {
            // The agent process died mid-task — free the pane so work can be
            // re-dispatched (the task stays in_progress for the user to review).
            cur.pushOrchestratorLog(`⚠ pane for "${task.title}" exited`)
            cur.setPaneTask(paneId, null)
            dispatchedAtRef.current.delete(taskId)
          } else if (
            // Stall guard: the worker has gone idle but never reported the task
            // done/failed. Most likely it finished and forgot the MCP call. Nudge
            // it once rather than leaving the pane occupied indefinitely.
            cur.paneAttention[paneId] === 'waiting' &&
            !nudgedRef.current.has(taskId) &&
            Date.now() - (dispatchedAtRef.current.get(taskId) ?? Date.now()) > STALL_MS
          ) {
            nudgedRef.current.add(taskId)
            inject(
              paneId,
              `[SwarmMind orchestrator] If task ${shortId(taskId)} is finished, call MCP task_update with status "done" and memory_write key "result:${taskId}". If you are blocked, call task_update with status "failed".`
            )
            cur.pushOrchestratorLog(`… nudged "${task.title}" (idle, still in progress)`)
          }
        }

        // Worker panes = running agent panes that aren't the lead.
        const workers: WorkerPane[] = leaves
          .filter(l => l.agentId && l.ptyStatus === 'running' && l.id !== leadPaneId)
          .map(l => ({ id: l.id, agentId: l.agentId as AgentId }))

        // ── 2. Lead decomposition (goal-driven runs) ────────────────────────
        const goal = cur.orchestratorGoal.trim()
        if (
          orchestratorPhase === 'running' &&
          leadPaneId &&
          goal &&
          decomposedGoalRef.current !== goal &&
          runningPaneIds.has(leadPaneId)
        ) {
          const workerAgents = Array.from(new Set(workers.map(w => w.agentId)))
          inject(leadPaneId, buildDecomposePrompt(goal, workerAgents))
          decomposedGoalRef.current = goal
          decomposeAtRef.current = Date.now()
          decomposeAttemptsRef.current = 1
          cur.pushOrchestratorLog('lead decomposing goal…')
          return // give the lead a tick to create tasks
        }

        // Decomposition watchdog: the lead was asked but no tasks have appeared.
        // Re-prompt once, then give up so a goal-driven run can't hang silently.
        if (
          orchestratorPhase === 'running' &&
          leadPaneId &&
          goal &&
          decomposedGoalRef.current === goal &&
          tasks.length === 0 &&
          decomposeAttemptsRef.current >= 1 &&
          decomposeAttemptsRef.current < 3 &&
          decomposeAtRef.current !== null &&
          Date.now() - decomposeAtRef.current > DECOMPOSE_TIMEOUT_MS
        ) {
          if (decomposeAttemptsRef.current === 1 && runningPaneIds.has(leadPaneId)) {
            const workerAgents = Array.from(new Set(workers.map(w => w.agentId)))
            inject(leadPaneId, buildDecomposePrompt(goal, workerAgents))
            decomposeAttemptsRef.current = 2
            decomposeAtRef.current = Date.now()
            cur.pushOrchestratorLog('lead produced no tasks — re-prompting…')
          } else {
            decomposeAttemptsRef.current = 3
            cur.pushOrchestratorLog('lead produced no tasks — giving up; create tasks manually')
          }
          return
        }

        // ── 2b. Review-completion sweep ─────────────────────────────────────
        // Free reviewer panes whose verdict has landed (task_review moved the
        // task to done=approved or pending=changes-requested), or whose pane died.
        for (const [paneId, taskId] of Array.from(reviewBindingRef.current)) {
          const task = byId.get(taskId)
          if (!task) { reviewBindingRef.current.delete(paneId); continue }
          if (task.status === 'done') {
            cur.pushOrchestratorLog(`✓ review approved "${task.title}"`)
            reviewBindingRef.current.delete(paneId)
          } else if (task.status === 'pending') {
            cur.pushOrchestratorLog(`✎ changes requested on "${task.title}" — re-queued`)
            reviewBindingRef.current.delete(paneId)
          } else if (!runningPaneIds.has(paneId)) {
            reviewBindingRef.current.delete(paneId)
          }
        }

        // ── 3. Dispatch ─────────────────────────────────────────────────────
        // Read paneTask fresh (completion sweep mutated it via async set()).
        const livePaneTask = useWorkspaceStore.getState().paneTask
        // A pane is occupied if it holds a dispatched task or is mid-review.
        const occupied = new Set([...Object.keys(livePaneTask), ...reviewBindingRef.current.keys()])
        // Tasks already dispatched (their `task_update`→in_progress IPC may still
        // be in flight) must not be grabbed again by another free pane.
        const activeTaskIds = new Set(Object.values(livePaneTask))
        const proposalPending = !!useWorkspaceStore.getState().orchestratorProposal

        const isFree = (w: WorkerPane) =>
          !occupied.has(w.id) && cur.paneAttention[w.id] !== 'working'

        const depsMet = (t: ConductorTask) => parseDeps(t.depends_on).every(d => doneIds.has(d))

        // The review gate engages only when a *distinct* second agent exists to
        // review (no self-review); otherwise workers report done directly.
        const canReview = new Set(workers.map(w => w.agentId)).size >= 2

        const pending = tasks
          .filter(t => t.status === 'pending' && !skippedRef.current.has(t.id) && !activeTaskIds.has(t.id) && depsMet(t))

        if (!(orchestrationMode === 'assisted' && proposalPending)) {
          for (const task of pending) {
            // Prefer a free worker matching the task's assigned agent; if the
            // task is unassigned, any free worker will do.
            const pane = workers.find(
              w => isFree(w) && (!task.assigned_agent || w.agentId === task.assigned_agent)
            )
            if (!pane) continue

            const proposal: DispatchProposal = {
              paneId: pane.id,
              taskId: task.id,
              title: task.title,
              agentId: pane.agentId,
              prompt: buildDispatchPrompt(task, canReview) + await composeContext(task),
            }

            if (orchestrationMode === 'auto') {
              dispatch(proposal)
              occupied.add(pane.id)      // claim the pane for the rest of this tick
              activeTaskIds.add(task.id) // and the task
            } else {
              // assisted — surface one proposal and wait for the user.
              useWorkspaceStore.getState().setOrchestratorProposal(proposal)
              break
            }
          }
        }

        // ── 3b. Review routing ──────────────────────────────────────────────
        // Assign each unreviewed `needs_review` task to a free worker of a
        // *different* agent than the author (no self-review). Runs in both auto
        // and assisted modes — review is lower-stakes than dispatch.
        const underReview = new Set(reviewBindingRef.current.values())
        const needingReview = tasks.filter(
          t => t.status === 'needs_review' && !underReview.has(t.id) && !skippedRef.current.has(t.id)
        )
        for (const task of needingReview) {
          const reviewer = workers.find(
            w => isFree(w) && w.agentId !== task.assigned_agent
          )
          if (!reviewer) continue
          inject(reviewer.id, buildReviewPrompt(task))
          reviewBindingRef.current.set(reviewer.id, task.id)
          occupied.add(reviewer.id)
          cur.pushOrchestratorLog(`⚖ review of "${task.title}" → ${reviewer.agentId}`)
          window.swarmmind
            .eventEmit('review', { taskId: task.id, title: task.title, verdict: 'assigned' }, reviewer.id, reviewer.agentId)
            .catch(() => {})
        }

        // ── 4. Lead synthesis ───────────────────────────────────────────────
        if (
          orchestratorPhase === 'running' &&
          leadPaneId &&
          hadTasksRef.current &&
          !synthesizedRef.current &&
          runningPaneIds.has(leadPaneId)
        ) {
          const openTasks = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'needs_review')
          if (tasks.length > 0 && openTasks.length === 0) {
            const doneTasks = tasks.filter(t => t.status === 'done')
            const results: { title: string; value: string }[] = []
            for (const t of doneTasks) {
              const v = await readResult(t.id)
              if (v) results.push({ title: t.title, value: v })
            }
            inject(leadPaneId, buildSynthesisPrompt(goal, results))
            synthesizedRef.current = true
            useWorkspaceStore.getState().setOrchestratorPhase('done')
            useWorkspaceStore.getState().pushOrchestratorLog('lead synthesising results…')
            window.swarmmind
              .eventEmit('synthesis', { goal, results: results.length }, leadPaneId)
              .catch(() => {})
          }
        }
      } finally {
        busyRef.current = false
      }
    }

    const handle = setInterval(tick, TICK_MS)
    return () => clearInterval(handle)
  }, [])

  // ── Persist the run log per workspace ───────────────────────────────────────
  // The orchestrator log is otherwise session-only; persisting it gives a
  // post-restart record of what the last run did. Stored as an app setting keyed
  // by workspace id: loaded when a workspace becomes active, saved (debounced) on
  // change. Loading is guarded so it only happens on a workspace *switch*, not on
  // every log mutation (which would clobber new entries with the saved copy).
  useEffect(() => {
    const key = (id: string) => `orchestratorLog:${id}`
    let loadedFor: string | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null

    const loadFor = async (id: string) => {
      loadedFor = id
      try {
        const raw = await window.swarmmind.getAppSetting(key(id))
        if (raw && useWorkspaceStore.getState().workspace?.id === id) {
          const arr = JSON.parse(raw) as OrchestratorLogEntry[]
          if (Array.isArray(arr)) useWorkspaceStore.setState({ orchestratorLog: arr })
        }
      } catch { /* ignore malformed/missing */ }
    }

    const initial = useWorkspaceStore.getState().workspace?.id
    if (initial) loadFor(initial)

    const unsub = useWorkspaceStore.subscribe((state, prev) => {
      const id = state.workspace?.id ?? null
      if (id && id !== loadedFor) {
        loadFor(id)
        return
      }
      if (id && id === loadedFor && state.orchestratorLog !== prev.orchestratorLog) {
        if (saveTimer) clearTimeout(saveTimer)
        const snapshot = state.orchestratorLog
        saveTimer = setTimeout(() => {
          window.swarmmind.setAppSetting(key(id), JSON.stringify(snapshot)).catch(() => {})
        }, 1000)
      }
    })

    return () => {
      if (saveTimer) clearTimeout(saveTimer)
      unsub()
    }
  }, [])
}
