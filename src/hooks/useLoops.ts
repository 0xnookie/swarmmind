import { useEffect } from 'react'
import { useWorkspaceStore, type PaneNode, type PaneLeaf, type SwarmLoop } from '../store/workspace'

// ── The Loop runner ─────────────────────────────────────────────────────────
//
// SwarmMind's "Claude Code loops": each loop is a saved schedule that re-injects
// a prompt into an agent pane every `intervalSec`. This hook (mounted once in
// App) runs a single timer that fires due loops, mirroring the conductor's
// inject-into-PTY mechanism — it spends zero model tokens; the panes do the work.
//
// Loops are persisted per workspace (app setting `loops:<workspaceId>`), loaded
// when a workspace becomes active and saved (debounced) on change, so a loop
// survives a restart. Pane ids are stable across restarts (the layout JSON keeps
// them), so a loop's target pane still resolves after relaunch.

const TICK_MS = 1000

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

// Inject a prompt and submit it, exactly like the conductor does.
function inject(paneId: string, text: string): void {
  window.swarmmind.ptyInput(paneId, text)
  window.swarmmind.ptyInput(paneId, '\r')
}

// Resolve a loop's live target panes: a specific running pane, or — when paneId
// is null — every running agent pane (broadcast).
function resolveTargets(loop: SwarmLoop, leaves: PaneLeaf[]): PaneLeaf[] {
  if (loop.paneId) {
    return leaves.filter(l => l.id === loop.paneId && l.ptyStatus === 'running')
  }
  return leaves.filter(l => l.ptyStatus === 'running' && l.agentId)
}

export function useLoops(): void {
  // ── The runner ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const st = useWorkspaceStore.getState()
      if (!st.workspace || st.loops.length === 0) return
      const now = Date.now()
      const leaves = collectLeaves(st.rootPane)

      for (const loop of st.loops) {
        if (!loop.enabled) continue
        if (loop.nextRunAt != null && now < loop.nextRunAt) continue

        const targets = resolveTargets(loop, leaves)
        if (targets.length === 0) {
          // No running target right now — retry on the next interval rather than
          // busy-looping every tick.
          st.deferLoop(loop.id, now)
          continue
        }
        for (const target of targets) inject(target.id, loop.prompt)
        st.markLoopRun(loop.id, now)
      }
    }

    const handle = setInterval(tick, TICK_MS)
    return () => clearInterval(handle)
  }, [])

  // ── Per-workspace persistence ────────────────────────────────────────────────
  // Mirrors the orchestrator-log persistence in useConductor: load the active
  // workspace's loops on switch, save (debounced) on change. Loading is guarded
  // so it only happens on an actual workspace switch, never clobbering live edits.
  useEffect(() => {
    const key = (id: string) => `loops:${id}`
    let loadedFor: string | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null

    const loadFor = async (id: string) => {
      loadedFor = id
      try {
        const raw = await window.swarmmind.getAppSetting(key(id))
        if (useWorkspaceStore.getState().workspace?.id !== id) return
        const arr = raw ? (JSON.parse(raw) as SwarmLoop[]) : []
        if (Array.isArray(arr)) {
          // The persisted countdown is meaningless after a restart — re-arm each
          // enabled loop for the upcoming tick so it resumes promptly.
          const restored = arr.map(l => ({ ...l, nextRunAt: l.enabled ? Date.now() : null }))
          useWorkspaceStore.getState().setLoops(restored)
        }
      } catch {
        useWorkspaceStore.getState().setLoops([])
      }
    }

    const initial = useWorkspaceStore.getState().workspace?.id
    if (initial) loadFor(initial)
    else useWorkspaceStore.getState().setLoops([])

    const unsub = useWorkspaceStore.subscribe((state, prev) => {
      const id = state.workspace?.id ?? null
      if (id && id !== loadedFor) {
        loadFor(id)
        return
      }
      if (!id) {
        // Workspace closed — drop loops so they don't leak into the next one.
        if (loadedFor !== null) { loadedFor = null; useWorkspaceStore.getState().setLoops([]) }
        return
      }
      if (id === loadedFor && state.loops !== prev.loops) {
        if (saveTimer) clearTimeout(saveTimer)
        const snapshot = state.loops
        saveTimer = setTimeout(() => {
          window.swarmmind.setAppSetting(key(id), JSON.stringify(snapshot)).catch(() => {})
        }, 800)
      }
    })

    return () => {
      if (saveTimer) clearTimeout(saveTimer)
      unsub()
    }
  }, [])
}
