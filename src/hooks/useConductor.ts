import { useEffect, useRef } from 'react'
import {
  useWorkspaceStore,
  type AgentId,
  type PaneNode,
  type PaneLeaf,
  type DispatchProposal,
  type OrchestratorLogEntry,
} from '../store/workspace'
import {
  type ConductorTask,
  parseDeps,
  shortId,
  truncate,
  oneLine,
  canReview,
  buildDispatchPrompt,
  buildReviewPrompt,
  buildDecomposePrompt,
  buildSynthesisPrompt,
  buildNudgePrompt,
  sweepAction,
  decomposeAction,
  reviewSweepAction,
  planDispatches,
  planReviews,
  readyForSynthesis,
  planMessageDelivery,
  isWakeEvent,
} from '../lib/conductor'

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
//
// Every per-tick decision (sweep, watchdog, dispatch/review matching, synthesis
// gate, message routing) is a pure function in src/lib/conductor.ts, unit-tested
// in tests/lib-units.mts. This hook is only the impure shell: store access, IPC,
// PTY injection, timers.
//
// SCHEDULING IS EVENT-DRIVEN. The tick is an idempotent reconciler, so *when*
// it runs is purely a latency/efficiency question. It wakes on (a) swarm-bus
// events that can change a decision — `isWakeEvent` in conductor.ts: task
// changes, messages, result writes, pane spawn/exit — and (b) store changes to
// pane attention/layout/orchestration state; wakes are coalesced through a
// short debounce so a burst (the lead creating five tasks) costs one tick, not
// five. A slow heartbeat remains ONLY for the time-based watchdogs (worker
// stall, decomposition timeout), which no event announces. Compared to the old
// fixed 1.5s poll this reacts in ~150ms instead of up-to-1.5s, and an idle
// swarm costs one cheap tick per 5s instead of a taskList round-trip per 1.5s.

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

// Debounce for event-triggered wakes: long enough to coalesce a burst (a lead
// creating several tasks back-to-back), short enough to feel instant.
const COALESCE_MS = 150
// Fallback heartbeat. Exists only for the time-based watchdogs (STALL_MS,
// DECOMPOSE_TIMEOUT_MS) — everything else is woken by events. Its granularity
// bounds watchdog latency, so keep it well under those timeouts.
const HEARTBEAT_MS = 5000

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
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
// so agents can hand off even during purely manual coordination.
async function deliverMessages(): Promise<void> {
  let pending: AgentMessage[]
  try {
    pending = await window.swarmmind.messagesUndelivered()
  } catch {
    return
  }
  if (!pending.length) return

  const st = useWorkspaceStore.getState()
  // Mixed-workspace panes belong to another workspace's swarm; this workspace's
  // directed messages must not be delivered into them.
  const panes = collectLeaves(st.rootPane)
    .filter(l => !l.workspaceId)
    .map(l => ({
      id: l.id,
      agentId: l.agentId,
      running: l.ptyStatus === 'running',
      working: st.paneAttention[l.id] === 'working',
    }))

  for (const { message, pane } of planMessageDelivery(pending, panes)) {
    inject(pane.id, `[SwarmMind message from ${message.from_agent}] ${message.body}`)
    await window.swarmmind.messageMarkDelivered(message.id).catch(() => {})
    st.pushOrchestratorLog(`✉ ${message.from_agent} → ${message.to_agent}: ${truncate(message.body, 60)}`)
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
    // Event-driven scheduling state (see the module comment). `tickTimer` holds
    // the one coalesced pending wake; `pendingWhileBusy` remembers a wake that
    // arrived mid-tick so nothing is ever dropped (the tick re-runs once after).
    let tickTimer: ReturnType<typeof setTimeout> | null = null
    let pendingWhileBusy = false
    let disposed = false

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
        if (tasks.length > 0) hadTasksRef.current = true

        // Re-read state — taskList awaited above may have raced a UI change.
        const cur = useWorkspaceStore.getState()
        // Exclude mixed-workspace panes — the conductor dispatches this
        // workspace's tasks and must not drive an agent that belongs to another.
        const leaves = collectLeaves(cur.rootPane).filter(l => !l.workspaceId)
        const runningPaneIds = new Set(
          leaves.filter(l => l.ptyStatus === 'running').map(l => l.id)
        )
        const workingPaneIds = new Set(
          leaves.filter(l => cur.paneAttention[l.id] === 'working').map(l => l.id)
        )

        // ── 1. Completion sweep ─────────────────────────────────────────────
        for (const [paneId, taskId] of Object.entries(cur.paneTask)) {
          const task = byId.get(taskId)
          const action = sweepAction({
            task,
            retries: retryCountRef.current.get(taskId) ?? 0,
            maxRetries: MAX_RETRIES,
            paneRunning: runningPaneIds.has(paneId),
            paneWaiting: cur.paneAttention[paneId] === 'waiting',
            alreadyNudged: nudgedRef.current.has(taskId),
            dispatchedAt: dispatchedAtRef.current.get(taskId),
            now: Date.now(),
            stallMs: STALL_MS,
          })
          if (action === 'none') continue

          if (action === 'nudge') {
            nudgedRef.current.add(taskId)
            inject(paneId, buildNudgePrompt(taskId))
            cur.pushOrchestratorLog(`… nudged "${task!.title}" (idle, still in progress)`)
            continue
          }

          // Every remaining action frees the pane.
          if (action === 'free_done') {
            const result = await readResult(taskId)
            cur.pushOrchestratorLog(
              `✓ "${task!.title}" done${result ? ` — ${truncate(result, 80)}` : ''}`
            )
          } else if (action === 'retry') {
            // Retry transient failures by resetting the task to pending so it can
            // be re-dispatched (to any matching free worker) on a later tick.
            const attempts = retryCountRef.current.get(taskId) ?? 0
            retryCountRef.current.set(taskId, attempts + 1)
            window.swarmmind.taskUpdate(taskId, 'pending').catch(() => {})
            cur.pushOrchestratorLog(`↻ retrying "${task!.title}" (attempt ${attempts + 2})`)
          } else if (action === 'give_up') {
            const attempts = retryCountRef.current.get(taskId) ?? 0
            cur.pushOrchestratorLog(`✗ "${task!.title}" failed after ${attempts + 1} attempt(s) — needs attention`)
          } else if (action === 'free_for_review') {
            // Author delivered the work and submitted it for review — free their
            // pane; the review-routing pass below assigns a different agent to it.
            cur.pushOrchestratorLog(`⚖ "${task!.title}" submitted for review`)
          } else if (action === 'free_pane_exited') {
            // The agent process died mid-task — free the pane so work can be
            // re-dispatched (the task stays in_progress for the user to review).
            cur.pushOrchestratorLog(`⚠ pane for "${task!.title}" exited`)
          }
          cur.setPaneTask(paneId, null)
          dispatchedAtRef.current.delete(taskId)
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
        if (orchestratorPhase === 'running' && leadPaneId && goal && decomposedGoalRef.current === goal) {
          const watchdog = decomposeAction({
            attempts: decomposeAttemptsRef.current,
            askedAt: decomposeAtRef.current,
            now: Date.now(),
            timeoutMs: DECOMPOSE_TIMEOUT_MS,
            taskCount: tasks.length,
            leadRunning: runningPaneIds.has(leadPaneId),
          })
          if (watchdog === 'reprompt') {
            const workerAgents = Array.from(new Set(workers.map(w => w.agentId)))
            inject(leadPaneId, buildDecomposePrompt(goal, workerAgents))
            decomposeAttemptsRef.current = 2
            decomposeAtRef.current = Date.now()
            cur.pushOrchestratorLog('lead produced no tasks — re-prompting…')
            return
          }
          if (watchdog === 'give_up') {
            decomposeAttemptsRef.current = 3
            cur.pushOrchestratorLog('lead produced no tasks — giving up; create tasks manually')
            return
          }
        }

        // ── 2b. Review-completion sweep ─────────────────────────────────────
        // Free reviewer panes whose verdict has landed (task_review moved the
        // task to done=approved or pending=changes-requested), or whose pane died.
        for (const [paneId, taskId] of Array.from(reviewBindingRef.current)) {
          const task = byId.get(taskId)
          const verdict = reviewSweepAction(task, runningPaneIds.has(paneId))
          if (verdict === 'none') continue
          if (verdict === 'approved') cur.pushOrchestratorLog(`✓ review approved "${task!.title}"`)
          if (verdict === 'rejected') cur.pushOrchestratorLog(`✎ changes requested on "${task!.title}" — re-queued`)
          reviewBindingRef.current.delete(paneId)
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

        // The review gate engages only when a *distinct* second agent exists to
        // review (no self-review); otherwise workers report done directly.
        const reviewable = canReview(workers)

        if (!(orchestrationMode === 'assisted' && proposalPending)) {
          const planned = planDispatches({
            tasks,
            workers,
            occupiedPaneIds: occupied,
            workingPaneIds,
            activeTaskIds,
            skippedTaskIds: skippedRef.current,
            // assisted — surface one proposal at a time and wait for the user.
            limit: orchestrationMode === 'assisted' ? 1 : undefined,
          })
          for (const { task, worker } of planned) {
            const proposal: DispatchProposal = {
              paneId: worker.id,
              taskId: task.id,
              title: task.title,
              agentId: worker.agentId,
              prompt: buildDispatchPrompt(task, reviewable) + await composeContext(task),
            }
            if (orchestrationMode === 'auto') {
              dispatch(proposal)
              occupied.add(worker.id) // claim the pane for the review pass too
            } else {
              useWorkspaceStore.getState().setOrchestratorProposal(proposal)
            }
          }
        }

        // ── 3b. Review routing ──────────────────────────────────────────────
        // Assign each unreviewed `needs_review` task to a free worker of a
        // *different* agent than the author (no self-review). Runs in both auto
        // and assisted modes — review is lower-stakes than dispatch.
        const reviews = planReviews({
          tasks,
          workers,
          occupiedPaneIds: occupied,
          workingPaneIds,
          underReviewTaskIds: new Set(reviewBindingRef.current.values()),
          skippedTaskIds: skippedRef.current,
        })
        for (const { task, worker } of reviews) {
          inject(worker.id, buildReviewPrompt(task))
          reviewBindingRef.current.set(worker.id, task.id)
          cur.pushOrchestratorLog(`⚖ review of "${task.title}" → ${worker.agentId}`)
          window.swarmmind
            .eventEmit('review', { taskId: task.id, title: task.title, verdict: 'assigned' }, worker.id, worker.agentId)
            .catch(() => {})
        }

        // ── 4. Lead synthesis ───────────────────────────────────────────────
        if (
          orchestratorPhase === 'running' &&
          leadPaneId &&
          hadTasksRef.current &&
          !synthesizedRef.current &&
          runningPaneIds.has(leadPaneId) &&
          readyForSynthesis(tasks)
        ) {
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
      } finally {
        busyRef.current = false
      }
    }

    const runScheduled = async () => {
      tickTimer = null
      if (disposed) return
      if (busyRef.current) {
        // A tick is mid-flight; run once more when it finishes so the wake that
        // fired during it is honoured.
        pendingWhileBusy = true
        return
      }
      await tick()
      if (pendingWhileBusy && !disposed) {
        pendingWhileBusy = false
        schedule(0)
      }
    }

    const schedule = (delay = COALESCE_MS) => {
      if (disposed) return
      if (busyRef.current) {
        pendingWhileBusy = true
        return
      }
      if (tickTimer) return // a wake is already pending — coalesce
      tickTimer = setTimeout(() => void runScheduled(), delay)
    }

    // (a) Swarm-bus events: task/message/memory/pane changes wake the loop.
    const unsubEvents = window.swarmmind.onSwarmEvent((ev) => {
      if (ev && isWakeEvent(ev.type)) schedule()
    })

    // (b) Renderer state the tick's decisions read: pane attention (a worker
    // going `waiting` gates dispatch and stall-nudges), the pane tree (spawn/
    // exit/status), and the orchestration controls themselves.
    const unsubStore = useWorkspaceStore.subscribe((s, prev) => {
      if (
        s.paneAttention !== prev.paneAttention ||
        s.rootPane !== prev.rootPane ||
        s.orchestrationMode !== prev.orchestrationMode ||
        s.orchestratorPhase !== prev.orchestratorPhase ||
        s.orchestratorProposal !== prev.orchestratorProposal ||
        s.orchestratorGoal !== prev.orchestratorGoal ||
        s.leadPaneId !== prev.leadPaneId ||
        s.workspace !== prev.workspace
      ) {
        schedule()
      }
    })

    // (c) Heartbeat for the time-based watchdogs only.
    const heartbeat = setInterval(() => schedule(0), HEARTBEAT_MS)
    schedule(0) // initial reconcile on mount

    return () => {
      disposed = true
      clearInterval(heartbeat)
      unsubEvents()
      unsubStore()
      if (tickTimer) clearTimeout(tickTimer)
    }
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
