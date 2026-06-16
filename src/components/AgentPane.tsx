import React, { useRef, useState, useEffect, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { usePty } from '../hooks/usePty'
import { SessionPicker } from './SessionPicker'
import { useWorkspaceStore, type AgentId, type PtyStatus } from '../store/workspace'
import { AGENTS, AgentIcon } from '../data/agents'
import { matchEvent, getEffectiveKeys } from '../shortcuts'
import { resolveTemplate, extractInputTokens } from '../lib/skillTemplate'
import { useT } from '../i18n'
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

function UserIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
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
// Shared source of truth (id/label/colour/icon) lives in src/data/agents.tsx.

const PANE_COLORS = ['#e8956b', '#34d399', '#60a5fa', '#c084fc', '#fbbf24', '#f472b6']

interface AgentAccount {
  id: string
  label: string
  // CLI-login accounts carry a profile dir (credential lives there); API-key
  // accounts carry an apiKey instead. Used to label the account's type.
  profileDir?: string
  apiKey?: string
  model?: string
  env?: Record<string, string>
}

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
  // In fullscreen, every pane stays mounted and only the active one is shown.
  // `isVisible` is false for the hidden background tabs; it drives the
  // refit-and-focus when a pane becomes the visible tab. Defaults to true for
  // the grid view (all panes visible).
  isVisible?: boolean
  onToggleExpand?: () => void
  onPaneDragStart?: (e: React.DragEvent) => void
  onPaneDragEnd?: () => void
}

export function AgentPane({ paneId, agentId, ptyStatus, paneCwd, onSplitH, onSplitV, onClose, isExpanded, isVisible = true, onToggleExpand, onPaneDragStart, onPaneDragEnd }: AgentPaneProps) {
  const t = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [skillDragOver, setSkillDragOver] = useState(false)
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Pending {{input:…}} collection for a skill awaiting user-supplied values.
  const [skillInputReq, setSkillInputReq] = useState<{ promptText: string; submit: boolean; labels: string[] } | null>(null)
  // Boot loader state: shows a swarm animation over the black terminal while a
  // shell/agent is starting and nothing has been drawn yet. 'leaving' plays the
  // fade-out once the first output lands; an effect then unmounts it.
  const [boot, setBoot] = useState<'off' | 'on' | 'leaving'>('off')
  const startBooting = useCallback(() => setBoot('on'), [])
  // Flip to fade-out only if the loader is currently showing; ignore output that
  // arrives when no boot is in progress (e.g. a live reconnect's cache replay).
  const handleOutput = useCallback(() => setBoot(b => (b === 'on' ? 'leaving' : b)), [])
  // Remove the loader after its fade-out animation finishes.
  useEffect(() => {
    if (boot !== 'leaving') return
    const id = setTimeout(() => setBoot('off'), 340)
    return () => clearTimeout(id)
  }, [boot])
  // Safety net: never let the loader linger if a process produces no output.
  useEffect(() => {
    if (boot !== 'on') return
    const id = setTimeout(() => setBoot('leaving'), 12000)
    return () => clearTimeout(id)
  }, [boot])

  const workspace = useWorkspaceStore(s => s.workspace)
  const setAgentId = useWorkspaceStore(s => s.setAgentId)
  const shellStyle = useWorkspaceStore(s => s.shellStyle)
  const setActivePaneId = useWorkspaceStore(s => s.setActivePaneId)
  const activePaneId = useWorkspaceStore(s => s.activePaneId)
  const togglePaneSelected = useWorkspaceStore(s => s.togglePaneSelected)
  const isSelected = useWorkspaceStore(s => s.selectedPaneIds.includes(paneId))
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
  // Task queued for this pane by the Kanban "Launch Agent" button. Injected as a
  // prompt once the freshly spawned agent is ready (see the auto-task effect).
  const leafTaskId = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.taskId ?? null
  })
  const setTaskId = useWorkspaceStore(s => s.setTaskId)
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
  // Mixed-workspace binding: the workspace this pane's agent belongs to, if it
  // isn't the host workspace.
  const paneWorkspaceId = useWorkspaceStore(s => {
    function findLeaf(node: import('../store/workspace').PaneNode): import('../store/workspace').PaneLeaf | null {
      if (node.type === 'leaf') return node.id === paneId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.workspaceId
  })
  const setPaneWorkspace = useWorkspaceStore(s => s.setPaneWorkspace)

  // Known workspaces, for the "Run from workspace" context-menu submenu and for
  // resolving a foreign pane's root/name. Refreshed when the menu opens.
  const [knownWorkspaces, setKnownWorkspaces] = useState<{ id: string; name: string; root_path: string }[]>([])
  useEffect(() => {
    window.swarmmind.workspaceList()
      .then(l => { if (Array.isArray(l)) setKnownWorkspaces(l as { id: string; name: string; root_path: string }[]) })
      .catch(() => {})
  }, [contextMenu, paneWorkspaceId])

  // Connected accounts for this pane's agent — drives both the title-bar badge
  // and the in-menu quick switcher. Loaded on agent change, and re-loaded each
  // time the context menu opens so a switch made elsewhere (Settings, another
  // pane) is reflected.
  const [paneAccounts, setPaneAccounts] = useState<{ accounts: AgentAccount[]; activeId?: string }>({ accounts: [] })
  const loadAccounts = useCallback(() => {
    if (!agentId) { setPaneAccounts({ accounts: [] }); return }
    window.swarmmind.listAgentAccounts(agentId)
      .then(res => setPaneAccounts({ accounts: res?.accounts ?? [], activeId: res?.activeId }))
      .catch(() => {})
  }, [agentId])
  useEffect(() => { loadAccounts() }, [loadAccounts])
  useEffect(() => { if (contextMenu) loadAccounts() }, [contextMenu, loadAccounts])
  // The account currently in effect for this pane's agent (falls back to the
  // first connected one, matching the main-process spawn resolution).
  const activeAccount = paneAccounts.accounts.find(a => a.id === paneAccounts.activeId) ?? paneAccounts.accounts[0]
  const openSettings = useWorkspaceStore(s => s.openSettings)

  const agentInfo = AGENTS.find(a => a.id === agentId)
  // Resolve the pane's owning workspace. A foreign pane (workspaceId set) uses
  // that workspace's root; otherwise the host workspace. ownerWorkspace is null
  // if the bound workspace no longer exists (e.g. it was deleted).
  const isForeign = !!paneWorkspaceId && paneWorkspaceId !== workspace?.id
  const ownerWorkspace = isForeign ? knownWorkspaces.find(w => w.id === paneWorkspaceId) ?? null : null
  const ownerRootPath = isForeign ? (ownerWorkspace?.root_path ?? null) : (workspace?.rootPath ?? null)
  const effectiveCwd = paneCwd ?? ownerRootPath
  const cwdLabel = paneCwd ? paneCwd.split(/[\\/]/).pop() : null
  const isActive = activePaneId === paneId

  // The store's ptyStatus distinguishes an idle shell (status stays 'idle') from
  // a running coding agent (status 'running'); the exit handler reads it to
  // decide what to do when the process ends.
  const ptyStatusRef = useRef(ptyStatus)
  useEffect(() => { ptyStatusRef.current = ptyStatus }, [ptyStatus])
  const lastShellStartRef = useRef(0)
  const handleExitRef = useRef<(code: number) => void>(() => {})

  const { spawn, spawnShell, kill, clear, fit, focus, injectText, writeNotice, getSelection, copySelection, paste, getRecentOutput, findNext, findPrevious, clearSearch } =
    usePty(paneId, containerRef, { onExit: code => handleExitRef.current(code), onOutput: handleOutput })

  // When this pane becomes the visible fullscreen tab, it was just un-hidden
  // (display:none → flex). The ResizeObserver refits it on the size change, but
  // we also force a fit (in case the observer doesn't fire) and pull keyboard
  // focus into its terminal so cycling tabs lands the cursor without a click.
  // Gated on isExpanded so the grid view (all panes isVisible) never steals
  // focus on mount.
  useEffect(() => {
    if (!isExpanded || !isVisible) return
    const id = requestAnimationFrame(() => { fit(); focus() })
    return () => cancelAnimationFrame(id)
  }, [isExpanded, isVisible, fit, focus])

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
    // Only pipe to panes that belong to the same workspace as this one, so a
    // mixed-workspace pane never leaks output into another workspace's agents
    // (and vice-versa). Walk the live tree to read each leaf's binding.
    const targets: string[] = []
    const walk = (node: import('../store/workspace').PaneNode) => {
      if (node.type === 'leaf') {
        if (node.id !== paneId && (node.workspaceId ?? undefined) === (paneWorkspaceId ?? undefined)) targets.push(node.id)
      } else node.children.forEach(walk)
    }
    walk(useWorkspaceStore.getState().rootPane)
    for (const id of targets) window.swarmmind.ptyInput(id, text)
  }, [pipeText, paneId, paneWorkspaceId])

  // Start a bare interactive shell so the pane always has a live prompt in its
  // cwd when no agent is running.
  const startShell = useCallback(() => {
    if (!effectiveCwd) return
    lastShellStartRef.current = Date.now()
    startBooting()
    spawnShell(effectiveCwd, shellStyle)
  }, [effectiveCwd, shellStyle, spawnShell, startBooting])

  // When the pane is set to run in a git worktree, resolve (creating on first
  // use, reusing the persisted path on resume) the worktree directory and use it
  // as the spawn cwd. Falls back to the normal cwd if the workspace isn't a git
  // repo or worktree creation fails, so a spawn is never blocked.
  const resolveSpawnCwd = useCallback(async (): Promise<string> => {
    // Worktrees are rooted at the pane's owning workspace (the foreign root for a
    // mixed-workspace pane), not necessarily the host.
    if (!worktreeEnabled || !ownerRootPath) return effectiveCwd!
    if (worktreePath) return worktreePath
    // Prefer the user-chosen worktree name; otherwise fall back to the pane
    // title, then the agent id.
    const branchHint = worktreeName || paneTitle || agentId || undefined
    const res = await window.swarmmind.gitCreateWorktree(ownerRootPath, paneId, branchHint)
    if ('error' in res) {
      writeNotice(t('pane.notice.worktreeDisabled', { error: res.error }))
      setPaneWorktree(paneId, false)
      return effectiveCwd!
    }
    setPaneWorktreeInfo(paneId, { path: res.path, branch: res.branch })
    writeNotice(t('pane.notice.worktreeReady', { branch: res.branch }))
    return res.path
  }, [worktreeEnabled, ownerRootPath, worktreePath, worktreeName, paneTitle, agentId, paneId, effectiveCwd, writeNotice, setPaneWorktree, setPaneWorktreeInfo])

  const handleSpawn = useCallback(async (resume = false, explicitSessionId?: string) => {
    if (!agentId || !effectiveCwd) return
    startBooting()
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
    await spawn(agentId, spawnCwd, shellStyle, undefined, doResume, sid, paneWorkspaceId)
  }, [agentId, effectiveCwd, resolveSpawnCwd, spawn, shellStyle, paneId, setPtyStatus, setAgentRunning, setSessionId, sessionId, paneWorkspaceId, startBooting])

  const handleKill = useCallback(async () => { await kill() }, [kill])

  // Quick-switch the active global account for this pane's agent. Accounts are
  // applied at spawn time (the credential env is injected when the process
  // starts), so the switch only takes effect on (re)launch. If an agent is live
  // in this pane we restart it right here — resuming its session — so the new
  // login is in effect immediately instead of leaving the user to stop/start by
  // hand; otherwise the next spawn just picks it up. (ptyCreate replaces the old
  // process silently, so there's no shell flash between kill and respawn.)
  const switchAccount = useCallback(async (acc: AgentAccount) => {
    if (!agentId) return
    const label = acc.label || acc.id
    if (acc.id === (paneAccounts.activeId ?? paneAccounts.accounts[0]?.id)) return  // already active — no-op
    await window.swarmmind.setActiveAgentAccount(agentId, acc.id)
    setPaneAccounts(prev => ({ ...prev, activeId: acc.id }))
    if (ptyStatusRef.current === 'running') {
      writeNotice(t('pane.ctx.accountSwitchedRestart', { label }))
      await handleSpawn(true)
    } else {
      writeNotice(t('pane.ctx.accountSwitched', { label }))
    }
  }, [agentId, paneAccounts, writeNotice, t, handleSpawn])

  // Remove this pane's worktree from disk (branch kept, so committed work
  // survives). Best done while no agent is running in it.
  const handleRemoveWorktree = useCallback(async () => {
    if (!ownerRootPath || !worktreePath) return
    const res = await window.swarmmind.gitRemoveWorktree(ownerRootPath, worktreePath, worktreeBranch ?? undefined, false)
    if ('error' in res) {
      writeNotice(t('pane.notice.worktreeRemoveFailed', { error: res.error }))
    } else {
      setPaneWorktreeInfo(paneId, null)
      writeNotice(t('pane.notice.worktreeRemoved', { branch: worktreeBranch ?? '' }))
    }
  }, [ownerRootPath, worktreePath, worktreeBranch, paneId, writeNotice, setPaneWorktreeInfo])

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
      writeNotice(t('pane.notice.worktreeNameSaved'))
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
    setTimeout(async () => {
      if (!mountedRef.current) return
      fit()
      // If this pane's agent is still alive (it kept running while the user was
      // in another workspace), reconnect to it rather than respawning — a
      // respawn would kill the live session. usePty replays the cached output
      // and the live pty resumes streaming once its listener re-attaches.
      const alive = await window.swarmmind.ptyStatus(paneId)
      if (!mountedRef.current) return
      if (alive === 'running') {
        setPtyStatus(paneId, 'running')
        setAgentRunning(paneId, true)
      } else {
        handleSpawn(doResume)
      }
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

  // Deliver a task queued by the Kanban "Launch Agent" button. The pane is
  // spawned with a `taskId`, but a freshly launched CLI can't accept input for a
  // second or two while it boots, so we can't inject immediately. Strategy:
  //   • Fast path — inject as soon as the agent boots and goes quiet
  //     (`attention === 'waiting'`, the same "at prompt / finished a turn" signal
  //     the conductor uses).
  //   • Fallback — if the agent never reports idle (startup spinner/animation
  //     keeps the activity signal 'working', or the idle threshold is long),
  //     inject anyway a few seconds after launch so the task always lands.
  // A ref guards against sending twice; `setTaskId(null)` clears the queue so it
  // never re-fires when the agent later goes idle again.
  const injectedTaskRef = useRef<string | null>(null)
  const taskFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deliverTask = useCallback(async (tid: string) => {
    if (injectedTaskRef.current === tid) return
    injectedTaskRef.current = tid
    if (taskFallbackRef.current) { clearTimeout(taskFallbackRef.current); taskFallbackRef.current = null }
    const list = await window.swarmmind.taskList() as Array<{ id: string; title: string; description: string | null }>
    const task = list?.find(t => t.id === tid)
    if (!task || !mountedRef.current) { setTaskId(paneId, null); return }
    const prompt = t('pane.taskPrompt', { title: task.title }) + (task.description ? ' ' + task.description : '')
    // Send the prompt and the Enter as SEPARATE writes (mirrors the working
    // conductor `inject`). TUI CLIs (e.g. Claude Code) treat a paste+newline in
    // one write as literal text and never submit it; a distinct, slightly delayed
    // carriage return reliably triggers submission.
    injectText(prompt)
    setTimeout(() => { if (mountedRef.current) injectText('\r') }, 120)
    setTaskId(paneId, null)
  }, [paneId, setTaskId, injectText, t])

  useEffect(() => {
    if (!leafTaskId || ptyStatus !== 'running') return
    if (injectedTaskRef.current === leafTaskId) return
    if (attention === 'waiting') { void deliverTask(leafTaskId); return }
    if (!taskFallbackRef.current) {
      const tid = leafTaskId
      taskFallbackRef.current = setTimeout(() => {
        taskFallbackRef.current = null
        if (mountedRef.current) void deliverTask(tid)
      }, 10000)
    }
  }, [leafTaskId, ptyStatus, attention, deliverTask])

  // Drop any pending fallback if the pane goes away before it fires.
  useEffect(() => () => { if (taskFallbackRef.current) clearTimeout(taskFallbackRef.current) }, [])

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
      const prompt = t('pane.taskPrompt', { title: task.title }) + (task.description ? ' ' + task.description : '')
      // Separate writes for the prompt and the Enter so TUI agents submit it
      // (see deliverTask for the rationale).
      injectText(prompt)
      setTimeout(() => injectText('\r'), 120)
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
        title={t('pane.selectForBroadcast')}
        onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }) }}
      >
        {isSelected && (
          <span title={t('pane.selectedForBroadcast')} style={{ flexShrink: 0, color: 'var(--accent)', display: 'flex' }}>
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
            title={t('pane.renameTitle')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', flexShrink: 0 }}
          >
            {agentId && <AgentIcon id={agentId} size={14} />}
            {paneTitle || (agentInfo ? agentInfo.label : <em style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>{t('pane.noAgent')}</em>)}
          </span>
        )}

        {/* Attention badge — agent finished a turn / awaiting input */}
        {ptyStatus === 'running' && attention === 'waiting' && (
          <span style={styles.waitingBadge} title={t('pane.waitingTitle')}>{t('pane.waiting')}</span>
        )}

        {/* Mixed-workspace badge — this pane's agent belongs to another
            workspace (or that workspace is no longer available). */}
        {isForeign && (
          <span
            style={styles.workspaceBadge}
            title={ownerWorkspace ? t('pane.foreignTitle', { name: ownerWorkspace.name, path: ownerWorkspace.root_path }) : t('pane.foreignUnavailableTitle')}
          >
            ⧉ {ownerWorkspace?.name ?? t('pane.unavailable')}
          </span>
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
            placeholder={t('pane.worktreeNamePlaceholder')}
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
                ? t('pane.worktreeBranchTitle', { branch: worktreeBranch })
                : t('pane.worktreePendingTitle')
            }
          >
            ⑂ {worktreeBranch ? worktreeBranch.replace(/^swarmmind\//, '') : (worktreeName || t('pane.worktreeFallback'))}
          </span>
        ) : null}

        {/* Active-account badge — shows which connected login this pane's agent
            uses, and clicking it opens the context menu (positioned under the
            badge) so the account submenu is one click away. Only shown when more
            than one account exists, since switching is meaningless otherwise. */}
        {activeAccount && paneAccounts.accounts.length > 1 && (
          <span
            style={styles.accountBadge}
            title={t('pane.activeAccount', { label: activeAccount.label || agentInfo?.label || agentId || '' })}
            onClick={e => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setContextMenu({ x: Math.round(r.left), y: Math.round(r.bottom + 4) })
            }}
          >
            <UserIcon />
            {activeAccount.label || t('settings.agent.accounts.untitled', { n: 1 })}
          </span>
        )}

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
              title={t('pane.spawn')}
            >
              <PlayIcon />
            </button>
          ) : (
            <button className="pane-action-btn" data-variant="danger" onClick={handleKill} title={t('pane.kill')}>
              <StopIcon />
            </button>
          )}
          <button className="pane-action-btn" onClick={clear} title={t('pane.clearTerminal')}>
            <TrashIcon />
          </button>
          {onToggleExpand && (
            <button
              className="pane-action-btn"
              onClick={onToggleExpand}
              title={isExpanded ? t('pane.collapse') : t('pane.expand')}
            >
              {isExpanded ? <CollapseIcon /> : <ExpandIcon />}
            </button>
          )}
          <button className="pane-action-btn" data-variant="danger" onClick={onClose} title={t('pane.closePane')}>
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
              placeholder={t('pane.findPlaceholder')}
              spellCheck={false}
              onChange={e => { setSearchQuery(e.target.value); findNext(e.target.value) }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) findPrevious(searchQuery); else findNext(searchQuery) }
                else if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); clearSearch() }
              }}
            />
            <button style={styles.searchBtn} onClick={() => findPrevious(searchQuery)} title={t('pane.searchPrev')}>↑</button>
            <button style={styles.searchBtn} onClick={() => findNext(searchQuery)} title={t('pane.searchNext')}>↓</button>
            <button style={styles.searchBtn} onClick={() => { setSearchOpen(false); clearSearch() }} title={t('pane.searchClose')}>✕</button>
          </div>
        )}
        {skillDragOver && (
          <div style={styles.dropOverlay}>
            <span style={styles.dropOverlayText}>{t('pane.dropHere')}</span>
          </div>
        )}
        {!workspace && (
          <div style={styles.emptyState}>
            <p>{t('pane.openWorkspacePrompt')}</p>
          </div>
        )}
        {workspace && boot !== 'off' && (
          <div className={`term-boot${boot === 'leaving' ? ' term-boot--leaving' : ''}`} style={styles.bootOverlay} aria-hidden="true">
            <div className="term-boot-label">
              <span className="term-boot-text">{t('pane.starting')}</span>
              <span className="term-boot-ellipsis">
                <span className="loading-dot" style={{ animationDelay: '0s' }}>.</span>
                <span className="loading-dot" style={{ animationDelay: '0.2s' }}>.</span>
                <span className="loading-dot" style={{ animationDelay: '0.4s' }}>.</span>
              </span>
            </div>
            <div className="term-boot-bar"><span className="term-boot-bar-fill" /></div>
          </div>
        )}
        <div ref={containerRef} style={{ ...styles.terminal, opacity: !workspace ? 0 : 1 }} />
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <div style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }}>
          <button className="ctx-menu-item" onClick={() => { copySelection(); setContextMenu(null) }} disabled={!getSelection()}>
            <span style={{ flex: 1 }}>{t('pane.ctx.copy')}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Ctrl+Shift+C</span>
          </button>
          <button className="ctx-menu-item" onClick={() => { paste(); setContextMenu(null) }}>
            <span style={{ flex: 1 }}>{t('pane.ctx.paste')}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Ctrl+Shift+V</span>
          </button>
          <div style={styles.ctxDivider} />
          <button className="ctx-menu-item" onClick={() => { onSplitH(); setContextMenu(null) }}>{t('pane.ctx.splitRight')}</button>
          <button className="ctx-menu-item" onClick={() => { onSplitV(); setContextMenu(null) }}>{t('pane.ctx.splitDown')}</button>
          <div style={styles.ctxDivider} />
          <button className="ctx-menu-item" onClick={() => { setContextMenu(null); setTitleDraft(paneTitle ?? agentInfo?.label ?? ''); setEditingTitle(true) }}>{t('pane.ctx.rename')}</button>
          <div style={{ display: 'flex', gap: 6, padding: '6px 14px', alignItems: 'center' }}>
            {PANE_COLORS.map(c => (
              <button key={c} onClick={() => { setPaneColor(paneId, c); setContextMenu(null) }}
                style={{ width: 15, height: 15, borderRadius: '50%', background: c, border: paneColor === c ? '2px solid var(--text-primary)' : 'none', cursor: 'pointer', padding: 0 }} />
            ))}
            <button onClick={() => { setPaneColor(paneId, null); setContextMenu(null) }} title={t('pane.ctx.noColour')}
              style={{ width: 15, height: 15, borderRadius: '50%', background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer', padding: 0 }} />
          </div>
          {agentId === 'claude' && (
            <>
              <div style={styles.ctxDivider} />
              <button className="ctx-menu-item" onClick={() => { setContextMenu(null); setSessionPickerOpen(true) }}>{t('pane.ctx.resumeSession')}</button>
              <button
                className="ctx-menu-item"
                onClick={() => { setPaneWorktree(paneId, !worktreeEnabled); setContextMenu(null) }}
                title={t('pane.ctx.runInWorktreeTitle')}
              >
                <span style={{ flex: 1 }}>{t('pane.ctx.runInWorktree')}</span>
                {worktreeEnabled && <CheckIcon />}
              </button>
              {!worktreeBranch && (
                <button
                  className="ctx-menu-item"
                  onClick={() => { setContextMenu(null); startEditingWorktreeName() }}
                  title={t('pane.ctx.nameWorktreeTitle')}
                >
                  {t('pane.ctx.nameWorktree')}
                </button>
              )}
              {worktreePath && (
                <button className="ctx-menu-item" data-variant="danger" onClick={() => { handleRemoveWorktree(); setContextMenu(null) }}>
                  {t('pane.ctx.removeWorktree')}
                </button>
              )}
            </>
          )}
          <div style={styles.ctxDivider} />
          <div style={styles.ctxLabel}>{t('pane.ctx.pipeLabel')}</div>
          <button className="ctx-menu-item" onClick={() => { handleShareToMemory(); setContextMenu(null) }}>{t('pane.ctx.sendMemory')}</button>
          <button className="ctx-menu-item" onClick={() => { handleSendToOthers(); setContextMenu(null) }}>{t('pane.ctx.sendOthers')}</button>
          <div style={styles.ctxDivider} />
          <div style={styles.ctxLabel}>{t('pane.ctx.switchAgent')}</div>
          {AGENTS.map(a => (
            <button
              key={a.id}
              className="ctx-menu-item"
              onClick={() => { setAgentId(paneId, a.id); setContextMenu(null) }}
            >
              <AgentIcon id={a.id} size={15} />
              <span style={{ flex: 1, color: agentId === a.id ? a.color : undefined }}>{a.label}</span>
              {agentId === a.id && <CheckIcon />}
            </button>
          ))}
          {/* Account quick-switch: rotate to another connected login for this
              agent (e.g. when the current one hits a usage limit). */}
          {agentId && (
            <>
              <div style={styles.ctxDivider} />
              <div style={styles.ctxLabel}>{t('pane.ctx.account')}</div>
              {paneAccounts.accounts.length === 0 && (
                <div style={styles.ctxHint}>{t('pane.ctx.accountNone')}</div>
              )}
              {paneAccounts.accounts.map((acc, idx) => {
                const active = (paneAccounts.activeId ?? paneAccounts.accounts[0]?.id) === acc.id
                const typeLabel = acc.profileDir ? t('pane.ctx.accountTypeCli') : t('pane.ctx.accountTypeApi')
                return (
                  <button
                    key={acc.id}
                    className="ctx-menu-item"
                    onClick={() => { switchAccount(acc); setContextMenu(null) }}
                  >
                    <span style={{ flex: 1, color: active ? 'var(--accent)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {acc.label || t('settings.agent.accounts.untitled', { n: idx + 1 })}
                    </span>
                    <span style={styles.ctxTypeBadge}>{typeLabel}</span>
                    {active && <CheckIcon />}
                  </button>
                )
              })}
              <button
                className="ctx-menu-item"
                onClick={() => { setContextMenu(null); openSettings(agentId) }}
              >
                <span style={{ flex: 1, color: 'var(--text-muted)' }}>
                  {paneAccounts.accounts.length === 0 ? t('pane.ctx.accountAdd') : t('pane.ctx.accountManage')}
                </span>
              </button>
            </>
          )}
          {/* Mixed workspace: run this pane's agent as a member of another
              workspace. Only offered when more than one workspace exists, and
              only changeable while no agent is running here. */}
          {knownWorkspaces.length > 1 && (
            <>
              <div style={styles.ctxDivider} />
              <div style={styles.ctxLabel}>
                {t('pane.ctx.runFromWorkspace')}{ptyStatus === 'running' ? t('pane.ctx.runFromWorkspaceStop') : ''}
              </div>
              {[{ id: '', name: t('pane.ctx.hostWorkspace', { name: workspace?.name ?? 'Host' }), root_path: '' },
                ...knownWorkspaces.filter(w => w.id !== workspace?.id)]
                .map(w => {
                  const selected = w.id === '' ? !isForeign : w.id === paneWorkspaceId
                  return (
                    <button
                      key={w.id || 'host'}
                      className="ctx-menu-item"
                      disabled={ptyStatus === 'running'}
                      title={w.root_path || workspace?.rootPath || ''}
                      onClick={() => { setPaneWorkspace(paneId, w.id || null); setContextMenu(null) }}
                    >
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--accent)' : undefined }}>{w.name}</span>
                      {selected && <CheckIcon />}
                    </button>
                  )
                })}
            </>
          )}
          <div style={styles.ctxDivider} />
          <button className="ctx-menu-item" data-variant="danger" onClick={() => { onClose(); setContextMenu(null) }}>
            {t('pane.ctx.closePane')}
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
  const t = useT()
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
          {t('pane.skillValues')}
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
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            style={{ background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'var(--accent-fg)', padding: '5px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
          >
            {t('pane.skillRun')}
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
    border: '1px solid var(--accent-glow)',
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
  accountBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    color: 'var(--text-secondary)',
    background: 'var(--bg-elevated-2)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '1px 7px 1px 6px',
    maxWidth: 130,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    letterSpacing: '0.01em',
    flexShrink: 0,
    cursor: 'pointer',
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
  workspaceBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--accent-fg)',
    background: 'var(--accent)',
    border: '1px solid var(--accent)',
    borderRadius: 10,
    padding: '1px 7px',
    maxWidth: 150,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    letterSpacing: '0.01em',
    flexShrink: 0,
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
  bootOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    background: 'var(--bg-terminal)',
    overflow: 'hidden',
    zIndex: 5,
    pointerEvents: 'none',
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
  ctxHint: {
    fontSize: 11,
    color: 'var(--text-dim)',
    fontStyle: 'italic',
    padding: '2px 14px 4px',
    userSelect: 'none',
  },
  ctxTypeBadge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: 'var(--text-muted)',
    background: 'var(--bg-elevated-2)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '0 5px',
    flexShrink: 0,
  },
}
