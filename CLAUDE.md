# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (HMR via electron-vite)
npm run dev

# Production build (outputs to out/)
npm run build

# Package into installer (dist/)
npm run dist

# Recompile native modules (node-pty, better-sqlite3) after electron version changes
npm run rebuild

# Type-check both projects (web + node) — the correctness gate
npm run typecheck
```

There is no test suite. TypeScript type-checking is the primary correctness gate, and `npm run typecheck` (runs `tsc --noEmit` over `tsconfig.web.json` and `tsconfig.node.json`) is currently **clean** — keep it that way. The build (`electron-vite`/esbuild) does **not** gate on type errors, so run `npm run typecheck` before declaring work done. Note: `tsc` is `composite`, so a stale `*.tsbuildinfo` can mask the effect of new `.d.ts` files — delete `tsconfig.web.tsbuildinfo` if an augmentation isn't taking.

## Architecture

SwarmMind is an Electron desktop app that runs multiple AI coding CLIs side-by-side in resizable terminal panes, with a shared MCP memory server so agents can exchange context.

### Process boundary

The renderer (React) and main process (Node.js) are strictly isolated via contextBridge:
- `electron/preload.ts` — exposes the entire IPC surface as `window.swarmmind`
- `src/types/swarmmind.d.ts` — TypeScript types for `window.swarmmind`

**Never call Node.js APIs directly from React code.** Every cross-process call must go through `window.swarmmind.*`.

### Dual SQLite databases

Two independent `better-sqlite3` connections live in `memory/db.ts`:

| Connection | Path | Tables |
|---|---|---|
| `appDb` | `userData/app.db` | `workspaces`, `skills`, `app_state` |
| `workspaceDb` | `{rootPath}/.swarmmind/memory.db` | `memory_entries`, `tasks`, `pane_layouts`, `agent_configs`, `messages` |

`initAppDb()` runs once at startup. `initWorkspaceDb()` runs each time the user opens a workspace (the previous connection is closed first). All query helpers in `memory/queries.ts` call `getAppDb()` or `getWorkspaceDb()` — never the wrong one.

### MCP server

`mcp/server.ts` runs an Express/SSE HTTP server inside the main process (preferred port 57400, falls back to OS-assigned). Tools and resources are registered in `mcp/tools.ts` and `mcp/resources.ts`. The active workspace ID is tracked via `setActiveWorkspace()` so tools always query the correct DB.

**Auth:** the SSE endpoint is gated on a per-run bearer token (`getMcpToken()`, random per process). It's appended to the injected SSE URL (`?token=…`) and exposed as `SWARMMIND_MCP_TOKEN`, so only agents SwarmMind spawns can reach the server even though it binds `127.0.0.1`.

**Tools:** `memory_read/write/delete/list`; `task_create/update/list/get/note`; `send_message`. `task_note` appends a timestamped progress note (status unchanged); `task_get` returns full detail; `send_message(to,from,message)` queues a directed agent→agent message in the `messages` table, which the renderer-side conductor delivers by injecting into a free running pane of the recipient agent (see `useConductor.ts::deliverMessages`, runs every tick regardless of orchestration mode).

At agent spawn time, `electron/pty-manager.ts::injectMcpConfig()` writes the MCP SSE URL (with token) into each agent's config file (e.g., `{cwd}/.claude/settings.json` for Claude Code).

**Secrets:** agent API keys are encrypted at rest via Electron `safeStorage` (`electron/secrets.ts`), wrapped by `electron/agent-config.ts::readAgentConfig/writeAgentConfig` (the only paths the settings IPC and PTY spawn use). Legacy plaintext keys are read unchanged and re-encrypted on next write; if the OS keychain is unavailable, it falls back to plaintext rather than failing the save.

### PTY spawning (Windows critical path)

`node-pty` cannot spawn `.cmd` scripts directly on Windows. `resolveSpawn()` in `electron/pty-manager.ts` wraps every agent command in the user's selected shell:

- `powershell` → `powershell.exe -NoLogo -NoExit -Command <cmd>`
- `cmd` → `cmd.exe /k <cmd>`
- `bash` → `bash.exe -i -c <cmd>` (Git Bash or WSL's bash, whichever is on PATH)

On non-Windows the command is wrapped in `$SHELL -c <cmd>` so quoted args/paths survive. The shell style (`ShellStyle = 'powershell' | 'cmd' | 'bash'`) is stored in Zustand (`shellStyle`) and persisted via `appsetting:set`. Users configure it in Settings → General.

### Session resume

Reopening a workspace automatically relaunches each pane's agent **and** restores its prior conversation — no user action. The mechanism:

- When an agent spawns, the pane leaf records `agentRunning: true` and a `sessionId` (a UUID minted on fresh spawn). Both are persisted in the layout JSON. `killAll()` kills **silently** (suppresses `pty:exit`) so quitting/workspace-switch doesn't clear those flags.
- On load, `sanitizeLoadedLayout()` in `workspace.ts` turns any `agentRunning` leaf into a queued auto-spawn (`pendingAutoSpawn: true`, `resume: true`) instead of wiping it, preserving `agentId`, `cwd`, and `sessionId`.
- `ptyCreate(..., resume, sessionId)` resolves the launch via `buildLaunchArgs()` in `pty-manager.ts`. Claude uses a caller-chosen session id for **per-pane** continuity: fresh = `claude --session-id <uuid>`, resume = `claude --resume <uuid>` (both non-interactive — no picker). Agents without a controllable session id fall back to `AGENT_RESUME_ARGS` ("continue last", e.g. `codex resume --last`, `opencode --continue`); the rest relaunch fresh.

**StrictMode gotcha (the auto-spawn effect in `AgentPane.tsx`):** the deferred-spawn timer must **not** be cancelled in the effect cleanup. React StrictMode runs effects mount→cleanup→mount in dev; a `clearTimeout` in cleanup kills the only scheduled spawn while the `autoSpawnedRef` guard blocks rescheduling, so the agent never launches (blank pane). Guard the timer callback with a mount ref instead. This only bites in `npm run dev`, not packaged builds.

### Multi-pane orchestration & extras

Features layered on top of the pane model:

- **Broadcast & selection** (`BroadcastBar.tsx`, store `selectedPaneIds`/`broadcastBarOpen`): Ctrl/⌘-click a pane title bar to select it; the broadcast bar (TopBar button or Ctrl/⌘-B) sends one prompt to selected panes, or all when none are selected, via `window.swarmmind.ptyInput`.
- **Pipe** (AgentPane context menu): route a pane's selection (or recent output, ANSI-stripped via `usePty.getRecentOutput`) to shared memory (`memoryWrite`) or into the other panes.
- **Agent activity** (`pty-manager` → `pty:state` event → store `paneAttention`): a per-pane idle timer flips agents between `working` and `waiting`; this drives the pane "waiting" badge and the conductor, and is purely about "finished a turn" — it does **not** notify. **Notifications are question-gated:** going `waiting` only fires the discrete "needs you" signal when the agent is actually blocked on an answer. `attachPty` keeps a rolling, ANSI-stripped `PtyEntry.recentOutput` tail and, on going quiet, runs `looksLikeQuestion()` (permission prompt / `y/n` / selection-menu patterns) against it. Only on a match does it (a) send `pty:attention` → renderer `addPaneNotification` (the TopBar bell, regardless of focus) and (b) fire an OS `Notification` (only if the window is unfocused). Both still require `PtyEntry.hadInput` (set in `ptyInput`) so a freshly-spawned agent at its prompt never pings. The idle threshold is the module-level `agentIdleMs` (default 4000), configurable in Settings → General (persisted as the `agentIdleMs` app setting; `appsettings.ts::applySideEffects` pushes changes live to `pty-manager.ts::setAgentIdleMs`, and `loadPersistedSettings()` applies it at startup). Cleared on focus/exit.
- **Session history & scrollback** (`electron/ipc/sessions.ts`): `session:list` reads `~/.claude/projects/<encoded-cwd>/*.jsonl` for the Claude session picker (`SessionPicker.tsx`); `scrollback:load/save` persist per-pane terminal output under `{root}/.swarmmind/scrollback/<paneId>.log` (debounced from `usePty`).
- **Command palette** (`CommandPalette.tsx`, store `commandPaletteOpen`, Ctrl/⌘-K) and **terminal search** (`@xterm/addon-search` in `usePty`, Ctrl-F per pane).
- **Per-pane title/colour**: `PaneLeaf.title`/`color` (persisted), edited via title-bar double-click and the context-menu swatches.
- **Orchestration — Conductor + Lead** (`hooks/useConductor.ts`, `OrchestratorBar.tsx`, store fields prefixed `orchestrat*`/`leadPaneId`/`paneTask`): turns the existing task queue + the `pty:state` `waiting` signal into an autonomous control loop. `useConductor()` is mounted once in `App.tsx` and runs a `setInterval` tick (it spends **zero** model tokens — code does the wiring, panes do the thinking). Three modes (`orchestrationMode`: `off`/`assisted`/`auto`, toggled in `OrchestratorBar`, shown as a TopBar dot). Each tick: (1) **completion sweep** — a worker reports done by calling `task_update(id,'done')` + `memory_write('result:<id>',…)` over MCP; the loop watches `taskList`, collects the result, and frees the pane (`paneTask` maps paneId→taskId); (2) **dispatch** — finds the next `pending` task whose `depends_on` (new comma-separated `tasks.depends_on` column + `task_create` MCP arg) are all `done`, matches it to a free worker pane by `assigned_agent`, and injects a single-line prompt via `ptyInput` (in `assisted` mode it raises an `orchestratorProposal` for `conductorControls.approve()`/`skip()` instead); (3) a designated **lead pane** (`leadPaneId`, optional) is prompted to **decompose** `orchestratorGoal` into tasks at run start and to **synthesize** results once all tasks finish (`orchestratorPhase`: `idle`→`running`→`done`). Worker/lead panes must already be running their CLIs — the conductor injects prompts, it does not spawn agents. **Robustness** (session-scoped refs, reset on each run): a `failed` task is auto-reset to `pending` and re-dispatched up to `MAX_RETRIES` before being surfaced as needing attention; a dispatched worker that goes idle (`paneAttention === 'waiting'`) past `STALL_MS` while its task is still `in_progress` gets one nudge to report completion; if the lead produces no tasks within `DECOMPOSE_TIMEOUT_MS` it's re-prompted once, then the loop gives up rather than hanging. The activity log is persisted per workspace (debounced app setting `orchestratorLog:<id>`, loaded on workspace switch).
- **Worktree Review** (`WorktreeReview.tsx`, store `reviewOpen`, TopBar branch icon): the payoff of per-pane worktree isolation. Lists each SwarmMind-managed worktree (under `.swarmmind/worktrees/`), shows its diff vs the main checkout's branch (`getBaseBranch`) — committed work **and** uncommitted changes, since `git diff <base>` runs from inside the worktree — with per-file +/− stats, a file picker, and a coloured unified-diff view. Actions: **Commit all** (stage + commit inside the worktree so the work becomes mergeable), **Merge into `<base>`** (merges committed work; aborts and reports on conflict so the main checkout stays clean), **Discard** (remove worktree + delete branch). Git ops live in `git-manager.ts` (`worktreeDiffStat`/`worktreeDiff`/`worktreeCommit`/`mergeBranch`) behind `git:*` IPC.
- **Center overlays** (store `boardOpen`/`graphOpen`/`reviewOpen`, mutually exclusive, toggled from TopBar): App.tsx picks `KanbanBoard` → `MemoryView` → `WorktreeReview` → `FilePanel` → `CenterArea` by precedence. `graphOpen` renders `MemoryView.tsx`, a tab host with **Graph | List** tabs: `MemoryGraph.tsx` (dependency-free SVG force-directed graph — nodes = agents/entries/tasks, links = wrote / assigned-to — with drag, pan, wheel-zoom, fed by `useMemory`) and `MemoryPanel.tsx` (editable list of entries + tasks with agent filter, inline edit/delete). Note: the left-sidebar toggle is confusingly named `kanbanOpen`/`toggleKanban` but controls `WorkspaceSidebar` (the workspace list), not the board.

### Renderer state

`src/store/workspace.ts` is the single Zustand store. Key state:
- `rootPane: PaneGroup` — recursive tree of terminal panes (Allotment layout). Serialized to SQLite on every structural change via `layoutSave()`. Each `PaneLeaf` also persists `agentRunning` + `sessionId` (drives session resume — see above) and carries the transient `pendingAutoSpawn`/`resume` flags.
- `kanbanOpen` — left sidebar (WorkspaceSidebar)
- `filePanelOpen` — replaces CenterArea with FilePanel (file explorer + CodeMirror editor)
- `memoryPanelOpen` — right sidebar (SkillsLibrary)
- `shellStyle` — PTY shell wrapper selection

### Layout: App.tsx

```
TopBar (38px, custom title bar with WinControls)
└── main (flex row)
    ├── WorkspaceSidebar (260px, when kanbanOpen)
    ├── FilePanel OR CenterArea (flex: 1)
    └── SkillsLibrary (380px, when memoryPanelOpen)
```

`CenterArea` renders the Allotment pane tree. Each leaf renders `AgentPane` which contains an xterm.js terminal wired to PTY via `usePty()`.

### Window controls

`titleBarStyle: 'hidden'` (no `titleBarOverlay`) gives a fully custom title bar. `WinControls` in `TopBar.tsx` renders Windows-style −□× buttons backed by IPC (`window:minimize/maximize/close`). The header div has `WebkitAppRegion: 'drag'`; interactive elements override with `WebkitAppRegion: 'no-drag'`.

### Skill drag-and-drop

`SkillsLibrary` drags with MIME type `application/skill` containing `{ promptText }`. `AgentPane` accepts the drop and calls `usePty.injectText()` which writes directly to the PTY input.

### Native modules

`node-pty` and `better-sqlite3` are native Node.js addons. They must be excluded from Vite bundling (see `electron.vite.config.ts` `externals`) and unpacked from asar in production (see `electron-builder.config.ts` `asarUnpack`). After upgrading Electron, run `npm run rebuild` to recompile them against the new Electron ABI.

## Design tokens

CSS variables in `src/index.css` (warm-brown palette):
- `--bg-base: #1a1816`, `--bg-panel: #1e1c1a`, `--bg-elevated: #252220`
- `--accent: #e8956b` (orange-brown)
- `--text-primary / --text-secondary / --text-muted / --text-dim`
- Terminal theme in `usePty.ts` uses matching warm-brown colors

Fonts loaded from Google Fonts: **Inter** (UI) + **JetBrains Mono** (terminal).
