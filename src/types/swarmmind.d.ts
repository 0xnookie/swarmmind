export {}

import type { BenchmarkSnapshot } from '../data/benchmarks'

interface AgentAccount {
  id: string
  label: string
  profileDir?: string
  apiKey?: string
  model?: string
  env?: Record<string, string>
}

declare global {
  interface Window {
    swarmmind: {
      // PTY
      ptyCreate: (paneId: string, agentId: string, cwd: string, shellStyle: string, taskContext?: string, cols?: number, rows?: number, resume?: boolean, sessionId?: string, workspaceId?: string) => Promise<{ ok?: boolean; error?: string }>
      ptyCreateShell: (paneId: string, cwd: string, shellStyle: string, cols?: number, rows?: number) => Promise<{ ok?: boolean; error?: string }>
      ptyInput: (paneId: string, data: string) => void
      ptyResize: (paneId: string, cols: number, rows: number) => void
      ptyKill: (paneId: string, silent?: boolean) => Promise<{ ok: boolean }>
      ptyStatus: (paneId: string) => Promise<string>
      agentCounts: () => Promise<Record<string, number>>
      onPtyOutput: (cb: (paneId: string, data: string) => void) => () => void
      onPtyExit: (cb: (paneId: string, code: number) => void) => () => void
      onPtyState: (cb: (paneId: string, state: 'working' | 'waiting') => void) => () => void
      onPtyAttention: (cb: (paneId: string, agentId: string | null) => void) => () => void
      onPtyLoop: (cb: (paneId: string, info: { command: string; interval: string | null; raw: string }) => void) => () => void
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
      taskDelete: (id: string) => Promise<boolean>
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
      workspaceReveal: (id: string) => Promise<{ ok?: boolean; error?: string }>
      folderPick: () => Promise<string | null>
      // Settings
      getAgentConfig: (agentId: string) => Promise<Record<string, unknown>>
      setAgentConfig: (agentId: string, config: unknown) => Promise<void>
      // Global agent accounts
      listAgentAccounts: (agentId: string) => Promise<{ accounts: AgentAccount[]; activeId?: string }>
      saveAgentAccounts: (agentId: string, accounts: AgentAccount[], activeId?: string) => Promise<void>
      setActiveAgentAccount: (agentId: string, accountId: string) => Promise<void>
      connectAgentAccount: (agentId: string, label: string) => Promise<{ account?: AgentAccount; error?: string }>
      ptyCreateLogin: (paneId: string, agentId: string, profileDir: string, shellStyle: string, cols?: number, rows?: number) => Promise<{ ok?: boolean; error?: string }>
      // App settings
      getAppSetting: (key: string) => Promise<string | null>
      setAppSetting: (key: string, value: string) => Promise<void>
      // SwarmAgent (in-app assistant; Groq-backed, key held in main process)
      swarmAgentHasKey: () => Promise<boolean>
      swarmAgentSetKey: (key: string) => Promise<boolean>
      swarmAgentListModels: () => Promise<string[]>
      swarmAgentChat: (
        requestId: string,
        messages: SwarmAgentMessage[],
        tools: unknown[],
        context?: string,
      ) => Promise<{ message?: SwarmAgentMessage; error?: string }>
      onSwarmAgentDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
      // Inline editor edit (Cmd/Ctrl+K): streams the rewritten snippet, resolves with final code
      swarmAgentEditCode: (
        requestId: string,
        payload: { instruction: string; selection: string; before: string; after: string; language: string; fileName: string; mentions?: { path: string; content: string }[] },
      ) => Promise<{ code?: string; error?: string }>
      onSwarmAgentEditDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
      // Ghost-text autocomplete (Copilot-style): predicts the insertion at the cursor
      swarmAgentComplete: (payload: { prefix: string; suffix: string; language: string }) => Promise<{ text: string }>
      // Multi-file Composer: proposes coordinated edits across files as a change plan
      swarmAgentCompose: (payload: { instruction: string; files: { path: string; content: string }[] }) => Promise<{
        summary?: string
        changes?: { path: string; action: string; content: string }[]
        error?: string
      }>
      // AI diagnostics: reviews a file and returns structured problems for the lint gutter
      swarmAgentDiagnose: (payload: { content: string; language: string; fileName: string }) => Promise<{
        diagnostics?: { line: number; severity: string; message: string; fix?: string }[]
        error?: string
      }>
      // Next-edit prediction ("Tab to jump"): the next related edit after one is made
      swarmAgentNextEdit: (payload: {
        content: string
        language: string
        fileName: string
        editedFromLine: number
        editedToLine: number
      }) => Promise<{ prediction?: { line?: number; instruction?: string; none?: boolean }; error?: string }>
      // SwarmAgent desktop widget (separate floating window)
      widgetShow: () => void
      widgetHide: () => void
      widgetRestoreMain: () => void
      widgetResize: (height: number) => void
      widgetForwardTool: (name: string, args: string) => Promise<string>
      onWidgetRunTool: (cb: (req: { id: string; name: string; args: string }) => void) => () => void
      widgetToolResult: (id: string, result: string) => void
      // Coding-agent benchmarks: best-effort live refresh (falls back to the
      // bundled snapshot on failure).
      fetchBenchmarks: () => Promise<BenchmarkSnapshot | { error: string }>
      // Persistent SwarmVoice model cache (filesystem-backed under userData)
      voiceCacheMatch: (key: string) => Promise<{ data: ArrayBuffer; headers: Record<string, string> } | null>
      voiceCachePut: (key: string, data: ArrayBuffer, headers: Record<string, string>) => Promise<boolean>
      // Window controls
      windowMinimize: () => void
      windowMaximize: () => void
      windowClose: () => void
      // Platform
      platform: string
      // App version (from Electron app.getVersion())
      getAppVersion: () => Promise<string>
      // Menu events
      onMenuOpenWorkspace: (cb: () => void) => () => void
      // File system
      fsListDir: (dirPath: string) => Promise<FsEntry[]>
      fsListFiles: (rootPath: string, max?: number) => Promise<string[]>
      fsSearchFiles: (rootPath: string, query: string, glob?: string, maxMatches?: number) => Promise<{ path: string; line: number; text: string }[]>
      fsExists: (filePath: string) => Promise<boolean>
      fsReadFile: (filePath: string) => Promise<string>
      fsWriteFile: (filePath: string, content: string) => Promise<void>
      fsReadImage: (filePath: string) => Promise<ImageData>
      verifyScripts: (rootPath: string) => Promise<string[]>
      verifyRun: (rootPath: string, script: string) => Promise<{ code: number; stdout: string; stderr: string; error?: string }>
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
      gitWorktreeCommitFiles: (worktreePath: string, message: string, files: string[]) => Promise<{ hash: string | null } | { error: string }>
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

  // One message in a SwarmAgent conversation (OpenAI/Groq chat shape).
  interface SwarmAgentToolCall {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }
  interface SwarmAgentMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    tool_calls?: SwarmAgentToolCall[]
    tool_call_id?: string
    name?: string
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

  interface ImageData {
    dataUrl: string
    mime: string
    size: number
    mtimeMs: number
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
