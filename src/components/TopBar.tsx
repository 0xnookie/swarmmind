import React, { useState, useEffect } from 'react'
import { useWorkspaceStore, selectTerminalsVisible } from '../store/workspace'
import { useT } from '../i18n'
import { SwarmVoice } from './SwarmVoice'
import { NotificationCenter } from './NotificationCenter'
import logoUrl from '../assets/logo.png'

interface TopBarProps {
  onTogglePanel: () => void
  panelOpen: boolean
  onTogglePreview: () => void
  previewOpen: boolean
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────

function IconGrid() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function IconCode() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m18 16 4-4-4-4" />
      <path d="m6 8-4 4 4 4" />
      <path d="m14.5 4-5 16" />
    </svg>
  )
}

// Composer (multi-file AI edits) — stacked layers (multi-file) with a sparkle (AI).
function IconComposer() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 2 8 4.5-8 4.5-8-4.5L12 2Z" />
      <path d="m4 12 8 4.5 8-4.5" />
      <path d="m4 17 8 4.5 8-4.5" />
      <path d="M19 2.5v2M20 3.5h-2" />
    </svg>
  )
}

function IconSettings() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

function IconPanelRight() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  )
}

function IconGlobe() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function IconBoard() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="11" rx="1" />
      <rect x="17" y="4" width="4" height="14" rx="1" />
    </svg>
  )
}

function IconGraph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="6" r="2.2" /><circle cx="18" cy="5" r="2.2" /><circle cx="12" cy="13" r="2.6" /><circle cx="7" cy="19" r="2.2" />
      <path d="M7 7.5 10.5 11M14 11.5 16.5 6.8M10.5 14.5 8.2 17.2" />
    </svg>
  )
}

function IconBranch() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="7" r="2.2" />
      <path d="M6 7.2v9.6M18 9.2c0 4-4 4-6 6" />
    </svg>
  )
}

function IconBroadcast() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
    </svg>
  )
}

function IconFiles() {
  // Stacked files — the changes / shared-world-model surface.
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 2H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6z" />
      <path d="M15 2v4h4" />
    </svg>
  )
}

function IconActivity() {
  // A pulse/heartbeat line — the swarm activity feed.
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12h4l2.5-7 5 14 2.5-7H21" />
    </svg>
  )
}

function IconRewind() {
  // A clock with a counter-clockwise arrow — checkpoints / time travel.
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function IconBenchmarks() {
  // A bar-chart / leaderboard glyph — model & agent rankings.
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 21h18" />
      <rect x="5" y="11" width="4" height="7" rx="1" />
      <rect x="10" y="7" width="4" height="11" rx="1" />
      <rect x="15" y="13" width="4" height="5" rx="1" />
    </svg>
  )
}

function IconSwarmAgent() {
  // A speech-bubble with a spark — the conversational assistant.
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
      <path d="M12 8v5M9.5 10.5h5" />
    </svg>
  )
}

function IconLoop() {
  // A repeat/refresh glyph — recurring prompt schedules.
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 2.1 21 6l-4 3.9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 21.9 3 18l4-3.9" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  )
}

function IconConductor() {
  // A hub-and-spoke glyph: a lead node dispatching to workers.
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2.4" />
      <circle cx="5" cy="18" r="2.4" />
      <circle cx="12" cy="18" r="2.4" />
      <circle cx="19" cy="18" r="2.4" />
      <path d="M12 7.4 6.4 15.8M12 7.4v8.2M12 7.4l5.6 8.4" />
    </svg>
  )
}

// ── Icon button ───────────────────────────────────────────────────────────────

interface IconBtnProps {
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
  style?: React.CSSProperties
}

function IconBtn({ label, onClick, active, disabled, children, style }: IconBtnProps) {
  const [hovered, setHovered] = useState(false)
  const showActive = !disabled && (active || hovered)

  const baseStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    color: disabled ? 'var(--text-dim)' : showActive ? 'var(--text-secondary)' : 'var(--text-muted)',
    background: showActive ? 'var(--bg-elevated)' : 'transparent',
    opacity: disabled ? 0.4 : 1,
    transition: 'background 150ms ease-out, color 150ms ease-out',
    position: 'relative',
    ...style,
  }

  return (
    <button
      aria-label={label}
      title={label}
      style={baseStyle}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  )
}

// ── Windows window controls ───────────────────────────────────────────────────

function WinControls() {
  const t = useT()
  const [hoveredBtn, setHoveredBtn] = useState<'min' | 'max' | 'close' | null>(null)

  const btnBase: React.CSSProperties = {
    width: 46,
    height: 38,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    transition: 'background 100ms, color 100ms',
    WebkitAppRegion: 'no-drag',
  }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', marginLeft: 4 }}>
      <button
        aria-label={t('topbar.minimize')}
        title={t('topbar.minimize')}
        style={{
          ...btnBase,
          background: hoveredBtn === 'min' ? 'var(--overlay-hover)' : 'transparent',
        }}
        onClick={() => window.swarmmind.windowMinimize()}
        onMouseEnter={() => setHoveredBtn('min')}
        onMouseLeave={() => setHoveredBtn(null)}
      >
        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button
        aria-label={t('topbar.maximize')}
        title={t('topbar.maximize')}
        style={{
          ...btnBase,
          background: hoveredBtn === 'max' ? 'var(--overlay-hover)' : 'transparent',
        }}
        onClick={() => window.swarmmind.windowMaximize()}
        onMouseEnter={() => setHoveredBtn('max')}
        onMouseLeave={() => setHoveredBtn(null)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
          <rect x="0.5" y="0.5" width="9" height="9"/>
        </svg>
      </button>
      <button
        aria-label={t('common.close')}
        title={t('common.close')}
        style={{
          ...btnBase,
          color: hoveredBtn === 'close' ? '#fff' : 'var(--text-muted)',
          background: hoveredBtn === 'close' ? '#e81123' : 'transparent',
        }}
        onClick={() => window.swarmmind.windowClose()}
        onMouseEnter={() => setHoveredBtn('close')}
        onMouseLeave={() => setHoveredBtn(null)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
          <line x1="0" y1="0" x2="10" y2="10"/><line x1="10" y1="0" x2="0" y2="10"/>
        </svg>
      </button>
    </div>
  )
}

// ── TopBar ────────────────────────────────────────────────────────────────────

export function TopBar({ onTogglePanel, panelOpen, onTogglePreview, previewOpen }: TopBarProps) {
  const t = useT()
  const workspace = useWorkspaceStore(s => s.workspace)
  const openSettings = useWorkspaceStore(s => s.openSettings)
  const showTerminals = useWorkspaceStore(s => s.showTerminals)
  const filePanelOpen = useWorkspaceStore(s => s.filePanelOpen)
  const toggleFilePanel = useWorkspaceStore(s => s.toggleFilePanel)
  // Unsaved editor tabs — badge the code button so the user knows they have
  // unsaved work even while looking at another view (tabs persist across toggles).
  const unsavedCount = useWorkspaceStore(s => s.editorTabs.filter(tab => tab.dirty).length)
  const toggleBroadcastBar = useWorkspaceStore(s => s.toggleBroadcastBar)
  const broadcastBarOpen = useWorkspaceStore(s => s.broadcastBarOpen)
  const toggleBoard = useWorkspaceStore(s => s.toggleBoard)
  const boardOpen = useWorkspaceStore(s => s.boardOpen)
  const toggleGraph = useWorkspaceStore(s => s.toggleGraph)
  const graphOpen = useWorkspaceStore(s => s.graphOpen)
  const toggleReview = useWorkspaceStore(s => s.toggleReview)
  const reviewOpen = useWorkspaceStore(s => s.reviewOpen)
  const toggleComposer = useWorkspaceStore(s => s.toggleComposer)
  const composerOpen = useWorkspaceStore(s => s.composerOpen)
  const toggleTimeline = useWorkspaceStore(s => s.toggleTimeline)
  const timelineOpen = useWorkspaceStore(s => s.timelineOpen)
  const toggleChanges = useWorkspaceStore(s => s.toggleChanges)
  const changesOpen = useWorkspaceStore(s => s.changesOpen)
  const contendedPaths = useWorkspaceStore(s => s.contendedPaths)
  const toggleCheckpoints = useWorkspaceStore(s => s.toggleCheckpoints)
  const checkpointsOpen = useWorkspaceStore(s => s.checkpointsOpen)
  const toggleBenchmarks = useWorkspaceStore(s => s.toggleBenchmarks)
  const benchmarksOpen = useWorkspaceStore(s => s.benchmarksOpen)
  const toggleSwarmAgent = useWorkspaceStore(s => s.toggleSwarmAgent)
  const swarmAgentOpen = useWorkspaceStore(s => s.swarmAgentOpen)
  const toggleLoops = useWorkspaceStore(s => s.toggleLoops)
  const loopsOpen = useWorkspaceStore(s => s.loopsOpen)
  const runningLoops = useWorkspaceStore(s => s.loops.filter(l => l.enabled).length + s.cliLoops.length)
  const paneCost = useWorkspaceStore(s => s.paneCost)
  const toggleOrchestratorBar = useWorkspaceStore(s => s.toggleOrchestratorBar)
  const orchestratorBarOpen = useWorkspaceStore(s => s.orchestratorBarOpen)
  const orchestrationMode = useWorkspaceStore(s => s.orchestrationMode)
  // Broadcast/Orchestrator bars live inside the terminal grid; they can't render
  // over the board/graph/editor overlays, so disable their triggers there.
  const terminalsVisible = useWorkspaceStore(selectTerminalsVisible)

  const totalCost = Object.values(paneCost).reduce((sum, c) => sum + (c?.usd ?? 0), 0)

  // First-run pointer to the SwarmAgent button — the assistant is invisible until
  // opened, so new users miss it. Show a one-time coachmark once they're past the
  // start screen (a workspace is open) and haven't dismissed it before; persisted
  // via the `swarmAgentHintSeen` app setting so it never nags twice.
  const [agentHintVisible, setAgentHintVisible] = useState(false)
  const markAgentHintSeen = () => {
    setAgentHintVisible(false)
    window.swarmmind.setAppSetting('swarmAgentHintSeen', '1').catch(() => {})
  }
  useEffect(() => {
    // Opening the assistant by any route (button, command palette, widget) counts
    // as discovering it — retire the hint for good.
    if (swarmAgentOpen) { markAgentHintSeen(); return }
    if (!workspace) return
    let cancelled = false
    window.swarmmind.getAppSetting('swarmAgentHintSeen')
      .then(v => { if (!cancelled && v !== '1') setAgentHintVisible(true) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspace, swarmAgentOpen])

  return (
    <header
      style={{
        height: 38,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        background: 'var(--bg-base)',
        borderBottom: '1px solid var(--border-subtle)',
        WebkitAppRegion: 'drag',
        userSelect: 'none',
      }}
    >
      {/* Brand + workspace */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          marginLeft: 16,
          gap: 0,
        }}
      >
        {/* App icon */}
        <img
          src={logoUrl}
          alt="SwarmMind"
          width={20}
          height={20}
          draggable={false}
          style={{ borderRadius: 5, flexShrink: 0, display: 'block' }}
        />

        <span
          style={{
            marginLeft: 8,
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-primary)',
            whiteSpace: 'nowrap',
          }}
        >
          SwarmMind
        </span>

        {workspace && (
          <>
            <span
              style={{
                margin: '0 4px',
                color: 'var(--text-muted)',
                fontSize: 14,
              }}
            >
              ›
            </span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 400,
                color: 'var(--text-secondary)',
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={workspace.rootPath}
            >
              {workspace.name}
            </span>
          </>
        )}
      </div>

      {/* Flexible spacer */}
      <div style={{ flex: 1 }} />

      {/* Right cluster */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingRight: 12,
          WebkitAppRegion: 'no-drag',
        }}
      >
        <IconBtn label={t('topbar.showTerminals')} onClick={showTerminals} active={terminalsVisible}>
          <IconGrid />
        </IconBtn>

        <IconBtn label={t('topbar.codeView')} onClick={toggleFilePanel} active={filePanelOpen}>
          <IconCode />
          {unsavedCount > 0 && (
            <span
              title={t('topbar.unsavedFiles', { n: unsavedCount })}
              style={{
                position: 'absolute', top: -1, right: -1, minWidth: 13, height: 13, padding: '0 3px',
                borderRadius: 7, background: 'var(--accent)', color: 'var(--bg-base)',
                fontSize: 9, fontWeight: 700, lineHeight: '13px', textAlign: 'center',
                boxShadow: '0 0 0 1.5px var(--bg-base)',
              }}
            >
              {unsavedCount}
            </span>
          )}
        </IconBtn>

        <IconBtn label={t('topbar.composer')} onClick={toggleComposer} active={composerOpen}>
          <IconComposer />
        </IconBtn>

        <IconBtn label={t('topbar.kanban')} onClick={toggleBoard} active={boardOpen}>
          <IconBoard />
        </IconBtn>

        <IconBtn label={t('topbar.memoryGraph')} onClick={toggleGraph} active={graphOpen}>
          <IconGraph />
        </IconBtn>

        <IconBtn label={t('topbar.worktreeReview')} onClick={toggleReview} active={reviewOpen}>
          <IconBranch />
        </IconBtn>

        <IconBtn label={t('topbar.swarmTimeline')} onClick={toggleTimeline} active={timelineOpen}>
          <IconActivity />
        </IconBtn>

        <IconBtn label={t('topbar.checkpoints')} onClick={toggleCheckpoints} active={checkpointsOpen}>
          <IconRewind />
        </IconBtn>

        <IconBtn label={t('topbar.benchmarks')} onClick={toggleBenchmarks} active={benchmarksOpen}>
          <IconBenchmarks />
        </IconBtn>

        <div style={{ position: 'relative', display: 'inline-flex', WebkitAppRegion: 'no-drag' }}>
          <IconBtn
            label={t('topbar.swarmAgent')}
            onClick={() => { markAgentHintSeen(); toggleSwarmAgent() }}
            active={swarmAgentOpen}
          >
            <IconSwarmAgent />
            {agentHintVisible && <span className="tb-hint-ring" />}
          </IconBtn>
          {agentHintVisible && (
            <div className="tb-coachmark" onClick={e => e.stopPropagation()}>
              <div className="tb-coachmark-title">{t('topbar.agentHint.title')}</div>
              <div className="tb-coachmark-body">{t('topbar.agentHint.body')}</div>
              <button className="tb-coachmark-dismiss" onClick={markAgentHintSeen}>
                {t('topbar.agentHint.dismiss')}
              </button>
            </div>
          )}
        </div>

        <IconBtn label={runningLoops ? t('topbar.loopsRunning', { n: runningLoops }) : t('topbar.loops')} onClick={toggleLoops} active={loopsOpen}>
          <IconLoop />
          {runningLoops > 0 && (
            <span style={{
              position: 'absolute', top: -1, right: -1, minWidth: 13, height: 13, padding: '0 3px',
              borderRadius: 7, background: 'var(--success)', color: 'var(--bg-base)',
              fontSize: 9, fontWeight: 700, lineHeight: '13px', textAlign: 'center',
              boxShadow: '0 0 0 1.5px var(--bg-base)',
            }}>
              {runningLoops}
            </span>
          )}
        </IconBtn>

        <IconBtn label={contendedPaths.length ? t('topbar.changesContended') : t('topbar.changes')} onClick={toggleChanges} active={changesOpen}>
          <IconFiles />
          {contendedPaths.length > 0 && (
            <span style={{
              position: 'absolute', top: 3, right: 3, width: 6, height: 6, borderRadius: '50%',
              background: 'var(--danger, #e5484d)', boxShadow: '0 0 4px var(--danger, #e5484d)',
            }} />
          )}
        </IconBtn>

        <IconBtn label={t('topbar.previewBrowser')} onClick={onTogglePreview} active={previewOpen}>
          <IconGlobe />
        </IconBtn>

        <IconBtn label={terminalsVisible ? t('topbar.broadcast') : t('topbar.broadcastDisabled')} onClick={toggleBroadcastBar} active={broadcastBarOpen} disabled={!terminalsVisible}>
          <IconBroadcast />
        </IconBtn>

        <IconBtn label={terminalsVisible ? t('topbar.orchestrator') : t('topbar.orchestratorDisabled')} onClick={toggleOrchestratorBar} active={orchestratorBarOpen} disabled={!terminalsVisible}>
          <IconConductor />
          {orchestrationMode !== 'off' && (
            <span style={{
              position: 'absolute', top: 3, right: 3, width: 6, height: 6, borderRadius: '50%',
              background: 'var(--success)', boxShadow: '0 0 4px var(--success)',
            }} />
          )}
        </IconBtn>

        {totalCost > 0 && (
          <span
            title={t('topbar.costTooltip')}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
              borderRadius: 999,
              padding: '2px 8px',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            ${totalCost.toFixed(2)}
          </span>
        )}

        <SwarmVoice />

        {/* Divider */}
        <div
          style={{
            width: 1,
            height: 12,
            background: 'var(--border-strong)',
            margin: '0 4px',
            flexShrink: 0,
          }}
        />

        <NotificationCenter />

        <IconBtn label={t('topbar.settings')} onClick={() => openSettings()}>
          <IconSettings />
        </IconBtn>

        <IconBtn label={t('topbar.toggleRightPanel')} onClick={onTogglePanel} active={panelOpen}>
          <IconPanelRight />
        </IconBtn>
      </div>

      {/* Windows window controls */}
      <WinControls />
    </header>
  )
}
