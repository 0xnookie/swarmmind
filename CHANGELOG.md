# Changelog

All notable changes to SwarmMind are documented here. Each release section is
also used as the body of its GitHub Release (see `.github/workflows/release.yml`).

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/0xnookie/swarmmind/releases/tag/v0.2.0
