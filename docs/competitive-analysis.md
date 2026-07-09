# Competitive analysis — SwarmMind vs Cursor & BridgeMind

Honest, maintained assessment of where SwarmMind stands on the "vibecoding"
surface against the two reference products. Kept in-repo so feature work is
measured against a concrete bar, not a vibe. Update it when a row changes.

Legend: ✅ shipped · 🟡 partial · ⬜ not yet · ⭐ SwarmMind differentiator

## In-editor AI (the core vibecoding loop)

| Capability | SwarmMind | Cursor | Notes |
|---|---|---|---|
| Inline edit (Cmd/Ctrl-K) | ✅ | ✅ | Streamed result, in-doc highlight, **diff preview in the accept/reject widget**, regenerate |
| @-mention file context in edits | ✅ | ✅ | Fuzzy file picker (shared `fuzzyRank`) |
| Tab ghost-text autocomplete | ✅ | ✅ | **Multi-line** (inline head + block tail), accept-all (Tab), **accept-word (Ctrl/Cmd-→)**, request-gated mid-token, **suffix de-dup** |
| Multi-file edit (Composer) | ✅ | ✅ | Strict-JSON plan, per-file **word-level diffs**, checkpoint-on-apply |
| AI diagnostics / fix | ✅ | ✅ | Lint gutter + "Fix with AI" → inline-edit flow |
| Rename symbol (F2) across files | ✅ | 🟡 | Routes through Composer preview/apply |
| Codebase-aware chat | ✅ | ✅ | SwarmAgent: search_code/read_file/list_files tools |
| Next-edit prediction ("Tab to jump") | ✅ | ✅ | After an accepted inline edit, predicts the next location; **Tab** chip jumps + reopens inline-edit prefilled. Pure `nextEdit.ts` validator (unit-tested) |
| Inline chat-to-diff "apply" | ✅ | ✅ | File-targeted code blocks in a SwarmAgent reply get a **Review & apply** button → routes the exact blocks into the Composer's diff/checkpoint/apply pipeline (no re-prompt). Pure `codeBlocks.ts` extractor (unit-tested) |
| Semantic/embedding codebase index | ✅ | ✅ | **Hybrid auto-context**: Composer "Suggest relevant" greps the instruction's terms, then ranks matches with **BM25 + on-device embeddings** (`Xenova/all-MiniLM-L6-v2` via transformers.js, key-free, disk-cached) fused by reciprocal-rank fusion. Pure vector math + RRF in `retrieval.ts` (unit-tested); embedding runtime in `embed.ts`. Lexical-only fallback when the model isn't warm/offline |
| Agent-mode iteration (run + self-correct) | ✅ | ✅ | **Verify→fix loop** in the Composer: after applying, run one of the workspace's **own npm scripts** (constrained runner — allowlist + charset-validated, execFile no-shell); on failure, one click feeds the error summary back to the model — or, with the opt-in **Auto-fix** toggle, the loop runs autonomously (fix → apply → re-verify, bounded to 3 rounds by the unit-tested `verifyLoopStatus`, all covered by the one apply-time checkpoint). Off by default. Pure control logic in `verify.ts` (unit-tested) |
| Agentic chat that edits (chat → applyable diffs) | ✅ | ✅ | SwarmAgent's **`propose_edits` tool**: the chat assistant reads the code (search_code/read_file), then hands a full change plan to the Composer's diff/checkpoint/apply/verify pipeline. Nothing writes until the user applies — Cursor's agent mode, but on SwarmMind's reversibility rails |
| Terminal→editor bridge (clickable path:line) | ✅ | ✅ | File references in agent terminal output (`src/foo.ts:12`, `D:\x\y.py(3,1)`) are validated against the FS and **Ctrl/Cmd+Click** opens the file at that line in the editor. Pure matcher `terminalLinks.ts` (unit-tested), resolves against worktree → pane cwd → root |
| Fresh semantic index while agents work | ✅ | ⬜ | The vector index **re-embeds just the touched files** on the file-watcher's `file_changed` events (debounced, capped, write-locked against full rebuilds). Cursor's index doesn't watch other agents' edits; ours does. Pure merge/plan logic `indexUpdate.ts` (unit-tested) |

## Differentiators SwarmMind has and Cursor/BridgeMind do not

| Capability | SwarmMind | Why it matters |
|---|---|---|
| ⭐ Multiple CLI agents side-by-side | ✅ | Run Claude Code / Codex / etc. in resizable panes at once |
| ⭐ Autonomous Conductor + Lead orchestration | ✅ | Decompose a goal → dispatch tasks across panes → synthesize, zero model tokens in the loop |
| ⭐ Shared MCP memory between agents | ✅ | Agents exchange context/results via a per-workspace MCP server |
| ⭐ Per-pane git worktree isolation + review/merge | ✅ | Each agent on its own branch; diff, commit, merge from the UI |
| ⭐ Desktop chat widget (tray/minimized) | ✅ | Assistant reachable when the main window is hidden |
| ⭐ Whole-workspace checkpoints | ✅ | Git-snapshot rollback for risky changes |
| ⭐ Swarm recipes | ✅ | One-click templates (Builder+Reviewer, Lead+2 workers, full swarm…) that pre-wire panes, titles, worktrees, the lead pane and the orchestration mode (`recipes.ts`, unit-tested; OrchestratorBar dropdown) |
| ⭐ Dev-server auto-detect → built-in preview | ✅ | An agent starts a dev server → its announced URL is detected in the output (`devServerUrl.ts`, unit-tested), badged on the TopBar and one click away in the preview browser |
| ⭐ Review gate with human ReviewCard | ✅ | `needs_review` tasks get Approve / Request-changes / View-changes (worktree diff) right on the Kanban card; verdicts emit `review` events like agent reviews |
| ⭐ Changes panel diff drill-down | ✅ | Click any file in the live change feed → its git diff (worktree-aware), rendered by the shared `UnifiedDiff`; "Open" jumps into the editor |
| ⭐ Focus mode + ambient audio cues | ✅ | Opt-in: auto-spotlight the pane that just asked a question; quiet WebAudio pings for needs-you / turn-done / contention (rate-limited) |

## Engineering quality bar

| | SwarmMind |
|---|---|
| Type gate | `npm run typecheck` clean (two tsconfig projects) |
| Pure-logic unit tests | `npm test` — 160 assertions over pure modules (incl. `nextEdit`, `codeBlocks`, `retrieval` lexical+vector, `verify`, `conductor` orchestration decisions, `terminalLinks`, `indexUpdate`, `devServerUrl`, `recipes`), no build step |
| Constrained exec | `verify:run` only runs the workspace's declared npm scripts (allowlist + strict charset), execFile without a shell — no arbitrary command surface |
| Boot/integration | `npm run smoke`, `node tests/editor-verify.mjs` (Playwright on the built app) |
| Spawn safety | HMAC-signed agent config, shell-quoted argv, per-workspace MCP token |

## Honest gaps / next targets (priority order)

1. ~~**Next-edit prediction**~~ — ✅ shipped: after an accepted inline edit,
   predict and Tab-jump to the next location (the defining Cursor Tab feature).
2. ~~**One-click apply from chat**~~ — ✅ shipped: file-targeted code blocks in a
   reply get a "Review & apply" button that reuses the Composer's diff/apply UI.
3. ~~**Semantic codebase index**~~ — ✅ shipped: hybrid BM25 + on-device embedding
   retrieval (RRF) powers Composer auto-context. Next refinement: persist a
   workspace-wide vector index so retrieval isn't bounded to grep candidates.
4. ~~**Agent-mode iteration**~~ — ✅ shipped: opt-in autonomous verify→fix
   (auto-run a workspace npm script → auto-fix → re-verify, bounded to 3 rounds,
   one apply-time checkpoint covers the whole loop). Off by default.
5. ~~**Incremental semantic index**~~ — ✅ shipped: `file_changed` events re-embed
   just the touched files (debounced, capped, write-locked), so retrieval stays
   fresh while the swarm works.
6. ~~**Terminal→editor bridge**~~ — ✅ shipped: validated `path:line` links in
   every terminal, Ctrl/Cmd+Click opens the file at that line in the editor.
7. ~~**Shared DiffView**~~ — ✅ shipped as `UnifiedDiff.tsx` (WorktreeReview,
   ChangesPanel drill-down, Kanban ReviewCard all render the same component).
8. **LSP integration** — real go-to-definition/hover/diagnostics in the editor
   (big lift; AI diagnostics + typecheck-as-verify cover most value today).
9. **Session export** — the timeline is event-sourced, so a shareable/replayable
   "here's what the swarm did" artifact falls out of `eventList` almost for free.
10. **Event-driven conductor** — subscribe to `onSwarmEvent` instead of polling
   `taskList` each tick: lower latency, scales with pane count.

This file is a living scorecard, not a marketing claim: "best" is earned row by
row. The in-editor AI table is at parity row-for-row (plus a freshness edge
Cursor lacks); the remaining targets are depth (LSP) and shareability (export).
