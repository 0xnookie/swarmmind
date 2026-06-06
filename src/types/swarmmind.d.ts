export {}

declare global {
  interface Window {
    swarmmind: {
      // PTY
      ptyCreate: (paneId: string, agentId: string, cwd: string, shellStyle: string, taskContext?: string, cols?: number, rows?: number, resume?: boolean, sessionId?: string) => Promise<{ ok?: boolean; error?: string }>
      ptyCreateShell: (paneId: string, cwd: string, shellStyle: string, cols?: number, rows?: number) => Promise<{ ok?: boolean; error?: string }>
      ptyInput: (paneId: string, data: string) => void
      ptyResize: (paneId: string, cols: number, rows: number) => void
      ptyKill: (paneId: string) => Promise<{ ok: boolean }>
      ptyStatus: (paneId: string) => Promise<string>
      agentCounts: () => Promise<Record<string, number>>
      onPtyOutput: (cb: (paneId: string, data: string) => void) => () => void
      onPtyExit: (cb: (paneId: string, code: number) => void) => () => void
      onPtyState: (cb: (paneId: string, state: 'working' | 'waiting') => void) => () => void
      onPtyAttention: (cb: (paneId: string) => void) => () => void
      // Memory
      memoryList: (type?: string, agentId?: string) => Promise<unknown[]>
      memoryRead: (key: string, agentId?: string) => Promise<unknown>
      memoryWrite: (key: string, value: string, type: string, agentId?: string) => Promise<unknown>
      memoryDelete: (key: string, agentId?: string) => Promise<boolean>
      memorySearch: (query: string, k?: number, agentId?: string) => Promise<ScoredMemoryEntry[]>
      // Tasks
      taskList: (status?: string, agentId?: string) => Promise<unknown[]>
      taskCreate: (title: string, description?: string, assignedAgent?: string, dependsOn?: string[]) => Promise<unknown>
      taskUpdate: (id: string, status: string, assignedAgent?: string, notes?: string) => Promise<unknown>
      taskAppendNote: (id: string, note: string) => Promise<unknown>
      // Agent-to-agent messages (delivery driven by the conductor)
      messagesUndelivered: () => Promise<AgentMessage[]>
      messageMarkDelivered: (id: string) => Promise<void>
      // Swarm event bus (timeline + cost meter)
      eventsList: (sinceTs?: number, limit?: number, types?: string[]) => Promise<SwarmEvent[]>
      eventEmit: (type: string, payload?: Record<string, unknown>, paneId?: string, agentId?: string) => Promise<SwarmEvent | null>
      onSwarmEvent: (cb: (event: SwarmEvent) => void) => () => void
      // Skills
      skillList: () => Promise<Skill[]>
      skillCreate: (name: string, description: string | null, promptText: string, color: string, category: string) => Promise<Skill>
      skillUpdate: (id: string, name: string, description: string | null, promptText: string, color: string, category: string) => Promise<Skill | null>
      skillDelete: (id: string) => Promise<boolean>
      skillReorder: (orderedIds: string[]) => Promise<void>
      // Agent Skills (real Claude Code .claude/skills, workspace-scoped)
      agentSkillList: (rootPath?: string) => Promise<AgentSkillInfo[]>
      agentSkillWrite: (args: { rootPath?: string; slug?: string; name: string; description: string; body: string }) => Promise<string | null>
      agentSkillDelete: (rootPath: string | undefined, slug: string) => Promise<boolean>
      // Layout
      layoutSave: (layoutJson: string) => Promise<void>
      // Workspace
      workspaceOpen: () => Promise<{ id: string; name: string; rootPath: string; savedLayout?: string; error?: string } | null>
      workspaceGet: () => Promise<{ id: string; name: string; rootPath: string; savedLayout?: string } | null>
      workspaceList: () => Promise<unknown[]>
      workspaceOpenById: (id: string) => Promise<{ id: string; name: string; rootPath: string; savedLayout?: string; error?: string } | null>
      workspaceOpenLast: () => Promise<{ id: string; name: string; rootPath: string; savedLayout?: string; error?: string } | null>
      workspaceDelete: (id: string) => Promise<boolean>
      workspaceRename: (id: string, name: string) => Promise<boolean>
      workspaceOpenByPath: (rootPath: string, name?: string) => Promise<{ id: string; name: string; rootPath: string; savedLayout?: string; error?: string } | null>
      folderPick: () => Promise<string | null>
      // Settings
      getAgentConfig: (agentId: string) => Promise<Record<string, unknown>>
      setAgentConfig: (agentId: string, config: unknown) => Promise<void>
      // App settings
      getAppSetting: (key: string) => Promise<string | null>
      setAppSetting: (key: string, value: string) => Promise<void>
      // Window controls
      windowMinimize: () => void
      windowMaximize: () => void
      windowClose: () => void
      // Platform
      platform: string
      // Menu events
      onMenuOpenWorkspace: (cb: () => void) => () => void
      // File system
      fsListDir: (dirPath: string) => Promise<FsEntry[]>
      fsReadFile: (filePath: string) => Promise<string>
      fsWriteFile: (filePath: string, content: string) => Promise<void>
      // Sessions & scrollback
      sessionList: (rootPath: string) => Promise<SessionInfo[]>
      scrollbackLoad: (paneId: string) => Promise<string>
      scrollbackSave: (paneId: string, content: string) => Promise<void>
      // Git worktrees
      gitIsRepo: (root: string) => Promise<boolean>
      gitCreateWorktree: (root: string, paneId: string, branchHint?: string) => Promise<WorktreeInfo | { error: string }>
      gitRemoveWorktree: (root: string, worktreePath: string, branch?: string, deleteBranch?: boolean) => Promise<{ ok: true } | { error: string }>
      gitListWorktrees: (root: string) => Promise<WorktreeInfo[]>
      gitBaseBranch: (root: string) => Promise<string>
      gitWorktreeDiffStat: (root: string, worktreePath: string, baseRef?: string) => Promise<WorktreeDiffStat>
      gitWorktreeDiff: (root: string, worktreePath: string, file?: string, baseRef?: string) => Promise<string>
      gitWorktreeCommit: (worktreePath: string, message: string) => Promise<{ hash: string | null } | { error: string }>
      gitMergeBranch: (root: string, branch: string) => Promise<{ ok: true; message: string } | { ok: false; conflict: boolean; error: string }>
      // Checkpoints & Rewind
      checkpointCreate: (label?: string, trigger?: string) => Promise<CheckpointRecord | { error: string }>
      checkpointList: () => Promise<CheckpointRecord[]>
      checkpointRestore: (id: string) => Promise<{ ok: true; restored: number; errors: string[] } | { error: string }>
      checkpointDelete: (id: string) => Promise<boolean>
      // Auto-update
      updateCheck: () => Promise<{ supported: boolean }>
      updateInstall: () => Promise<void>
      onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void
    }
  }

  type UpdateStatus =
    | { state: 'checking' }
    | { state: 'available'; version: string }
    | { state: 'none' }
    | { state: 'downloading'; percent: number }
    | { state: 'ready'; version: string }
    | { state: 'error'; message: string }

  interface ScoredMemoryEntry {
    id: string
    workspace_id: string
    agent_id: string | null
    type: string
    key: string
    value: string
    created_at: number
    updated_at: number
    score: number
  }

  interface CheckpointRecord {
    id: string
    workspace_id: string
    ts: number
    label: string
    trigger: string
    trees: { path: string; commit: string; head: string | null }[]
  }

  interface WorktreeFileChange {
    path: string
    additions: number
    deletions: number
    binary: boolean
  }

  interface WorktreeDiffStat {
    base: string
    ahead: number
    behind: number
    hasUncommitted: boolean
    files: WorktreeFileChange[]
  }

  interface WorktreeInfo {
    path: string
    branch: string
  }

  interface AgentMessage {
    id: string
    workspace_id: string
    from_agent: string
    to_agent: string
    body: string
    delivered: number
    created_at: number
  }

  type SwarmEventType =
    | 'memory_write'
    | 'task_create'
    | 'task_update'
    | 'task_note'
    | 'message'
    | 'agent_spawn'
    | 'agent_exit'
    | 'agent_question'
    | 'dispatch'
    | 'synthesis'
    | 'cost'
    | 'file_changed'
    | 'contention'
    | 'file_intent'
    | 'checkpoint'
    | 'review'

  interface SwarmEvent {
    id: string
    workspace_id: string
    ts: number
    type: SwarmEventType
    agent_id: string | null
    pane_id: string | null
    payload: Record<string, unknown> | null
    created_at: number
  }

  interface SessionInfo {
    id: string
    mtime: number
    size: number
    preview: string
  }

  interface FsEntry {
    name: string
    path: string
    type: 'file' | 'dir'
    ext: string
  }

  interface AgentSkillInfo {
    slug: string
    name: string
    description: string
    body: string
    path: string
    updatedAt: number
  }

  interface Skill {
    id: string
    name: string
    description: string | null
    prompt_text: string
    color: string
    category: string
    sort_order: number
    created_at: number
    updated_at: number
  }
}
