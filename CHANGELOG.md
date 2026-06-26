# Changelog

All notable changes to SwarmMind are documented here. Each release section is
also used as the body of its GitHub Release (see `.github/workflows/release.yml`).

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [0.14.0]

### Changed
- **SwarmAgent got a visual glow-up.** The in-app assistant chat now has a more
  premium identity: a slowly rotating accent ring around the brand orb, gradient
  message bubbles (with a soft inner highlight), a glassy blurred composer with a
  stronger focus glow, a gradient send button with a subtle shine sweep on hover,
  a gradient hero title, and richer hover/lift on the suggestion chips. The
  header is now theme-aware (it previously used a hardcoded tint) with a soft
  accent divider line. Every colour is derived from the active theme, so it looks
  right under all of them.
- **The desktop widget matches.** The floating chat widget gets the same rotating
  orb ring, gradient send and user bubble, and a glassier input — plus real
  floating depth from a proper drop shadow.

### Fixed
- **Desktop widget drop shadow no longer clips.** The widget's transparent window
  is now sized with a gutter around the card so its shadow renders in full
  instead of being cut off at the window edge. The card's height is also now
  independent of the window size, fixing a case where it could collapse into a
  thin sliver.

## [0.13.0]

### Added
- **Multi-file Composer.** Describe a change in plain language and the AI proposes
  coordinated edits across several files at once. Context files are seeded from
  your open editor tabs (add more via a fuzzy file picker), the model returns a
  plan you preview as per-file diffs with a checkbox each, and **Apply** writes
  the selected files — optionally taking a one-click **safety checkpoint first**
  so the whole multi-file change is reversible from the Checkpoints panel. Open
  it from the new layers icon in the top bar, the command palette, or by asking
  SwarmAgent to `open_view('composer')`.
- **Inline AI edit — Ctrl/⌘-K in the editor.** Cursor-style "vibe coding": select
  code (or just place the cursor) and press Ctrl/⌘-K to describe a change. The
  result streams in as an accept / reject / regenerate preview with the changed
  range highlighted. Supports **@-mention file context** — type `@` to pull in
  another file so the edit can match its style or reuse a helper.
- **Tab-to-jump (next-edit prediction).** After you accept an inline edit, the
  editor predicts the likely follow-up edit and shows a **Tab** chip describing
  it; pressing Tab jumps there and pre-fills the next instruction, so related
  edits chain together.
- **Ghost-text autocomplete — Tab.** Copilot/Cursor-style inline AI completions
  appear as dimmed text as you pause typing; Tab accepts, Escape dismisses. Off
  by default (it spends tokens on every typing pause) — toggle it from the editor
  status bar.
- **AI diagnostics & "Fix with AI".** A **Diagnose** button sends the open file to
  the model, which flags problems as editor underlines and gutter markers; each
  carries a **Fix with AI** action that opens the inline-edit widget pre-filled
  with the suggested fix.
- **Rename symbol across files — F2.** Press F2 on an identifier, type the new
  name, and the workspace is searched for usages and renamed through the Composer
  pipeline (preview + checkpoint + apply), skipping strings, comments, and
  substring matches.
- **One-click apply from chat.** When a SwarmAgent reply contains file-targeted
  code blocks (path on the fence or the line above it), a **Review & apply**
  button opens the Composer directly on those exact blocks — diff, checkpoint,
  apply — with no extra model round-trip.
- **Smarter context selection — "Suggest relevant".** Instead of hand-picking
  Composer context files, this finds the right ones for you: it ranks the
  workspace against your instruction with hybrid lexical (BM25) + on-device
  **semantic embeddings**, key-free and offline-capable. A **Build index** action
  embeds the whole repo once (persisted under `.swarmmind/`) so ranking can reach
  files that don't literally contain your keywords.
- **Editor snippets.** Save a selection as a reusable snippet and insert it at the
  cursor from the editor status bar — fast, local, no AI.
- **Verify → fix loop.** After applying a Composer plan, optionally run one of
  your repo's own npm scripts (typecheck/test/lint/build); on failure, **Fix
  errors with AI** condenses the output into a follow-up instruction and re-runs
  the plan so the model fixes its own change. The runner only ever executes a
  script already declared in your `package.json` (allowlisted, no shell
  metacharacters), so a cloned repo can't turn it into arbitrary commands.

### Changed
- The Composer top-bar button now uses a distinct stacked-layers icon (multi-file)
  with a sparkle, instead of the previous generic wand.

## [0.12.0]

### Added
- **The assistant talks like a coding assistant — Markdown replies.** SwarmAgent's
  answers now render as proper Markdown in both the in-app chat and the desktop
  widget: fenced code blocks with a language label and a one-click **Copy**
  button, headings, lists, blockquotes, and inline bold/italic/`code`/links.
  Previously these showed as raw text. (Dependency-free and safe — no HTML
  injection.)
- **SwarmAgent reads the codebase.** Two new tools let the assistant answer
  questions about your project directly: `read_file` (returns a workspace file's
  contents, bounded so it stays cheap) and `list_files` (discovers files,
  optionally filtered). Ask "what does `src/App.tsx` do?" and it reads the file
  instead of guessing.
- **`@`-mention files in prompts.** Type `@` in the broadcast bar or the
  SwarmAgent composer to fuzzy-search your repo's files and insert a path — the
  standard vibecoding way to point an agent (or the assistant) at a file. Backed
  by a fast, bounded recursive file index that skips `node_modules`, `.git`, and
  build output.
- **SwarmAgent is grounded in live app state.** Every turn now includes a fresh
  snapshot of the workspace — which agent panes are running, working, or waiting
  for input; active loops; orchestration mode — so the assistant answers
  "what's running?" and picks the right pane without a wasted tool call.
- **Pick the best SwarmAgent model from a list.** Settings → General now offers a
  live model picker populated from your Groq key, plus curated quick-picks
  (Most capable / Balanced / Fastest), instead of a blind text field.
- **Run skills and recent commands from the command palette.** The palette now
  fuzzy-ranks with match highlighting, remembers your most-used commands and
  floats them to the top, and lists your saved skills as runnable actions.
- **Commit part of an agent's work.** Worktree Review gained per-file checkboxes,
  so you can stage and commit a subset of an agent branch's changed files and
  leave the rest, rather than only "commit all".

### Changed
- **Chat no longer yanks you to the bottom.** Both the assistant chat and the
  widget now only auto-scroll while you're already near the bottom, so scrolling
  up to re-read history isn't interrupted mid-stream.
- The command palette keeps the keyboard-selected row in view when you arrow past
  the visible area.

## [0.11.0]

### Fixed
- **Notification "jump to pane" now works from every view** — clicking an
  "agent needs you" notification only revealed the pane if you were on the board,
  memory graph, or file editor; from the timeline, changes, checkpoints, worktree
  review, benchmarks, loops, or the assistant chat, the overlay stayed open and
  kept the pane hidden. It now closes whatever center view is open and scrolls the
  pane into view. The "show terminals" toolbar button's active state was derived
  from the same drift-prone overlay list and is now computed from the single
  source of truth too (it also no longer reads as active on the start screen).
- **Unsaved edits no longer lost when leaving the editor** — opening the board,
  switching to the terminals, or any other center view used to unmount the code
  editor and silently discard its open tabs and unsaved changes. Editor tabs are
  now held in the workspace store, so toggling away and back preserves your open
  files and unsaved edits (they still clear when you switch to a different
  workspace, whose files they don't belong to). The toolbar's code button also
  shows an unsaved-file count badge, so you know you have pending edits even while
  looking at another view.

### Added
- **The assistant can now snapshot, review, and land work** — SwarmAgent gained
  the full safety-and-integration layer of vibe coding. Ask it to "snapshot this
  before the refactor" and it saves a checkpoint; "rewind to before the refactor"
  rolls the whole workspace back (a safety snapshot is taken first, so the rewind
  itself is undoable). It can review each agent's worktree branch ("what did the
  agents build?", "anything ready to merge?"), merge one in ("land the backend
  work" — it commits any loose changes first and aborts cleanly on conflict), or
  discard a failed experiment. It can also rename a pane ("call the left one
  backend") and close one. Every destructive action confirms with you first.

- **First-run orientation** — the start screen now greets brand-new users (no
  recent workspaces yet) with a short three-step "here's the gist": open a
  project, run agents side by side, or just ask the SwarmAgent assistant. It
  steps aside automatically once you have recent workspaces. Fully localized
  (EN/DE).
- **Context-aware assistant suggestions** — the SwarmAgent's empty-state chips
  now adapt to what you're doing: orient a newcomer (open a project, what can
  you do?), nudge toward setup when a workspace is open but idle, and suggest
  acting on running agents (status, changes, review their work, save a
  checkpoint) once agents are live. Localized (EN/DE).
- **SwarmAgent discoverability** — a subtle one-time coachmark now points at the
  assistant in the toolbar the first time you open a workspace, so the assistant
  isn't hidden behind an unlabeled icon. It dismisses for good the moment you
  open the assistant (any way) or click "Got it". Localized (EN/DE).

- **Save all open files** — when more than one editor tab has unsaved changes, a
  "Save all (N)" button appears in the editor status bar next to the per-file
  Save, writing every dirty file at once (a concurrent edit during the save stays
  marked unsaved). Localized (EN/DE).
- **"Which agents need me?"** — ask the SwarmAgent and it reports which panes are
  blocked waiting for your input (a question or permission prompt was detected)
  and which simply finished their turn and went idle — so you can triage a busy
  swarm at a glance instead of scanning every terminal.
- **Command palette reaches every view** — `Ctrl/⌘-K` now includes the SwarmAgent
  assistant, swarm timeline, changes, checkpoints, worktree review, loops,
  benchmarks, and the orchestrator bar, alongside the existing board/graph/code
  views — so every surface is keyboard-reachable, not just the toolbar. Commands
  that have a keyboard shortcut now show it inline (reflecting any rebinding).
- **Shortcut to toggle the SwarmAgent** — `Ctrl/⌘-Shift-A` opens or closes the
  assistant from anywhere. Rebindable in Settings → Shortcuts like the rest.

### Changed
- **Wider SwarmAgent command surface** — new tools for checkpoints
  (create/list/restore), worktree review/merge/discard, pane rename/close, and a
  "which agents need me?" triage report, available from both the in-app chat and
  the desktop widget.

## [0.10.0]

### Added
- **SwarmAgent — an in-app AI assistant (chat + voice)** that can actually drive
  the app. Ask it to "open a workspace with 4 agents", "tell Claude to run the
  tests and report back", or "what did the agents change?" and it acts. It can
  set up/add agent panes, broadcast or target prompts, read a pane's terminal
  output, wait for an agent to finish, interrupt a runaway agent, manage Kanban
  tasks, drive shared memory, navigate views, and run the orchestrator — with
  streaming replies, voice in/out, persisted history, Stop, and Regenerate.
- **SwarmAgent desktop widget** — a small frameless, always-on-top floating chat
  bar so the assistant stays reachable when the main window is minimized or
  hidden to the tray. It matches your chosen appearance, supports voice, grows
  from a slim bar into a transcript as you chat, and is draggable anywhere on the
  desktop. When an agent is blocked waiting on your input, the widget shows a
  pulsing alert (with the agent's name/icon) so you never miss it.
- **Loops — recurring prompt schedules** — save a prompt and have SwarmMind
  re-inject it into a chosen agent pane (or all running agents) every N seconds.
  Manage them from the new Loops panel, with run counts, next-run countdowns, and
  pause/resume. SwarmAgent can create and control loops for you too. SwarmMind
  also detects `/loop` commands typed into a terminal and lists them read-only.

### Changed
- **Bigger surface for the assistant** — new TopBar entry points for SwarmAgent
  and Loops, plus expanded SwarmAgent tools spanning agents, tasks, memory,
  views, changes, and orchestration.

## [0.9.0]

### Added
- **Task dependencies on the Kanban board** — when creating a task you can now
  pick which other tasks must finish first. Cards whose prerequisites aren't all
  done show a "Blocked" badge and list exactly what they're waiting on, mirroring
  the order the orchestrator dispatches work in.
- **Search & agent filtering** — filter the board by a text search over task
  titles/descriptions and by assigned agent, with a quick "Unassigned" filter.
- **Delete tasks** — remove a task straight from its card (with a confirm step).
  Deleting a task also cleans it out of any other task's prerequisites so nothing
  is left blocked on a task that no longer exists.
- **Board progress indicator** — the header shows how many tasks are done out of
  the total.

### Changed
- **Larger, more readable Kanban board** — bigger task cards, action buttons, and
  input fields throughout the board and the new-task form.

### Fixed
- **"Launch Agent" now actually runs the task** — launching an agent from a task
  card sends the task to the freshly spawned agent and reliably submits it,
  instead of just opening an idle agent. Dragging a task onto a running pane
  submits reliably too.

## [0.8.0]

### Added
- **Terminal start animation** — panes no longer flash a blank black screen
  while a shell or agent is spinning up. A clean, themed loading indicator
  ("Starting terminal" with a glowing sweep bar) now fills the pane during
  startup and fades out the moment the first output appears. It shows on every
  fresh spawn, agent launch, and session resume.

## [0.7.0]

### Changed
- **Agent brand logos** — each coding agent is now shown with its real logo
  (Claude Code, Codex, Cursor, Windsurf, Kilo Code, OpenCode, Cline) in place
  of the old colour dots, across the agent switcher, pane title bar, workspace
  setup, Kanban board, notifications, Settings, the Changes and Timeline feeds,
  and the orchestrator and broadcast bars — so you can tell agents apart at a
  glance.

## [0.6.0]

### Added
- **Coding-agent benchmarks leaderboard** — a new toolbar overlay (the
  bar-chart icon) ranks today's coding agents and models on the Artificial
  Analysis Coding Agent Index, with score bars for quick comparison. It ships
  with a bundled snapshot so it works offline and refreshes live in the
  background when a newer leaderboard is available.
- **Image viewer** — open PNG, JPEG, GIF, WebP, BMP, ICO, and AVIF files from
  the file explorer and they render in a proper image viewer (with file name,
  path, type, and size) instead of garbled text. Each image opens in its own
  tab alongside your code. SVGs still open in the editor since they're editable
  markup.
- **Loading indicators for SwarmVoice** — downloading or warming up the Whisper
  voice model now shows clear progress: a centred overlay when you trigger
  dictation before the model is ready (dismissable to keep working), and a
  small ambient pill in the corner while the model preloads quietly in the
  background.

## [0.5.1]

### Fixed
- **Pasted text no longer duplicated** — pasting into a terminal pane with
  Ctrl/⌘-V inserted the text twice, because both our key handler and xterm's
  built-in paste listener fired. The key handler now suppresses the native
  paste event so the text is inserted exactly once.

## [0.5.0]

### Added
- **Connect multiple accounts per agent** — connect several Claude, Codex, or
  OpenCode accounts and switch between them in a click, handy when one account
  hits a usage limit. Connecting is one click: SwarmMind runs the CLI's own
  sign-in (the same browser login you'd get from the command line) in an
  embedded terminal — **no API key needed**. Manage accounts in **Settings ▸**
  the agent's tab, or switch on the fly from a pane's right-click **Account**
  menu. Accounts are shared across every workspace and stored securely.
- **Accounts apply everywhere** — the active account is used not just by
  auto-launched panes but by any terminal: type `claude`, `codex`, or
  `opencode` by hand in any SwarmMind shell and it's already signed in with the
  active account.

### Changed
- **Find/replace bar polish** — the code editor's Ctrl-F search panel is
  re-laid-out into two comfortable rows with larger inputs and clearer spacing.
- **Broadcast & Orchestrator controls** are now disabled when a center overlay
  (board, memory graph, editor, …) is covering the terminal panes, since those
  bars act on the panes; the command-palette Broadcast entry now surfaces the
  panes first instead of silently doing nothing.

## [0.4.0]

### Added
- **Code editor with syntax highlighting** — the built-in file editor now does
  real syntax highlighting for ~150 languages (TypeScript, Python, Rust, Go,
  PHP, SQL, YAML, Markdown, and more), lazy-loaded so the right parser only
  loads when you first open a matching file. Highlighting follows the selected
  theme, including the light Paper theme.
- **Editor tabs** — open several files at once and switch between them with a
  tab strip; each tab keeps its own unsaved edits, cursor, and scroll position.
- **Editor status bar** — shows the current line and column, selection size,
  multi-cursor count, and the detected language.
- **Editor font size** — set the code editor's font size independently of the
  terminal in **Settings ▸ Appearance**.
- **SwarmVoice model picker** — choose the Whisper model in **Settings ▸
  General ▸ SwarmVoice**: Tiny (fastest), Base (balanced, now the default and
  noticeably more accurate), or Small (most accurate). The chosen model is
  downloaded on next use and remembered.
- **SwarmVoice preload** — optionally download and warm up the voice model in
  the background shortly after launch so your first dictation starts instantly.

### Fixed
- **SwarmVoice no longer re-downloads its model on every launch** — the Whisper
  model is now cached to disk under the app's data directory instead of the
  renderer's non-persistent `file://` cache, so it's fetched once and reused.
  Voice transcription also runs on the faster multi-threaded backend.

## [0.3.0]

### Added
- **German language support** — the entire UI can now be switched between
  English and German from **Settings ▸ General ▸ Language**. Every visible
  string is translated and the choice is remembered across restarts.
- **Close to tray** — closing the window now hides SwarmMind to a system tray
  icon instead of quitting, so agents and terminals keep running in the
  background. Click the tray icon to bring the window back, or use the tray
  menu to quit for real. You can turn this off in **Settings ▸ General**.
- **Terminal copy & paste** — copy and paste now work inside agent panes.
  `Ctrl/Cmd+Shift+C` / `Ctrl/Cmd+Shift+V` always copy and paste; plain
  `Ctrl/Cmd+C` copies when text is selected and otherwise still sends an
  interrupt (SIGINT); paste is also available from the pane's right-click menu.

## [0.2.0]

### Added
- **Mixed workspace** — run an agent that belongs to a *different* workspace
  inside the current window. A pane can be bound to another workspace via its
  context menu (**Run from workspace ▸**); the agent then spawns in that
  workspace's directory and is a **full member** of it — sharing that
  workspace's MCP memory, tasks, and event timeline, not just a terminal pointed
  at a folder. A title-bar badge shows which workspace a foreign pane belongs to.
  Host orchestration (Conductor, Broadcast) stays scoped to the host workspace.

### Changed
- **Faster fullscreen tabs** — when a pane is fullscreen, all panes now stay
  mounted and only the active tab is shown. Switching tabs is instant, each
  terminal keeps its scroll position, and output produced while a pane is a
  background tab is no longer lost. The active tab also auto-scrolls into view
  and takes keyboard focus when cycling with Ctrl+Tab.
- **Cleaner fullscreen tab strip** — the tab strip and the pane below now form
  one continuous rounded card instead of rounded corners poking out below the
  tabs.
- **Theme-accurate accents** — the active-pane border ring and several badges
  (waiting, broadcast, orchestrator, session resume) now follow the selected
  theme's accent color instead of a hardcoded warm-brown, so they look right
  under every theme.

[0.5.0]: https://github.com/0xnookie/swarmmind/releases/tag/v0.5.0
[0.4.0]: https://github.com/0xnookie/swarmmind/releases/tag/v0.4.0
[0.3.0]: https://github.com/0xnookie/swarmmind/releases/tag/v0.3.0
[0.2.0]: https://github.com/0xnookie/swarmmind/releases/tag/v0.2.0
