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
| Agent-mode iteration (run + self-correct) | 🟡 | ✅ | **Verify→fix loop** in the Composer: after applying, run one of the workspace's **own npm scripts** (constrained runner — allowlist + charset-validated, execFile no-shell) and, on failure, one click feeds the error summary back to the model to fix its change. Human-in-the-loop, not yet fully autonomous. Pure control logic in `verify.ts` (unit-tested) |

## Differentiators SwarmMind has and Cursor/BridgeMind do not

| Capability | SwarmMind | Why it matters |
|---|---|---|
| ⭐ Multiple CLI agents side-by-side | ✅ | Run Claude Code / Codex / etc. in resizable panes at once |
| ⭐ Autonomous Conductor + Lead orchestration | ✅ | Decompose a goal → dispatch tasks across panes → synthesize, zero model tokens in the loop |
| ⭐ Shared MCP memory between agents | ✅ | Agents exchange context/results via a per-workspace MCP server |
| ⭐ Per-pane git worktree isolation + review/merge | ✅ | Each agent on its own branch; diff, commit, merge from the UI |
| ⭐ Desktop chat widget (tray/minimized) | ✅ | Assistant reachable when the main window is hidden |
| ⭐ Whole-workspace checkpoints | ✅ | Git-snapshot rollback for risky changes |

## Engineering quality bar

| | SwarmMind |
|---|---|
| Type gate | `npm run typecheck` clean (two tsconfig projects) |
| Pure-logic unit tests | `npm test` — 92 assertions over pure modules (incl. `nextEdit`, `codeBlocks`, `retrieval` lexical+vector, `verify`), no build step |
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
4. **Agent-mode iteration** — 🟡 human-in-the-loop verify→fix loop shipped (run a
   workspace npm script, feed failures back to the model). Next: optional
   autonomous iteration (auto-run → auto-fix up to N rounds) — gated behind an
   explicit user opt-in, since it executes processes and is hard to reverse.

This file is a living scorecard, not a marketing claim: "best" is earned row by
row. The editor-AI core is at parity; the open rows above are where the gap to
"best beside Cursor & BridgeMind" actually lives.
