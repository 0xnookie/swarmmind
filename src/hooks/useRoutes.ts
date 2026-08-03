import { useEffect, useRef } from 'react'
import { useWorkspaceStore, type PaneLeaf, type PaneNode } from '../store/workspace'
import { readPaneOutput } from './usePty'
import {
  buildRelayPrompt, emptyRelayMemo, hasRoutesFrom, markRelayed, planRelay, relayBody,
  type RelayMemo,
} from '../lib/canvasRoutes'

// ── Canvas routes: the impure shell ──────────────────────────────────────────
//
// An arrow drawn between two terminal cards on the canvas means "when this pane
// finishes a turn, hand what it said to that one". `src/lib/canvasRoutes.ts`
// decides *whether* and *what*; this hook is the part that watches, reads and
// injects.
//
// It is mounted once in App.tsx, not in CanvasMode, and that placement is the
// point. The board is a center overlay: opening the file panel, the Kanban board
// or the terminal grid unmounts it. Wiring that stopped delivering the moment
// you looked away from the picture of it would be worse than no wiring at all,
// because you would not be able to tell.
//
// The trigger is the same `pty:state` signal the conductor uses — a pane going
// working → waiting is "finished a turn". Everything that stops that from
// becoming an infinite loop of agents prompting each other (cooldown, quiet
// window after receiving, unchanged-body check) lives in the pure module and is
// unit-tested; this file must not add its own second opinion about it.

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

export function useRoutes() {
  const routes = useWorkspaceStore(s => s.paneRoutes)
  const attention = useWorkspaceStore(s => s.paneAttention)
  const rootPane = useWorkspaceStore(s => s.rootPane)

  // Previous attention snapshot — the transition, not the level, is the event.
  const prevRef = useRef<Record<string, 'working' | 'waiting'>>({})
  const memoRef = useRef<RelayMemo>(emptyRelayMemo())
  // Read inside the effect without making the effect depend on them: a route
  // set or a pane rename must not re-run the transition scan (it would see the
  // same "previous" map and re-fire whatever was pending).
  const routesRef = useRef(routes)
  routesRef.current = routes
  const rootRef = useRef(rootPane)
  rootRef.current = rootPane

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = attention
    const live = routesRef.current
    if (live.length === 0) return

    const leaves = collectLeaves(rootRef.current)
    const byId = new Map(leaves.map(l => [l.id, l]))
    const now = Date.now()

    for (const [paneId, state] of Object.entries(attention)) {
      // Only the edge into "waiting" — a pane that has been idle for ten
      // minutes has not just finished anything.
      if (state !== 'waiting' || prev[paneId] === 'waiting') continue
      if (!hasRoutesFrom(live, paneId)) continue
      // Note there is deliberately no `ptyStatus === 'running'` check on the
      // source. `PaneLeaf.ptyStatus` is a renderer-side mirror written by
      // whichever code path spawned the pty, whereas the transition being
      // handled here came from the pty itself — it is the stronger evidence of
      // the two, and demanding the weaker one as well can only produce false
      // negatives (a pane that is plainly running, silently never relaying).
      const source = byId.get(paneId)
      if (!source) continue

      const body = relayBody(readPaneOutput(paneId, 6000))
      const planned = planRelay(live, paneId, body, memoRef.current, now)
      if (planned.length === 0) continue

      const label = source.title?.trim() || source.agentId || paneId.slice(0, 6)
      const prompt = buildRelayPrompt(label, body)
      const delivered = planned.filter(relay => {
        const target = byId.get(relay.to)
        // A pane that has *explicitly* died can't be typed into; skipping it
        // (rather than dropping the whole relay) keeps a three-way fan-out
        // working when one of the three has exited, and it is deliberately not
        // recorded as sent, so the pane that comes back still hears the next
        // turn. The test is for a dead status rather than for a live one for
        // the same reason as above: an absent "running" is not evidence of
        // death, and treating it as such loses real turns.
        if (!target || target.ptyStatus === 'exited' || target.ptyStatus === 'error') return false
        window.swarmmind.ptyInput(relay.to, prompt)
        window.swarmmind.ptyInput(relay.to, '\r')
        void window.swarmmind
          .eventEmit('message', { from: paneId, to: relay.to, via: 'canvas-route' }, relay.to, target.agentId ?? undefined)
          .catch(() => {})
        return true
      })
      if (delivered.length > 0) {
        memoRef.current = markRelayed(memoRef.current, paneId, delivered, now)
      }
    }
  }, [attention])
}
