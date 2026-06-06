# SwarmMind Upgrade Roadmap — "the best vibe/AI coding app"

The thesis: move SwarmMind from *"N terminals side by side with a shared scratchpad"*
to *"a single situational-awareness surface over a swarm"* — what changed, who's doing
what, what's contended, what it cost, and can I trust it. The terminals stay (raw CLI
access is the moat); they become a drill-down, not the thing you stare at.

Everything below is sequenced so each phase is a complete vertical slice and the
foundation (Phase 1) is the substrate the rest read from. `npm run typecheck` must stay
green at every step.

---

## Phase 1 — Event Bus + Swarm Timeline + Cost Meter ✅ IMPLEMENTED

The substrate. One ordered, append-only log of everything the swarm does; the timeline
and cost meter are its first two consumers. Phases 2–5 all emit into / read from it.

### Data model
`events` table in the per-workspace DB (`memory/db.ts` `WORKSPACE_SCHEMA`):

```
events(id, workspace_id, ts, type, agent_id, pane_id, payload, created_at)
index idx_events_ts (workspace_id, ts)
```

`payload` is a JSON blob whose shape depends on `type`. Event types:
`memory_write · task_create · task_update · task_note · message · agent_spawn ·
agent_exit · agent_question · dispatch · synthesis · cost`.

### Module — `memory/events.ts`
- `eventEmit(workspaceId, type, { agentId, paneId, payload, ts })` — INSERT + notify
  in-process subscribers. Best-effort, never throws (logging must not break the action).
- `eventList(workspaceId, { sinceTs, limit, types })` — newest-N window, returned
  oldest→newest for the feed.
- `onEventEmitted(cb)` — in-process pub/sub the main process uses to push to renderer.
- `eventPrune(workspaceId, keep=5000)` — called from `openWorkspaceDir` so the log is
  bounded.

### Emitters
- **MCP tools** (`mcp/tools.ts`): every mutating tool tees an event, attributed to the
  calling agent via `extra.agentId`.
- **PTY manager** (`electron/pty-manager.ts`): `agent_spawn` / `agent_exit` /
  `agent_question`; plus the **cost meter** — `parseCostUsd()` scans the ANSI-stripped
  output tail for a cumulative spend figure (conservative patterns: amounts attached to
  "cost" or written with cents) and emits a `cost` event whenever it advances.
- **Conductor** (`src/hooks/useConductor.ts`): `dispatch` and `synthesis` via the
  `events:emit` IPC.

### Transport
`electron/ipc/events.ts`: `events:list` (pull), `events:emit` (renderer→main), and a
`swarm:event` push channel forwarding every emitted event live. Exposed on
`window.swarmmind` as `eventsList` / `eventEmit` / `onSwarmEvent`.

### UI
- `src/components/SwarmTimeline.tsx` — center overlay (mutually exclusive with
  board/graph/review/file). Loads the recent log, appends live, agent filter chips,
  color-coded via the `--agent-*` tokens, per-event glyph + summary + relative time.
- Store: `timelineOpen` + `toggleTimeline`; `paneCost` + `updatePaneCost`.
- `TopBar`: timeline toggle (activity glyph) + a `$X.XX` cost pill summing `paneCost`.
  Cost aggregation is wired globally in `App.tsx` so the pill updates even when the
  timeline is closed.

---

## Phase 2 — File-change awareness + contention (shared world model) ✅ IMPLEMENTED

Two agents refactoring the same file in parallel should not discover it at merge time.

### Main process — `electron/file-watcher.ts`
- A per-pane recursive watcher (**Node's built-in `fs.watch({ recursive: true })`**, not
  chokidar — no new dependency; works on win32/macOS, degrades to no-awareness elsewhere).
  Started in `ptyCreate`, stopped in `ptyKill`/`onExit`/`killAll`. Self-filters noise
  (`.git`, `node_modules`, `.swarmmind`, build dirs, temp/lock files) and debounces bursts.
- On change → `eventEmit(..., 'file_changed', { path })` — rides the Phase 1 bus, so it
  shows in the timeline for free.
- In-memory `Map<path, Map<paneId, ts>>` with a 90s window. A path touched by ≥2 active
  panes emits a `contention` event (60s cooldown so it doesn't spam).

### MCP
- `file_intent(paths[], note?)` — an agent announces files it's about to edit. Implemented
  **event-only** (`eventEmit(..., 'file_intent', …)`); it surfaces in the timeline and the
  Changes panel. *Deliberately not wired into conductor dispatch-skip:* tasks carry no
  file-set metadata, so "overlap" can't be computed cleanly from the task model. The
  actual-conflict case is covered by `contention` (two agents truly touching one file).
  A future task-level file-set field would enable the predictive skip.

### UI
- `ChangesPanel.tsx` — a center overlay (store `changesOpen`/`toggleChanges`) that
  aggregates `file_changed`/`contention`/`file_intent` events into a per-file view:
  basename + path, per-agent color dots (filled = changed, ringed = declared intent),
  change count, last-changed time. Contended files are red-flagged and floated to the top.
  Event-sourced — no extra IPC.
- Store `contendedPaths` (set globally from `contention` events in `App.tsx`); TopBar
  Changes button shows a red dot while contention is unacknowledged, cleared on open.
- *Deferred:* diff-on-click (lifting `WorktreeReview`'s diff renderer into a shared
  `DiffView`) — the awareness/contention surface is the high-value core; full per-file
  diff drill-down is a follow-up.

---

## Phase 3 — Checkpoints & Rewind (time travel) ✅ IMPLEMENTED

The fearless-undo that makes `auto` orchestration actually usable.

### Snapshots — `git-manager.ts`
- `snapshotWorkspace(root, id)` snapshots the main checkout **and** every SwarmMind
  worktree without disturbing any working tree. Per directory: stage the working tree
  (tracked + untracked, respecting .gitignore) into a **throwaway index via
  `GIT_INDEX_FILE`** (kept outside the repo so it leaves no trace) → `git write-tree` →
  `git commit-tree` (parented on HEAD) → pin under `refs/swarmmind/checkpoints/<id>-<n>`
  so GC can't reclaim it. Plumbing validated against a live repo before shipping.
- `checkpoints` table (per-workspace DB): `id, ts, label, trigger, trees_json`
  (`trees_json` = array of `{ path, commit, head }`). Queries in `queries.ts`.
- Auto-checkpoint triggers: on orchestration run start (in `useConductor`, fire-and-
  forget) and a manual "📍 Snapshot now" button. (Per-dispatch checkpointing was dropped
  as too noisy — run-start + manual covers the rewind need without a checkpoint per task.)

### Restore — `restoreWorkspace(trees)`
- Per recorded dir: `git read-tree -u --reset <commit>` then `git clean -fdq` (respects
  .gitignore, so `.swarmmind` / memory.db / scrollback survive). Destructive by design.
- **Safety net:** `checkpoint:restore` auto-snapshots current state as a "Before rewind"
  checkpoint first, so a rewind is itself undoable. UI also `window.confirm`s.

### UI
- `CheckpointPanel.tsx` — center overlay (store `checkpointsOpen`): list of checkpoints
  (label, trigger, dir count, relative time) with Rewind / delete, plus a labelled
  "Snapshot now". TopBar rewind-clock toggle. IPC `checkpoint:create/list/restore/delete`.

---

## Phase 4 — Semantic memory + context compiler (the intelligence jump) ✅ IMPLEMENTED

Make the shared memory queryable by relevance, and stop dispatching workers cold.

### Search — `queries.ts` `memorySearch(workspaceId, query, k, agentId?)`
- A **lexical TF·IDF ranker** over memory entries (key weighted ×3 over value, IDF across
  the corpus, gentle recency tiebreak). Zero-dependency and dependable.
- *Scope call:* the original spec proposed `sqlite-vec` + embeddings for true semantic
  search. That needs a native extension binary (unverifiable in this build sandbox) and
  the MCP server (main process) can't reach the renderer-side embedding model across the
  process boundary cleanly. The lexical ranker ships now behind the **same signature**, so
  a vector backend can replace the internals later without touching callers. This is the
  documented upgrade path, not a different design.

### MCP — `memory_search(query, k?, agent_id?)`
- Ranked search tool so agents find what the swarm already knows instead of re-discovering.

### Context compiler — `useConductor.ts` `composeContext(task)`
- Before dispatch, assembles a compact single-line context block appended to the worker's
  prompt: the task's **dependency results** (actual values, not just key hints) + the
  top-3 **relevant memory entries** (via `memorySearch`), each flattened to one line and
  budget-truncated. A few cheap lookups save the worker a lot of exploration tokens.

---

## Phase 5 — Trust: review gate ✅ IMPLEMENTED

Author and review as separate passes, enforced by the orchestrator (mirrors the repo's
own `.claude/CLAUDE.md` rule: never self-approve).

### Model
- `tasks.status` gains `needs_review`. Migration recreates the table with the widened
  CHECK constraint (detects the old constraint in `sqlite_master`, rebuilds preserving
  rows); the FK-strip recreate SQL and `WORKSPACE_SCHEMA` were updated to match.
  `TaskStatus` (queries), `ConductorTask` (conductor) and `KanbanTask` unions all widened.
- `task_review(id, verdict, comment?)` MCP tool: `approve` → `done`; `reject` → `pending`
  with the comment appended as a note. Emits a `review` event.

### Conductor — review routing in `useConductor.ts`
- The dispatch prompt tells a worker to report `needs_review` instead of `done` **when a
  distinct second agent is available** (`canReview` = ≥2 distinct worker agents) — so the
  gate engages without ever stalling a single-agent run (which reports `done` directly).
- A `needs_review` task is routed to a free worker of a **different agent** than the
  author (no self-review), tracked in `reviewBindingRef`. On verdict: approve → `done`
  frees the reviewer; reject → `pending` re-enters normal dispatch so the author revises.
- `needs_review` counts as an open task, so lead synthesis waits for reviews to resolve.

### UI
- Kanban board gains a **Review** column between In Progress and Done; the `review` event
  renders in the timeline. (A dedicated PR-style `ReviewCard` with inline diff is the
  natural follow-up; the Kanban column + MCP verdict tool is the working core.)

---

## Cross-cutting foundations (do alongside, not after)

1. **Primitive component layer** — `components/ui/{Button,Surface,IconButton,Badge}.tsx`
   consuming the design tokens once, correctly. Kills the recurring "wrong colors on a
   theme" class of bug and makes every panel above fast to build consistently.
2. **Event-driven conductor** — once Phase 1's bus exists, the conductor subscribes to
   `onSwarmEvent` instead of re-polling `taskList` every tick: lower latency, scales.
3. **Orchestration unit tests** — the dependency-resolution / retry / stall logic in
   `useConductor.ts` is pure-ish and is exactly where a silent autonomy regression would
   hide. A dozen tests over "given tasks + states, what dispatches next" de-risks every
   future change (typecheck is currently the only gate).
4. **Session export** — because the timeline is event-sourced, a shareable/replayable
   "here's what the swarm did" artifact falls out of `eventList` almost for free.

---

## Vibe layer (cheap, high-delight; after the surface exists)
- Ambient audio cues for finished / needs-you / contention (attach to existing signals).
- Agent presence: per-pane avatar + animated state (reuse `status-pulse`).
- Focus mode: auto-spotlight the pane that just went `agent_question`.
- Swarm recipes: one-click templates ("1 lead + 2 workers + 1 reviewer") that pre-wire
  panes, worktrees, and the review gate.
- Voice orchestration: extend SwarmVoice from dictation to commands routed at the
  OrchestratorBar goal.
