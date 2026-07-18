import React, { useEffect, lazy, Suspense } from 'react'
import { TopBar } from './components/TopBar'
import { CenterArea } from './components/CenterArea'
import { SkillsLibrary } from './components/SkillsLibrary'
import { PreviewPanel } from './components/PreviewPanel'
import WorkspaceSidebar from './components/WorkspaceSidebar'
import { StartScreen } from './components/StartScreen'

// On-demand center overlays + the CodeMirror editor are lazy-loaded: they're
// only shown when their overlay is opened, so keeping them out of the initial
// bundle speeds first paint (the default view is the terminal grid / start
// screen, neither of which needs any of these). Named exports → default-wrapped.
const FilePanel = lazy(() => import('./components/FilePanel').then((m) => ({ default: m.FilePanel })))
const KanbanBoard = lazy(() => import('./components/KanbanBoard').then((m) => ({ default: m.KanbanBoard })))
const MemoryView = lazy(() => import('./components/MemoryView').then((m) => ({ default: m.MemoryView })))
const WorktreeReview = lazy(() => import('./components/WorktreeReview').then((m) => ({ default: m.WorktreeReview })))
const ComposerPanel = lazy(() => import('./components/ComposerPanel').then((m) => ({ default: m.ComposerPanel })))
const SwarmTimeline = lazy(() => import('./components/SwarmTimeline').then((m) => ({ default: m.SwarmTimeline })))
const ChangesPanel = lazy(() => import('./components/ChangesPanel').then((m) => ({ default: m.ChangesPanel })))
const CheckpointPanel = lazy(() => import('./components/CheckpointPanel').then((m) => ({ default: m.CheckpointPanel })))
const BenchmarksPanel = lazy(() => import('./components/BenchmarksPanel').then((m) => ({ default: m.BenchmarksPanel })))
const SwarmAgentChat = lazy(() => import('./components/SwarmAgentChat').then((m) => ({ default: m.SwarmAgentChat })))
const LoopsPanel = lazy(() => import('./components/LoopsPanel').then((m) => ({ default: m.LoopsPanel })))
const CanvasMode = lazy(() => import('./components/CanvasMode').then((m) => ({ default: m.CanvasMode })))
import { SettingsModal } from './components/SettingsModal'
import { WorkspaceSetupModal } from './components/WorkspaceSetupModal'
import { CommandPalette } from './components/CommandPalette'
import { LoadingOverlay } from './components/LoadingOverlay'
import { UpdateBanner } from './components/UpdateBanner'
import { ConfirmDialogHost } from './components/ConfirmDialog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useConductor } from './hooks/useConductor'
import { useLoops } from './hooks/useLoops'
import { useWidgetBridge } from './hooks/useWidgetBridge'
import { useWorkspaceStore, buildLayoutForCount, selectTerminalsVisible, type AgentId, type ShellStyle } from './store/workspace'
import { parseSnippets } from './lib/snippets'
import { playCue } from './lib/audioCues'
import { SHORTCUTS, matchEvent, getEffectiveKeys } from './shortcuts'
import type { ThemePreset, UiDensity, UiFontId, MonoFontId } from './appearance'
import { THEMES, UI_FONTS, MONO_FONTS } from './appearance'

export default function App() {
  const memoryPanelOpen = useWorkspaceStore(s => s.memoryPanelOpen)
  const previewPanelOpen = useWorkspaceStore(s => s.previewPanelOpen)
  const togglePreviewPanel = useWorkspaceStore(s => s.togglePreviewPanel)
  const kanbanOpen = useWorkspaceStore(s => s.kanbanOpen)
  const filePanelOpen = useWorkspaceStore(s => s.filePanelOpen)
  const boardOpen = useWorkspaceStore(s => s.boardOpen)
  const graphOpen = useWorkspaceStore(s => s.graphOpen)
  const reviewOpen = useWorkspaceStore(s => s.reviewOpen)
  const composerOpen = useWorkspaceStore(s => s.composerOpen)
  const timelineOpen = useWorkspaceStore(s => s.timelineOpen)
  const changesOpen = useWorkspaceStore(s => s.changesOpen)
  const checkpointsOpen = useWorkspaceStore(s => s.checkpointsOpen)
  const benchmarksOpen = useWorkspaceStore(s => s.benchmarksOpen)
  const swarmAgentOpen = useWorkspaceStore(s => s.swarmAgentOpen)
  const canvasOpen = useWorkspaceStore(s => s.canvasOpen)
  const loopsOpen = useWorkspaceStore(s => s.loopsOpen)
  const toggleMemoryPanel = useWorkspaceStore(s => s.toggleMemoryPanel)
  const setupModalOpen = useWorkspaceStore(s => s.setupModalOpen)
  const openSetupModal = useWorkspaceStore(s => s.openSetupModal)
  const closeSetupModal = useWorkspaceStore(s => s.closeSetupModal)
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace)
  const loadFromJson = useWorkspaceStore(s => s.loadFromJson)
  const resetLayout = useWorkspaceStore(s => s.resetLayout)
  const workspace = useWorkspaceStore(s => s.workspace)

  // The orchestration control loop (Conductor + Lead). Inactive until the user
  // picks a mode in the OrchestratorBar.
  useConductor()
  // The loop runner — fires recurring prompt schedules into agent panes.
  useLoops()
  // Execute tool calls forwarded from the SwarmAgent desktop widget.
  useWidgetBridge()

  useEffect(() => {
    window.swarmmind.workspaceOpenLast().then((ws) => {
      if (ws && !ws.error) {
        setWorkspace({ id: ws.id, name: ws.name, rootPath: ws.rootPath })
        if (ws.savedLayout) loadFromJson(ws.savedLayout)
        else resetLayout()
      }
    })
    window.swarmmind.getAppSetting('defaultAgentId').then(val => {
      if (val) useWorkspaceStore.getState().setDefaultAgentId(val as AgentId)
    }).catch(() => {})
    window.swarmmind.getAppSetting('shellStyle').then(val => {
      // Ignore stale/unknown values (e.g. a previously-saved 'wsl') so spawns
      // don't fall through to a broken shell wrapper.
      if (val === 'powershell' || val === 'cmd' || val === 'bash') {
        useWorkspaceStore.setState({ shellStyle: val as ShellStyle })
      }
    }).catch(() => {})
    window.swarmmind.getAppSetting('terminalFontSize').then(val => {
      const n = Number(val)
      if (Number.isFinite(n) && n > 0) useWorkspaceStore.setState({ terminalFontSize: Math.min(24, Math.max(9, Math.round(n))) })
    }).catch(() => {})
    window.swarmmind.getAppSetting('terminalCursorBlink').then(val => {
      if (val != null && val !== '') useWorkspaceStore.setState({ terminalCursorBlink: val !== '0' })
    }).catch(() => {})
    window.swarmmind.getAppSetting('closeToTray').then(val => {
      if (val != null && val !== '') useWorkspaceStore.setState({ closeToTray: val !== '0' })
    }).catch(() => {})
    window.swarmmind.getAppSetting('soundCues').then(val => {
      if (val != null && val !== '') useWorkspaceStore.setState({ soundCuesEnabled: val !== '0' })
    }).catch(() => {})
    window.swarmmind.getAppSetting('focusMode').then(val => {
      if (val != null && val !== '') useWorkspaceStore.setState({ focusModeEnabled: val !== '0' })
    }).catch(() => {})
    window.swarmmind.getAppSetting('language').then(val => {
      if (val === 'en' || val === 'de') useWorkspaceStore.setState({ language: val })
    }).catch(() => {})
    window.swarmmind.getAppSetting('voiceModel').then(val => {
      if (val === 'tiny' || val === 'base' || val === 'small') useWorkspaceStore.setState({ voiceModel: val })
    }).catch(() => {})
    window.swarmmind.getAppSetting('voicePreload').then(val => {
      if (val != null && val !== '') useWorkspaceStore.setState({ voicePreload: val !== '0' })
    }).catch(() => {})
    window.swarmmind.getAppSetting('editorGhostText').then(val => {
      if (val != null && val !== '') useWorkspaceStore.setState({ ghostTextEnabled: val !== '0' })
    }).catch(() => {})
    window.swarmmind.getAppSetting('editorSnippets').then(val => {
      useWorkspaceStore.setState({ snippets: parseSnippets(val) })
    }).catch(() => {})

    // Appearance — load all keys, then hydrate + apply once (validating each so
    // a stale/unknown persisted value falls back to the store default).
    Promise.all([
      window.swarmmind.getAppSetting('themePreset'),
      window.swarmmind.getAppSetting('accentColor'),
      window.swarmmind.getAppSetting('uiDensity'),
      window.swarmmind.getAppSetting('uiFont'),
      window.swarmmind.getAppSetting('monoFont'),
      window.swarmmind.getAppSetting('editorFontSize'),
    ]).then(([theme, accent, density, uiFont, monoFont, editorFontSize]) => {
      const edSize = editorFontSize ? Number(editorFontSize) : NaN
      useWorkspaceStore.getState().hydrateAppearance({
        themePreset: theme && theme in THEMES ? (theme as ThemePreset) : undefined,
        accentColor: accent ? accent : (accent === '' ? null : undefined),
        uiDensity: density === 'compact' || density === 'default' || density === 'comfortable'
          ? (density as UiDensity) : undefined,
        uiFont: uiFont && uiFont in UI_FONTS ? (uiFont as UiFontId) : undefined,
        monoFont: monoFont && monoFont in MONO_FONTS ? (monoFont as MonoFontId) : undefined,
        editorFontSize: Number.isFinite(edSize) ? edSize : undefined,
      })
    }).catch(() => {
      // Even on failure, apply the defaults so density/zoom is initialised.
      useWorkspaceStore.getState().hydrateAppearance({})
    })

    // Keybinding overrides.
    window.swarmmind.getAppSetting('keybindings').then(val => {
      if (!val) return
      try {
        const parsed = JSON.parse(val)
        if (parsed && typeof parsed === 'object') {
          useWorkspaceStore.getState().hydrateKeybindings(parsed as Record<string, string>)
        }
      } catch { /* ignore malformed */ }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const unsubscribe = window.swarmmind.onMenuOpenWorkspace(handleOpenWorkspace)
    return unsubscribe
  }, [])

  // Phase 2 — reflect agent activity (working/waiting) into the store for badges.
  useEffect(() => {
    const { setPaneAttention, addPaneNotification } = useWorkspaceStore.getState()
    const unsubState = window.swarmmind.onPtyState((paneId, state) => {
      // Drives the per-pane "working/waiting" badge and the conductor. Going
      // quiet here is just "finished a turn" — not necessarily a reason to ping.
      // The working→waiting transition is the "finished a turn" moment the soft
      // audio tick attaches to (opt-in, rate-limited in playCue).
      const st = useWorkspaceStore.getState()
      if (st.soundCuesEnabled && st.paneAttention[paneId] === 'working' && state === 'waiting') playCue('done')
      setPaneAttention(paneId, state)
    })
    // The discrete "needs you" event: the agent is actually blocked on an answer
    // (a question/prompt was detected), so record it for the notification center
    // (deduped per pane while still unread).
    const unsubAttention = window.swarmmind.onPtyAttention((paneId) => {
      addPaneNotification(paneId)
      const st = useWorkspaceStore.getState()
      if (st.soundCuesEnabled) playCue('attention')
      // Focus mode: spotlight the pane that just asked a question so the user's
      // eye lands on the agent that's blocked. Only when the terminal grid is
      // actually visible — never yank them out of another view.
      if (st.focusModeEnabled && selectTerminalsVisible(st)) st.setActivePaneId(paneId)
    })
    // A `/loop` typed into a pane's CLI — surface it (read-only) in the Loops panel.
    const unsubLoop = window.swarmmind.onPtyLoop((paneId, info) =>
      useWorkspaceStore.getState().addCliLoop(paneId, info.command, info.interval))
    const unsubExit = window.swarmmind.onPtyExit((paneId) => {
      setPaneAttention(paneId, null)
      useWorkspaceStore.getState().clearPaneCliLoops(paneId)
    })
    // Keep cost + contention state fresh from swarm events even when their
    // overlays aren't open (drives the TopBar cost pill and contention dot).
    const unsubEvent = window.swarmmind.onSwarmEvent((ev) => {
      if (!ev) return
      // Background-workspace agents keep running and still emit events, but the
      // cost pill and contention dot are about the *foreground* workspace. Ignore
      // events from other workspaces so they don't pollute the displayed totals.
      const activeWs = useWorkspaceStore.getState().workspace?.id
      if (activeWs && ev.workspace_id !== activeWs) return
      if (ev.type === 'cost' && ev.pane_id) {
        const usd = Number((ev.payload as { usd?: number } | null)?.usd ?? 0)
        const tokens = Number((ev.payload as { tokens?: number } | null)?.tokens ?? 0)
        if (Number.isFinite(usd)) useWorkspaceStore.getState().updatePaneCost(ev.pane_id, usd, tokens)
      } else if (ev.type === 'contention') {
        const path = (ev.payload as { path?: string } | null)?.path
        if (path) useWorkspaceStore.getState().addContendedPath(path)
        if (path && useWorkspaceStore.getState().soundCuesEnabled) playCue('contention')
      } else if (ev.type === 'file_changed') {
        // Keep the semantic index fresh while the swarm works: queue the touched
        // path for a debounced incremental re-embed (no-op until the user has
        // built an index). Dynamic import so embeddings stay out of the entry
        // bundle (startup perf — see "lazy overlays" in CLAUDE.md).
        const path = (ev.payload as { path?: string } | null)?.path
        const root = useWorkspaceStore.getState().workspace?.rootPath
        if (path && root) {
          import('./lib/codeIndex').then(m => m.noteFileChanged(root, path)).catch(() => {})
        }
      }
    })
    return () => { unsubState(); unsubAttention(); unsubLoop(); unsubExit(); unsubEvent() }
  }, [])

  // Global shortcuts, dispatched from the central registry so they honour any
  // user rebindings. Component-scoped actions (voice, pane search) are matched
  // where they live. Reads the latest overrides via getState() so the listener
  // never needs re-registering.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useWorkspaceStore.getState()
      for (const def of SHORTCUTS) {
        if (!def.global) continue
        if (!matchEvent(e, getEffectiveKeys(def.id, s.keybindings))) continue
        // Ctrl/Cmd+K inside the code editor is inline AI edit (Cursor-style), not
        // the command palette — the editor's own keymap already handled it.
        if (def.id === 'command-palette' && (e.target as HTMLElement)?.closest?.('.cm-editor')) {
          return
        }
        e.preventDefault()
        switch (def.id) {
          case 'command-palette': s.toggleCommandPalette(); break
          // Broadcast only renders inside the terminal grid — ignore the shortcut
          // when an overlay (board/graph/editor/…) is covering the panes.
          case 'broadcast': if (selectTerminalsVisible(s)) s.toggleBroadcastBar(); break
          case 'settings': s.openSettings(); break
          case 'new-pane': s.addPane(); break
          case 'swarm-agent': s.toggleSwarmAgent(); break
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleOpenWorkspace = () => openSetupModal()

  const handleSetupComplete = async (rootPath: string, terminalCount: number, name: string, agentId: AgentId | null) => {
    closeSetupModal()
    useWorkspaceStore.getState().setDefaultAgentId(agentId)
    const ws = await window.swarmmind.workspaceOpenByPath(rootPath, name.trim() || undefined)
    if (ws && !ws.error) {
      const layout = buildLayoutForCount(terminalCount, agentId)
      setWorkspace({ id: ws.id, name: ws.name, rootPath: ws.rootPath })
      useWorkspaceStore.getState().setLayout(layout)
    }
  }

  return (
    <div style={styles.root}>
      <TopBar
        onTogglePanel={toggleMemoryPanel}
        panelOpen={memoryPanelOpen}
        onTogglePreview={togglePreviewPanel}
        previewOpen={previewPanelOpen}
      />
      <div style={styles.main}>
        {/* Left — workspace sidebar */}
        {kanbanOpen && (
          <ErrorBoundary label="WorkspaceSidebar">
            <WorkspaceSidebar onOpenWorkspace={handleOpenWorkspace} />
          </ErrorBoundary>
        )}

        {/* Center — start screen when no workspace is open, otherwise the
            board / graph overlays take precedence over the pane grid. Wrapped in
            Suspense because the overlays + editor are lazy-loaded (see imports). */}
        <Suspense fallback={<div style={styles.lazyFallback} />}>
        {!workspace ? (
          <ErrorBoundary label="StartScreen">
            <StartScreen onOpenWorkspace={handleOpenWorkspace} />
          </ErrorBoundary>
        ) : boardOpen ? (
          <ErrorBoundary label="KanbanBoard">
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <KanbanBoard />
            </div>
          </ErrorBoundary>
        ) : graphOpen ? (
          <ErrorBoundary label="MemoryView">
            <MemoryView />
          </ErrorBoundary>
        ) : reviewOpen ? (
          <ErrorBoundary label="WorktreeReview">
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <WorktreeReview />
            </div>
          </ErrorBoundary>
        ) : composerOpen ? (
          <ErrorBoundary label="ComposerPanel">
            <ComposerPanel />
          </ErrorBoundary>
        ) : timelineOpen ? (
          <ErrorBoundary label="SwarmTimeline">
            <SwarmTimeline />
          </ErrorBoundary>
        ) : changesOpen ? (
          <ErrorBoundary label="ChangesPanel">
            <ChangesPanel />
          </ErrorBoundary>
        ) : checkpointsOpen ? (
          <ErrorBoundary label="CheckpointPanel">
            <CheckpointPanel />
          </ErrorBoundary>
        ) : benchmarksOpen ? (
          <ErrorBoundary label="BenchmarksPanel">
            <BenchmarksPanel />
          </ErrorBoundary>
        ) : swarmAgentOpen ? (
          <ErrorBoundary label="SwarmAgentChat">
            <SwarmAgentChat />
          </ErrorBoundary>
        ) : canvasOpen ? (
          <ErrorBoundary label="CanvasMode">
            <CanvasMode />
          </ErrorBoundary>
        ) : loopsOpen ? (
          <ErrorBoundary label="LoopsPanel">
            <LoopsPanel />
          </ErrorBoundary>
        ) : filePanelOpen ? (
          <ErrorBoundary label="FilePanel">
            <FilePanel />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary label="CenterArea">
            <CenterArea />
          </ErrorBoundary>
        )}
        </Suspense>

        {/* Right — skills panel */}
        {memoryPanelOpen && (
          <div style={styles.skillsPanel}>
            <ErrorBoundary label="SkillsLibrary">
              <SkillsLibrary />
            </ErrorBoundary>
          </div>
        )}

        {/* Right — preview browser */}
        {previewPanelOpen && (
          <ErrorBoundary label="PreviewPanel">
            <PreviewPanel />
          </ErrorBoundary>
        )}
      </div>
      <SettingsModal />
      {setupModalOpen && (
        <WorkspaceSetupModal onComplete={handleSetupComplete} onClose={closeSetupModal} />
      )}
      <CommandPalette />
      <UpdateBanner />
      <LoadingOverlay />
      <ConfirmDialogHost />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
    background: 'var(--bg-base)',
  },
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  skillsPanel: {
    width: 380,
    flexShrink: 0,
    overflow: 'hidden',
  },
  // Neutral placeholder shown for the brief moment a lazy overlay chunk loads.
  lazyFallback: {
    flex: 1,
    minWidth: 0,
    background: 'var(--bg-base)',
  },
}
