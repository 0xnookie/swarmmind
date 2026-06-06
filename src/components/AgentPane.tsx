import React, { useRef, useState, useEffect, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { usePty } from '../hooks/usePty'
import { SessionPicker } from './SessionPicker'
import { useWorkspaceStore, type AgentId, type PtyStatus } from '../store/workspace'
import { matchEvent, getEffectiveKeys } from '../shortcuts'
import { resolveTemplate, extractInputTokens } from '../lib/skillTemplate'
import '@xterm/xterm/css/xterm.css'

// ── Icons ─────────────────────────────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="5,3 19,12 5,21" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

function CollapseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="10" y1="14" x2="3" y2="21" />
      <line x1="21" y1="3" x2="14" y2="10" />
    </svg>
  )
}

function GripIcon() {
  return (
    <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="2" r="1.2" /><circle cx="6" cy="2" r="1.2" />
      <circle cx="2" cy="6" r="1.2" /><circle cx="6" cy="6" r="1.2" />
      <circle cx="2" cy="10" r="1.2" /><circle cx="6" cy="10" r="1.2" />
    </svg>
  )
}

// ── Agent registry ────────────────────────────────────────────────────────────

const AGENTS: { id: AgentId; label: string; color: string }[] = [
  { id: 'claude',    label: 'Claude Code', color: '#c084fc' },
  { id: 'codex',     label: 'Codex',       color: '#34d399' },
  { id: 'cursor',    label: 'Cursor',      color: '#60a5fa' },
  { id: 'windsurf',  label: 'Windsurf',    color: '#fb923c' },
  { id: 'kilo',      label: 'Kilo Code',   color: '#fbbf24' },
  { id: 'opencode',  label: 'OpenCode',    color: '#f472b6' },
  { id: 'cline',     label: 'Cline',       color: '#a78bfa' },
]

const PANE_COLORS = ['#e8956b', '#34d399', '#60a5fa', '#c084fc', '#fbbf24', '#f472b6']

// ── AgentPane ─────────────────────────────────────────────────────────────────

interface AgentPaneProps {
  paneId: string
  agentId: AgentId | null
  ptyStatus: PtyStatus
  paneCwd?: string | null
  onSplitH: () => void
  onSplitV: () => void
  onClose: () => void
  isExpanded?: boolean
  onToggleExpand?: () => void
  onPaneDragStart?: (e: React.DragEvent) => void
  onPaneDragEnd?: () => void
}

export function AgentPane({ paneId, agentId, ptyStatus, paneCwd, onSplitH, onSplitV, onClose, isExpanded, onToggleExpand, onPaneDragStart, onPaneDragEnd }: AgentPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [skillDragOver, setSkillDragOver] = useState(false)
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Pending {{input:…}} collection for a skill awaiting user-supplied values.
  const [skillInputReq, setSkillInputReq] = useState<{ promptText: string; submit: boolean; labels: string[] } | null>(null)

  const workspace = useWorkspaceStore(s => s.workspace)
  const setAgentId = useWorkspaceStore(s => s.setAgentId)
  const shellStyle = useWorkspaceStore(s => s.shellStyle)
  const setActivePaneId = useWorkspaceStore(s => s.setActivePaneId)
  const activePaneId = useWorkspaceStore(s => s.activePaneId)
  const togglePaneSelected = useWorkspaceStore(s => s.togglePaneSelected)
  const isSelected = useWorkspaceStore(s => s.selectedPaneIds.includes(paneId))
  const getLeafIds = useWorkspaceStore(s => s.getLeafIds)
  const setPaneAttention = useWorkspaceStore(s => s.setPaneAttention)
  const markPaneNotificationsRead = useWorkspaceStore(s => s.markPaneNotificationsRead)
  const attention = useWorkspaceStore(s => s.paneAttention[paneId])
  const setPaneTitle = useWorkspaceStore(s => s.setPaneTitle)
  const setPaneColor = useWorkspaceStore(s => s.setPaneColor)
  const paneTitle = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.title
  })
  const paneColor = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.color
  })
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [editingWorktree, setEditingWorktree] = useState(false)
  const [worktreeNameDraft, setWorktreeNameDraft] = useState('')
  const setPtyStatus = useWorkspaceStore(s => s.setPtyStatus)
  const setAgentRunning = useWorkspaceStore(s => s.setAgentRunning)
  const setSessionId = useWorkspaceStore(s => s.setSessionId)
  const sessionId = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.sessionId
  })
  const pendingAutoSpawn = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.pendingAutoSpawn ?? false
  })
  // Whether the queued auto-spawn should resume the agent's prior conversation.
  const resumeOnSpawn = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.resume ?? false
  })
  const clearPendingAutoSpawn = useWorkspaceStore(s => s.clearPendingAutoSpawn)
  const setPaneWorktree = useWorkspaceStore(s => s.setPaneWorktree)
  const setPaneWorktreeName = useWorkspaceStore(s => s.setPaneWorktreeName)
  const setPaneWorktreeInfo = useWorkspaceStore(s => s.setPaneWorktreeInfo)
  const worktreeEnabled = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.worktree ?? false
  })
  const worktreePath = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.worktreePath ?? null
  })
  const worktreeBranch = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.worktreeBranch ?? null
  })
  const worktreeName = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.worktreeName ?? null
  })

  const agentInfo = AGENTS.find(a => a.id === agentId)
  const effectiveCwd = paneCwd ?? workspace?.rootPath ?? null
  const cwdLabel = paneCwd ? paneCwd.split(/[\\/]/).pop() : null
  const isActive = activePaneId === paneId

  // The store's ptyStatus distinguishes an idle shell (status stays 'idle') from
  // a running coding agent (status 'running'); the exit handler reads it to
  // decide what to do when the process ends.
  const ptyStatusRef = useRef(ptyStatus)
  useEffect(() => { ptyStatusRef.current = ptyStatus }, [ptyStatus])
  const lastShellStartRef = useRef(0)
  const handleExitRef = useRef<(code: number) => void>(() => {})

  const { spawn, spawnShell, kill, clear, fit, injectText, writeNotice, getSelection, getRecentOutput, findNext, findPrevious, clearSearch } =
    usePty(paneId, containerRef, { onExit: code => handleExitRef.current(code) })

  // Pipe: take this pane's selection (or recent output) and route it elsewhere.
  const pipeText = useCallback(() => {
    const sel = getSelection().trim()
    return sel || getRecentOutput(2000)
  }, [getSelection, getRecentOutput])

  const handleShareToMemory = useCallback(() => {
    const text = pipeText()
    if (!text) return
    const key = `share:${agentId ?? 'pane'}:${new Date().toLocaleTimeString()}`
    window.swarmmind.memoryWrite(key, text, 'context', agentId ?? undefined).catch(() => {})
  }, [pipeText, agentId])

  const handleSendToOthers = useCallback(() => {
    const text = pipeText()
    if (!text) return
    for (const id of getLeafIds()) {
      if (id !== paneId) window.swarmmind.ptyInput(id, text)
    }
  }, [pipeText, getLeafIds, paneId])

  // Start a bare interactive shell so the pane always has a live prompt in its
  // cwd when no agent is running.
  const startShell = useCallback(() => {
    if (!effectiveCwd) return
    lastShellStartRef.current = Date.now()
    spawnShell(effectiveCwd, shellStyle)
  }, [effectiveCwd, shellStyle, spawnShell])

  // When the pane is set to run in a git worktree, resolve (creating on first
  // use, reusing the persisted path on resume) the worktree directory and use it
  // as the spawn cwd. Falls back to the normal cwd if the workspace isn't a git
  // repo or worktree creation fails, so a spawn is never blocked.
  const resolveSpawnCwd = useCallback(async (): Promise<string> => {
    if (!worktreeEnabled || !workspace?.rootPath) return effectiveCwd!
    if (worktreePath) return worktreePath
    // Prefer the user-chosen worktree name; otherwise fall back to the pane
    // title, then the agent id.
    const branchHint = worktreeName || paneTitle || agentId || undefined
    const res = await window.swarmmind.gitCreateWorktree(workspace.rootPath, paneId, branchHint)
    if ('error' in res) {
      writeNotice(`worktree disabled: ${res.error}`)
      setPaneWorktree(paneId, false)
      return effectiveCwd!
    }
    setPaneWorktreeInfo(paneId, { path: res.path, branch: res.branch })
    writeNotice(`worktree ready on branch ${res.branch}`)
    return res.path
  }, [worktreeEnabled, workspace, worktreePath, worktreeName, paneTitle, agentId, paneId, effectiveCwd, writeNotice, setPaneWorktree, setPaneWorktreeInfo])

  const handleSpawn = useCallback(async (resume = false, explicitSessionId?: string) => {
    if (!agentId || !effectiveCwd) return
    const spawnCwd = await resolveSpawnCwd()
    setPtyStatus(paneId, 'running')        // marks this pane as agent-occupied
    setAgentRunning(paneId, true)          // persist so the session can resume on reopen
    // Resume a specific picked session, or reuse this pane's stored session id;
    // otherwise mint a fresh one so each pane stays resumable to its own
    // conversation (not just the most-recent one in the directory).
    let sid = explicitSessionId ?? sessionId
    let doResume = resume
    if (explicitSessionId) {
      setSessionId(paneId, explicitSessionId)
      doResume = true
    } else if (!resume || !sid) {
      sid = uuidv4()
      setSessionId(paneId, sid)
      doResume = false
    }
    await spawn(agentId, spawnCwd, shellStyle, undefined, doResume, sid)
  }, [agentId, effectiveCwd, resolveSpawnCwd, spawn, shellStyle, paneId, setPtyStatus, setAgentRunning, setSessionId, sessionId])

  const handleKill = useCallback(async () => { await kill() }, [kill])

  // Remove this pane's worktree from disk (branch kept, so committed work
  // survives). Best done while no agent is running in it.
  const handleRemoveWorktree = useCallback(async () => {
    if (!workspace?.rootPath || !worktreePath) return
    const res = await window.swarmmind.gitRemoveWorktree(workspace.rootPath, worktreePath, worktreeBranch ?? undefined, false)
    if ('error' in res) {
      writeNotice(`worktree remove failed: ${res.error}`)
    } else {
      setPaneWorktreeInfo(paneId, null)
      writeNotice(`worktree removed (branch ${worktreeBranch ?? ''} kept)`)
    }
  }, [workspace, worktreePath, worktreeBranch, paneId, writeNotice, setPaneWorktreeInfo])

  // Open the worktree-name editor, seeding it with the current name (falling
  // back to the pane title, which is the default hint).
  const startEditingWorktreeName = useCallback(() => {
    setWorktreeNameDraft(worktreeName ?? paneTitle ?? '')
    setEditingWorktree(true)
  }, [worktreeName, paneTitle])

  // Save the typed worktree name. If a worktree already exists on disk the name
  // only affects a freshly-created one, so we say so rather than silently
  // pretending the existing branch was renamed.
  const commitWorktreeName = useCallback(() => {
    setPaneWorktreeName(paneId, worktreeNameDraft)
    setEditingWorktree(false)
    if (worktreePath) {
      writeNotice('worktree name saved — applies to a new worktree (remove the current one to rename it)')
    }
  }, [paneId, worktreeNameDraft, worktreePath, setPaneWorktreeName, writeNotice])

  // Decide what happens when the pane's process exits.
  handleExitRef.current = (_code: number) => {
    if (ptyStatusRef.current === 'running') {
      // A coding agent ended (exited or was stopped) → drop back to a shell.
      setPtyStatus(paneId, 'idle')
      setAgentRunning(paneId, false)   // no longer a live agent to resume
      startShell()
    } else {
      // The idle shell ended (e.g. the user typed `exit`) → give them a fresh
      // one, unless it died almost immediately (misconfigured shell), which
      // would otherwise spin in a respawn loop.
      if (Date.now() - lastShellStartRef.current > 1000) startShell()
    }
  }

  // Register as the active pane on first mount, but only if no other pane is selected yet
  useEffect(() => {
    if (!useWorkspaceStore.getState().activePaneId) setActivePaneId(paneId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-spawn the agent (and, after a workspace reopen, resume its prior
  // conversation) once the pane has an agent + cwd. The flag MUST stay set until
  // the spawn is actually kicked off: clearing it synchronously re-renders this
  // component, whose effect cleanup would cancel the pending timer (agent never
  // launches) and let the shell effect start a bare prompt instead. So we clear
  // it inside the timer, after handleSpawn, and use a ref to guard re-entry.
  // Tracks real mount state. Set in the body (not just as initial value) so
  // StrictMode's mount→cleanup→mount cycle leaves it true.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const autoSpawnedRef = useRef(false)
  useEffect(() => {
    if (autoSpawnedRef.current) return
    if (!pendingAutoSpawn || !agentId || !effectiveCwd) return
    autoSpawnedRef.current = true
    const doResume = resumeOnSpawn
    // Deliberately NO clearTimeout cleanup: under React StrictMode this effect
    // runs mount→cleanup→mount, so cancelling the timer in cleanup would kill the
    // only scheduled spawn while the ref guard blocks a reschedule — the agent
    // would never launch. Guard the callback with mountedRef for real unmounts.
    setTimeout(() => {
      if (!mountedRef.current) return
      fit()
      handleSpawn(doResume)
      clearPendingAutoSpawn(paneId)
    }, 200)
  }, [pendingAutoSpawn, agentId, effectiveCwd, resumeOnSpawn])

  // Auto-start the idle shell when a workspace is open and nothing is running in
  // this pane. Skips panes pending an agent auto-spawn, and skips when a process
  // (shell or agent) is already alive — so remounts (splits/resizes/workspace
  // reopen) replay the existing session instead of replacing it.
  useEffect(() => {
    // Also bail when this pane is marked as running an agent (store ptyStatus) or
    // has an auto-spawn in flight: clearing pendingAutoSpawn re-runs this effect
    // microseconds after the agent is launched, and without these guards it would
    // race the spawn and replace the freshly-started agent with a bare shell.
    if (!workspace || !effectiveCwd || pendingAutoSpawn || ptyStatus === 'running' || autoSpawnedRef.current) return
    let cancelled = false
    void (async () => {
      const alive = await window.swarmmind.ptyStatus(paneId)
      if (!cancelled && alive !== 'running') startShell()
    })()
    return () => { cancelled = true }
  }, [workspace, effectiveCwd, pendingAutoSpawn, paneId, startShell, ptyStatus])

  useEffect(() => {
    if (!contextMenu) return
    const handler = () => setContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [contextMenu])

  // Resolve a skill's {{tokens}} against this pane and inject it. `submit` adds a
  // trailing Enter (used by the sidebar Run button); drag-to-paste leaves it off
  // so the user can review before sending. {{input:…}} tokens defer to a modal.
  const runSkillText = useCallback(async (promptText: string, submit: boolean, inputs?: Record<string, string>) => {
    if (!inputs) {
      const labels = extractInputTokens(promptText)
      if (labels.length > 0) {
        setSkillInputReq({ promptText, submit, labels })
        return
      }
    }
    const resolved = await resolveTemplate(promptText, {
      getSelection,
      getRecentOutput,
      cwd: effectiveCwd,
      inputs,
    })
    injectText(submit ? resolved + '\r' : resolved)
  }, [getSelection, getRecentOutput, effectiveCwd, injectText])

  // Sidebar "Run" dispatches a window event targeting the active pane; only the
  // matching pane responds so the prompt lands in exactly one terminal.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { paneId: string; promptText: string; submit?: boolean } | undefined
      if (!detail || detail.paneId !== paneId) return
      void runSkillText(detail.promptText, detail.submit ?? true)
    }
    window.addEventListener('swarmmind:run-skill', handler as EventListener)
    return () => window.removeEventListener('swarmmind:run-skill', handler as EventListener)
  }, [paneId, runSkillText])

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/skill') || e.dataTransfer.types.includes('application/task')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setSkillDragOver(true)
    }
  }
  const handleDragLeave = () => setSkillDragOver(false)
  const handleDrop = (e: React.DragEvent) => {
    setSkillDragOver(false)
    const skill = e.dataTransfer.getData('application/skill')
    if (skill) {
      e.preventDefault()
      const { promptText } = JSON.parse(skill) as { promptText: string }
      void runSkillText(promptText, false)
      return
    }
    const taskRaw = e.dataTransfer.getData('application/task')
    if (taskRaw) {
      e.preventDefault()
      const task = JSON.parse(taskRaw) as { id: string; title: string; description: string | null; notes: string | null; assigned_agent: string | null }
      // Record context to shared memory (MCP serves it), move the task to
      // in-progress, and hand the task to whatever is running in this pane.
      const aid = (agentId ?? task.assigned_agent) as AgentId | null
      window.swarmmind.memoryWrite('current_task', JSON.stringify(task), 'context', aid ?? undefined).catch(() => {})
      window.swarmmind.taskUpdate(task.id, 'in_progress').catch(() => {})
      const prompt = `Work on task: "${task.title}".${task.description ? ' ' + task.description : ''}`
      injectText(prompt + '\r')
    }
  }

  const statusColor: Record<PtyStatus, string> = {
    idle:    'var(--text-dim)',
    running: 'var(--success)',
    exited:  'var(--warning)',
    error:   'var(--error)',
  }

  return (
    <div
      id={`pane-${paneId}`}
      style={styles.pane}
      onPointerDown={() => { setActivePaneId(paneId); markPaneNotificationsRead(paneId); if (attention === 'waiting') setPaneAttention(paneId, null) }}
      onKeyDownCapture={e => {
        if (matchEvent(e, getEffectiveKeys('pane-search', useWorkspaceStore.getState().keybindings))) {
          e.preventDefault(); e.stopPropagation(); setSearchOpen(true)
        }
      }}
    >

      {/* ── Title bar ── */}
      <div
        style={{
          ...styles.titleBar,
          background: isActive ? 'var(--bg-elevated)' : 'var(--bg-panel)',
          cursor: onPaneDragStart ? 'grab' : undefined,
        }}
        draggable={!!onPaneDragStart}
        onDragStart={onPaneDragStart}
        onDragEnd={onPaneDragEnd}
        onClick={e => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); togglePaneSelected(paneId) } }}
        title="Ctrl/⌘-click to select for broadcast"
        onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }) }}
      >
        {isSelected && (
          <span title="Selected for broadcast" style={{ flexShrink: 0, color: 'var(--accent)', display: 'flex' }}>
            <CheckIcon />
          </span>
        )}
        {/* Drag grip */}
        {onPaneDragStart && (
          <span style={styles.dragGrip}>
            <GripIcon />
          </span>
        )}

        {/* Per-pane colour accent */}
        {paneColor && (
          <span style={{ width: 3, alignSelf: 'stretch', background: paneColor, borderRadius: 2, flexShrink: 0, margin: '6px 0' }} />
        )}

        {/* Status dot */}
        <span
          className={`status-dot${ptyStatus === 'running' ? ' status-dot--running' : ''}`}
          style={{ background: statusColor[ptyStatus] }}
        />

        {/* Pane label (custom title overrides agent name; double-click to rename) */}
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onClick={e => e.stopPropagation()}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={() => { setPaneTitle(paneId, titleDraft); setEditingTitle(false) }}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') { setPaneTitle(paneId, titleDraft); setEditingTitle(false) }
              else if (e.key === 'Escape') setEditingTitle(false)
            }}
            style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', background: 'var(--bg-base)', border: '1px solid var(--accent)', borderRadius: 4, padding: '1px 6px', width: 120, outline: 'none', flexShrink: 0 }}
          />
        ) : (
          <span
            onDoubleClick={e => { e.stopPropagation(); setTitleDraft(paneTitle ?? agentInfo?.label ?? ''); setEditingTitle(true) }}
            title="Double-click to rename pane"
            style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', flexShrink: 0 }}
          >
            {paneTitle || (agentInfo ? agentInfo.label : <em style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>No agent</em>)}
          </span>
        )}

        {/* Attention badge — agent finished a turn / awaiting input */}
        {ptyStatus === 'running' && attention === 'waiting' && (
          <span style={styles.waitingBadge} title="Agent is waiting for input">waiting</span>
        )}

        {/* CWD badge */}
        {cwdLabel && (
          <span style={styles.cwdLabel} title={paneCwd ?? ''}>
            {cwdLabel}
          </span>
        )}

        {/* Git worktree badge (double-click to name; editor also opens when
            naming via the context menu before the worktree is enabled) */}
        {editingWorktree ? (
          <input
            autoFocus
            value={worktreeNameDraft}
            placeholder="worktree name"
            spellCheck={false}
            onClick={e => e.stopPropagation()}
            onChange={e => setWorktreeNameDraft(e.target.value)}
            onBlur={commitWorktreeName}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') commitWorktreeName()
              else if (e.key === 'Escape') setEditingWorktree(false)
            }}
            style={{ fontSize: 11, color: 'var(--text-primary)', background: 'var(--bg-base)', border: '1px solid var(--accent)', borderRadius: 4, padding: '1px 6px', width: 130, outline: 'none', flexShrink: 0 }}
          />
        ) : worktreeEnabled ? (
          <span
            style={{ ...styles.worktreeBadge, cursor: worktreeBranch ? 'default' : 'pointer' }}
            onDoubleClick={e => { e.stopPropagation(); if (!worktreeBranch) startEditingWorktreeName() }}
            title={
              worktreeBranch
                ? `Isolated worktree on branch ${worktreeBranch}`
                : 'Worktree created on next spawn — double-click to name it'
            }
          >
            ⑂ {worktreeBranch ? worktreeBranch.replace(/^swarmmind\//, '') : (worktreeName || 'worktree')}
          </span>
        ) : null}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Actions */}
        <div style={styles.actions} draggable={false} onMouseDown={e => e.stopPropagation()}>
          {ptyStatus !== 'running' ? (
            <button
              className="pane-action-btn"
              data-variant="success"
              onClick={() => handleSpawn()}
              disabled={!agentId || !effectiveCwd}
              title="Spawn agent"
            >
              <PlayIcon />
            </button>
          ) : (
            <button className="pane-action-btn" data-variant="danger" onClick={handleKill} title="Kill process">
              <StopIcon />
            </button>
          )}
          <button className="pane-action-btn" onClick={clear} title="Clear terminal">
            <TrashIcon />
          </button>
          {onToggleExpand && (
            <button
              className="pane-action-btn"
              onClick={onToggleExpand}
              title={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? <CollapseIcon /> : <ExpandIcon />}
            </button>
          )}
          <button className="pane-action-btn" data-variant="danger" onClick={onClose} title="Close pane">
            <XIcon />
          </button>
        </div>
      </div>

      {/* ── Terminal ── */}
      <div
        style={{ ...styles.terminalWrap, ...(skillDragOver ? styles.terminalDragOver : {}) }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {searchOpen && (
          <div style={styles.searchBox}>
            <input
              autoFocus
              style={styles.searchInput}
              value={searchQuery}
              placeholder="Find in terminal…"
              spellCheck={false}
              onChange={e => { setSearchQuery(e.target.value); findNext(e.target.value) }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) findPrevious(searchQuery); else findNext(searchQuery) }
                else if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); clearSearch() }
              }}
            />
            <button style={styles.searchBtn} onClick={() => findPrevious(searchQuery)} title="Previous (Shift+Enter)">↑</button>
            <button style={styles.searchBtn} onClick={() => findNext(searchQuery)} title="Next (Enter)">↓</button>
            <button style={styles.searchBtn} onClick={() => { setSearchOpen(false); clearSearch() }} title="Close (Esc)">✕</button>
          </div>
        )}
        {skillDragOver && (
          <div style={styles.dropOverlay}>
            <span style={styles.dropOverlayText}>Drop skill or task here</span>
          </div>
        )}
        {!workspace && (
          <div style={styles.emptyState}>
            <p>Open a workspace to get started</p>
          </div>
        )}
        <div ref={containerRef} style={{ ...styles.terminal, opacity: !workspace ? 0 : 1 }} />
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <div style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }}>
          <button className="ctx-menu-item" onClick={() => { onSplitH(); setContextMenu(null) }}>Split Right</button>
          <button className="ctx-menu-item" onClick={() => { onSplitV(); setContextMenu(null) }}>Split Down</button>
          <div style={styles.ctxDivider} />
          <button className="ctx-menu-item" onClick={() => { setContextMenu(null); setTitleDraft(paneTitle ?? agentInfo?.label ?? ''); setEditingTitle(true) }}>Rename pane…</button>
          <div style={{ display: 'flex', gap: 6, padding: '6px 14px', alignItems: 'center' }}>
            {PANE_COLORS.map(c => (
              <button key={c} onClick={() => { setPaneColor(paneId, c); setContextMenu(null) }}
                style={{ width: 15, height: 15, borderRadius: '50%', background: c, border: paneColor === c ? '2px solid var(--text-primary)' : 'none', cursor: 'pointer', padding: 0 }} />
            ))}
            <button onClick={() => { setPaneColor(paneId, null); setContextMenu(null) }} title="No colour"
              style={{ width: 15, height: 15, borderRadius: '50%', background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer', padding: 0 }} />
          </div>
          {agentId === 'claude' && (
            <>
              <div style={styles.ctxDivider} />
              <button className="ctx-menu-item" onClick={() => { setContextMenu(null); setSessionPickerOpen(true) }}>Resume session…</button>
              <button
                className="ctx-menu-item"
                onClick={() => { setPaneWorktree(paneId, !worktreeEnabled); setContextMenu(null) }}
                title="Run this pane's agent in an isolated git worktree/branch"
              >
                <span style={{ flex: 1 }}>Run in git worktree</span>
                {worktreeEnabled && <CheckIcon />}
              </button>
              {!worktreeBranch && (
                <button
                  className="ctx-menu-item"
                  onClick={() => { setContextMenu(null); startEditingWorktreeName() }}
                  title="Set the branch name for this pane's worktree (defaults to the pane title)"
                >
                  Name worktree…
                </button>
              )}
              {worktreePath && (
                <button className="ctx-menu-item" data-variant="danger" onClick={() => { handleRemoveWorktree(); setContextMenu(null) }}>
                  Remove worktree (keep branch)
                </button>
              )}
            </>
          )}
          <div style={styles.ctxDivider} />
          <div style={styles.ctxLabel}>Pipe (selection or recent output)</div>
          <button className="ctx-menu-item" onClick={() => { handleShareToMemory(); setContextMenu(null) }}>Send → shared memory</button>
          <button className="ctx-menu-item" onClick={() => { handleSendToOthers(); setContextMenu(null) }}>Send → other panes</button>
          <div style={styles.ctxDivider} />
          <div style={styles.ctxLabel}>Switch agent</div>
          {AGENTS.map(a => (
            <button
              key={a.id}
              className="ctx-menu-item"
              onClick={() => { setAgentId(paneId, a.id); setContextMenu(null) }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: a.color, flexShrink: 0 }} />
              <span style={{ flex: 1, color: agentId === a.id ? a.color : undefined }}>{a.label}</span>
              {agentId === a.id && <CheckIcon />}
            </button>
          ))}
          <div style={styles.ctxDivider} />
          <button className="ctx-menu-item" data-variant="danger" onClick={() => { onClose(); setContextMenu(null) }}>
            Close Pane
          </button>
        </div>
      )}

      {/* ── Session picker (Claude) ── */}
      {sessionPickerOpen && effectiveCwd && (
        <SessionPicker
          rootPath={effectiveCwd}
          onClose={() => setSessionPickerOpen(false)}
          onPick={(id) => { setSessionPickerOpen(false); handleSpawn(true, id) }}
        />
      )}

      {/* ── Skill {{input:…}} collection ── */}
      {skillInputReq && (
        <SkillInputModal
          labels={skillInputReq.labels}
          onCancel={() => setSkillInputReq(null)}
          onSubmit={(inputs) => {
            const req = skillInputReq
            setSkillInputReq(null)
            void runSkillText(req.promptText, req.submit, inputs)
          }}
        />
      )}
    </div>
  )
}

// ── Skill input modal ─────────────────────────────────────────────────────────
// Collects one value per {{input:Label}} token before a skill is injected.
function SkillInputModal({ labels, onSubmit, onCancel }: {
  labels: string[]
  onSubmit: (inputs: Record<string, string>) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const firstRef = useRef<HTMLInputElement>(null)
  useEffect(() => { firstRef.current?.focus() }, [])

  const submit = () => {
    const inputs: Record<string, string> = {}
    for (const l of labels) inputs[l.toLowerCase()] = values[l] ?? ''
    onSubmit(inputs)
  }

  return (
    <div
      style={{
        position: 'absolute', inset: 0, zIndex: 40,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onCancel}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(420px, 90%)',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          padding: 16,
          display: 'flex', flexDirection: 'column', gap: 12,
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          Fill in skill values
        </div>
        {labels.map((label, i) => (
          <label key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{label}</span>
            <input
              ref={i === 0 ? firstRef : undefined}
              value={values[label] ?? ''}
              onChange={(e) => setValues(v => ({ ...v, [label]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6, color: 'var(--text-primary)',
                padding: '6px 9px', fontSize: 12, outline: 'none', fontFamily: 'inherit',
              }}
            />
          </label>
        ))}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{ background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-muted)', padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            style={{ background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'var(--accent-fg)', padding: '5px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  pane: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    width: '100%',
    overflow: 'hidden',
    position: 'relative',
  },
  titleBar: {
    height: 38,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 6px 0 10px',
    flexShrink: 0,
    transition: 'background 150ms',
  },
  noAgent: {
    fontSize: 11.5,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  waitingBadge: {
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--accent)',
    background: 'var(--accent-subtle)',
    border: '1px solid rgba(212,132,90,0.3)',
    borderRadius: 9999,
    padding: '1px 7px',
    flexShrink: 0,
  },
  cwdLabel: {
    fontSize: 10,
    color: 'var(--text-secondary)',
    background: 'var(--bg-elevated-2)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '1px 7px',
    maxWidth: 110,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    letterSpacing: '0.01em',
  },
  worktreeBadge: {
    fontSize: 10,
    color: 'var(--accent)',
    background: 'var(--accent-subtle)',
    border: '1px solid var(--accent)',
    borderRadius: 10,
    padding: '1px 7px',
    maxWidth: 140,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    letterSpacing: '0.01em',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
  },
  dragGrip: {
    display: 'flex',
    alignItems: 'center',
    color: 'var(--text-dim)',
    opacity: 0.45,
    flexShrink: 0,
    marginRight: 2,
  },
  terminalWrap: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    position: 'relative',
    background: 'var(--bg-terminal)',
    transition: 'box-shadow 0.15s',
  },
  terminalDragOver: {
    boxShadow: 'inset 0 0 0 2px var(--accent)',
  },
  searchBox: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 20,
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 4,
    boxShadow: 'var(--shadow-lg)',
  },
  searchInput: {
    background: 'var(--bg-base)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: 12,
    padding: '4px 8px',
    width: 180,
    outline: 'none',
  },
  searchBtn: {
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    borderRadius: 4,
    fontSize: 12,
  },
  terminal: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  dropOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'var(--accent-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    backdropFilter: 'blur(2px)',
  },
  dropOverlayText: {
    color: 'var(--accent)',
    fontWeight: 700,
    fontSize: 14,
    letterSpacing: '0.04em',
    background: 'var(--bg-panel)',
    padding: '8px 18px',
    borderRadius: 8,
    border: '1px solid var(--accent)',
    boxShadow: '0 0 16px var(--accent-glow)',
  },
  emptyState: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-dim)',
    fontSize: 13,
    zIndex: 1,
  },
  contextMenu: {
    position: 'fixed',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
    zIndex: 1000,
    boxShadow: 'var(--shadow-lg)',
    minWidth: 170,
    padding: '4px 0',
  },
  ctxDivider: {
    height: 1,
    background: 'var(--border-subtle)',
    margin: '4px 0',
  },
  ctxLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-muted)',
    padding: '5px 14px 3px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    userSelect: 'none',
  },
}
