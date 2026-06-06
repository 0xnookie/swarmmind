import React, { useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { CenterArea } from './components/CenterArea'
import { FilePanel } from './components/FilePanel'
import { SkillsLibrary } from './components/SkillsLibrary'
import { PreviewPanel } from './components/PreviewPanel'
import WorkspaceSidebar from './components/WorkspaceSidebar'
import { KanbanBoard } from './components/KanbanBoard'
import { MemoryView } from './components/MemoryView'
import { WorktreeReview } from './components/WorktreeReview'
import { SwarmTimeline } from './components/SwarmTimeline'
import { ChangesPanel } from './components/ChangesPanel'
import { CheckpointPanel } from './components/CheckpointPanel'
import { StartScreen } from './components/StartScreen'
import { SettingsModal } from './components/SettingsModal'
import { WorkspaceSetupModal } from './components/WorkspaceSetupModal'
import { CommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useConductor } from './hooks/useConductor'
import { useWorkspaceStore, buildLayoutForCount, type AgentId, type ShellStyle } from './store/workspace'
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
  const timelineOpen = useWorkspaceStore(s => s.timelineOpen)
  const changesOpen = useWorkspaceStore(s => s.changesOpen)
  const checkpointsOpen = useWorkspaceStore(s => s.checkpointsOpen)
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

    // Appearance — load all keys, then hydrate + apply once (validating each so
    // a stale/unknown persisted value falls back to the store default).
    Promise.all([
      window.swarmmind.getAppSetting('themePreset'),
      window.swarmmind.getAppSetting('accentColor'),
      window.swarmmind.getAppSetting('uiDensity'),
      window.swarmmind.getAppSetting('uiFont'),
      window.swarmmind.getAppSetting('monoFont'),
    ]).then(([theme, accent, density, uiFont, monoFont]) => {
      useWorkspaceStore.getState().hydrateAppearance({
        themePreset: theme && theme in THEMES ? (theme as ThemePreset) : undefined,
        accentColor: accent ? accent : (accent === '' ? null : undefined),
        uiDensity: density === 'compact' || density === 'default' || density === 'comfortable'
          ? (density as UiDensity) : undefined,
        uiFont: uiFont && uiFont in UI_FONTS ? (uiFont as UiFontId) : undefined,
        monoFont: monoFont && monoFont in MONO_FONTS ? (monoFont as MonoFontId) : undefined,
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
      setPaneAttention(paneId, state)
    })
    // The discrete "needs you" event: the agent is actually blocked on an answer
    // (a question/prompt was detected), so record it for the notification center
    // (deduped per pane while still unread).
    const unsubAttention = window.swarmmind.onPtyAttention((paneId) => addPaneNotification(paneId))
    const unsubExit = window.swarmmind.onPtyExit((paneId) => setPaneAttention(paneId, null))
    // Keep cost + contention state fresh from swarm events even when their
    // overlays aren't open (drives the TopBar cost pill and contention dot).
    const unsubEvent = window.swarmmind.onSwarmEvent((ev) => {
      if (!ev) return
      if (ev.type === 'cost' && ev.pane_id) {
        const usd = Number((ev.payload as { usd?: number } | null)?.usd ?? 0)
        const tokens = Number((ev.payload as { tokens?: number } | null)?.tokens ?? 0)
        if (Number.isFinite(usd)) useWorkspaceStore.getState().updatePaneCost(ev.pane_id, usd, tokens)
      } else if (ev.type === 'contention') {
        const path = (ev.payload as { path?: string } | null)?.path
        if (path) useWorkspaceStore.getState().addContendedPath(path)
      }
    })
    return () => { unsubState(); unsubAttention(); unsubExit(); unsubEvent() }
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
        e.preventDefault()
        switch (def.id) {
          case 'command-palette': s.toggleCommandPalette(); break
          case 'broadcast': s.toggleBroadcastBar(); break
          case 'settings': s.openSettings(); break
          case 'new-pane': s.addPane(); break
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
            board / graph overlays take precedence over the pane grid */}
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
        ) : filePanelOpen ? (
          <ErrorBoundary label="FilePanel">
            <FilePanel />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary label="CenterArea">
            <CenterArea />
          </ErrorBoundary>
        )}

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
}
