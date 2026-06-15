# Changelog

All notable changes to SwarmMind are documented here. Each release section is
also used as the body of its GitHub Release (see `.github/workflows/release.yml`).

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

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
