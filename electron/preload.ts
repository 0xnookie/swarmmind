import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('swarmmind', {
  ptyCreate: (paneId: string, agentId: string, cwd: string, shellStyle: string, taskContext?: string, cols?: number, rows?: number, resume?: boolean, sessionId?: string, workspaceId?: string) =>
    ipcRenderer.invoke('pty:create', paneId, agentId, cwd, shellStyle, taskContext, cols, rows, resume, sessionId, workspaceId),
  ptyCreateShell: (paneId: string, cwd: string, shellStyle: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke('pty:createShell', paneId, cwd, shellStyle, cols, rows),
  ptyInput: (paneId: string, data: string) =>
    ipcRenderer.send('pty:input', paneId, data),
  ptyResize: (paneId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', paneId, cols, rows),
  ptyKill: (paneId: string, silent?: boolean) =>
    ipcRenderer.invoke('pty:kill', paneId, silent),
  ptyStatus: (paneId: string) =>
    ipcRenderer.invoke('pty:status', paneId),
  agentCounts: () =>
    ipcRenderer.invoke('pty:agentCounts'),
  onPtyOutput: (cb: (paneId: string, data: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, paneId: string, data: string) => cb(paneId, data)
    ipcRenderer.on('pty:output', handler)
    return () => ipcRenderer.off('pty:output', handler)
  },
  onPtyExit: (cb: (paneId: string, code: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, paneId: string, code: number) => cb(paneId, code)
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.off('pty:exit', handler)
  },
  onPtyState: (cb: (paneId: string, state: 'working' | 'waiting') => void) => {
    const handler = (_event: Electron.IpcRendererEvent, paneId: string, state: 'working' | 'waiting') => cb(paneId, state)
    ipcRenderer.on('pty:state', handler)
    return () => ipcRenderer.off('pty:state', handler)
  },
  // Fires only when an agent goes quiet *with a pending question* (permission
  // prompt / y-n / selection), as opposed to merely finishing a turn. Drives the
  // notification center so the bell isn't spammed after every turn.
  onPtyAttention: (cb: (paneId: string, agentId: string | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, paneId: string, agentId: string | null) => cb(paneId, agentId ?? null)
    ipcRenderer.on('pty:attention', handler)
    return () => ipcRenderer.off('pty:attention', handler)
  },
  // Fires when a `/loop` command is detected in a pane's input, so the renderer
  // can surface the CLI-started loop in the Loops panel.
  onPtyLoop: (cb: (paneId: string, info: { command: string; interval: string | null; raw: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, paneId: string, info: { command: string; interval: string | null; raw: string }) => cb(paneId, info)
    ipcRenderer.on('pty:loop', handler)
    return () => ipcRenderer.off('pty:loop', handler)
  },

  memoryList: (type?: string, agentId?: string) =>
    ipcRenderer.invoke('memory:list', type, agentId),
  memoryRead: (key: string, agentId?: string) =>
    ipcRenderer.invoke('memory:read', key, agentId),
  memoryWrite: (key: string, value: string, type: string, agentId?: string) =>
    ipcRenderer.invoke('memory:write', key, value, type, agentId),
  memoryDelete: (key: string, agentId?: string) =>
    ipcRenderer.invoke('memory:delete', key, agentId),
  memorySearch: (query: string, k?: number, agentId?: string) =>
    ipcRenderer.invoke('memory:search', query, k, agentId),

  taskList: (status?: string, agentId?: string) =>
    ipcRenderer.invoke('task:list', status, agentId),
  taskCreate: (title: string, description?: string, assignedAgent?: string, dependsOn?: string[]) =>
    ipcRenderer.invoke('task:create', title, description, assignedAgent, dependsOn),
  taskUpdate: (id: string, status: string, assignedAgent?: string, notes?: string) =>
    ipcRenderer.invoke('task:update', id, status, assignedAgent, notes),
  taskAppendNote: (id: string, note: string) =>
    ipcRenderer.invoke('task:appendNote', id, note),
  taskDelete: (id: string) =>
    ipcRenderer.invoke('task:delete', id),

  messagesUndelivered: () => ipcRenderer.invoke('messages:undelivered'),
  messageMarkDelivered: (id: string) => ipcRenderer.invoke('messages:markDelivered', id),

  // Swarm event bus (timeline + cost meter)
  eventsList: (sinceTs?: number, limit?: number, types?: string[]) =>
    ipcRenderer.invoke('events:list', sinceTs, limit, types),
  eventEmit: (type: string, payload?: Record<string, unknown>, paneId?: string, agentId?: string) =>
    ipcRenderer.invoke('events:emit', type, payload, paneId, agentId),
  onSwarmEvent: (cb: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, evt: unknown) => cb(evt)
    ipcRenderer.on('swarm:event', handler)
    return () => ipcRenderer.off('swarm:event', handler)
  },

  skillList: () =>
    ipcRenderer.invoke('skill:list'),
  skillCreate: (name: string, description: string | null, promptText: string, color: string, category: string) =>
    ipcRenderer.invoke('skill:create', name, description, promptText, color, category),
  skillUpdate: (id: string, name: string, description: string | null, promptText: string, color: string, category: string) =>
    ipcRenderer.invoke('skill:update', id, name, description, promptText, color, category),
  skillDelete: (id: string) =>
    ipcRenderer.invoke('skill:delete', id),
  skillReorder: (orderedIds: string[]) =>
    ipcRenderer.invoke('skill:reorder', orderedIds),

  // Agent Skills (real Claude Code .claude/skills/*/SKILL.md, workspace-scoped)
  agentSkillList: (rootPath?: string) =>
    ipcRenderer.invoke('agentSkill:list', rootPath),
  agentSkillWrite: (args: { rootPath?: string; slug?: string; name: string; description: string; body: string }) =>
    ipcRenderer.invoke('agentSkill:write', args),
  agentSkillDelete: (rootPath: string | undefined, slug: string) =>
    ipcRenderer.invoke('agentSkill:delete', rootPath, slug),

  layoutSave: (layoutJson: string) =>
    ipcRenderer.invoke('layout:save', layoutJson),

  workspaceOpen: () => ipcRenderer.invoke('workspace:open'),
  workspaceGet: () => ipcRenderer.invoke('workspace:get'),
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  workspaceOpenById: (id: string) => ipcRenderer.invoke('workspace:openById', id),
  workspaceOpenLast: () => ipcRenderer.invoke('workspace:openLast'),
  workspaceDelete: (id: string) => ipcRenderer.invoke('workspace:delete', id),
  workspaceRename: (id: string, name: string) => ipcRenderer.invoke('workspace:rename', id, name),
  workspaceOpenByPath: (rootPath: string, name?: string) => ipcRenderer.invoke('workspace:openByPath', rootPath, name),
  workspaceReveal: (id: string) => ipcRenderer.invoke('workspace:reveal', id),
  folderPick: () => ipcRenderer.invoke('folder:pick'),

  getAgentConfig: (agentId: string) => ipcRenderer.invoke('settings:getAgentConfig', agentId),
  setAgentConfig: (agentId: string, config: unknown) => ipcRenderer.invoke('settings:setAgentConfig', agentId, config),

  // Global agent accounts (connect multiple logins per agent, switch between them)
  listAgentAccounts: (agentId: string) => ipcRenderer.invoke('accounts:list', agentId),
  saveAgentAccounts: (agentId: string, accounts: unknown, activeId?: string) => ipcRenderer.invoke('accounts:save', agentId, accounts, activeId),
  setActiveAgentAccount: (agentId: string, accountId: string) => ipcRenderer.invoke('accounts:setActive', agentId, accountId),
  connectAgentAccount: (agentId: string, label: string) => ipcRenderer.invoke('accounts:connect', agentId, label),
  ptyCreateLogin: (paneId: string, agentId: string, profileDir: string, shellStyle: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke('pty:createLogin', paneId, agentId, profileDir, shellStyle, cols, rows),

  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose:    () => ipcRenderer.send('window:close'),

  getAppSetting: (key: string) => ipcRenderer.invoke('appsetting:get', key),
  setAppSetting: (key: string, value: string) => ipcRenderer.invoke('appsetting:set', key, value),

  // SwarmAgent — the in-app assistant. Its Groq key stays in the main process;
  // the renderer drives the agentic loop one turn at a time via swarmAgentChat
  // and receives streamed text via onSwarmAgentDelta.
  swarmAgentHasKey: () => ipcRenderer.invoke('swarmAgent:hasKey'),
  swarmAgentSetKey: (key: string) => ipcRenderer.invoke('swarmAgent:setKey', key),
  swarmAgentListModels: () => ipcRenderer.invoke('swarmAgent:listModels'),
  swarmAgentChat: (requestId: string, messages: unknown[], tools: unknown[], context?: string) =>
    ipcRenderer.invoke('swarmAgent:chat', requestId, messages, tools, context),
  onSwarmAgentDelta: (cb: (data: { requestId: string; text: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { requestId: string; text: string }) => cb(data)
    ipcRenderer.on('swarmagent:delta', handler)
    return () => ipcRenderer.off('swarmagent:delta', handler)
  },

  // SwarmAgent desktop widget. The widget is a separate frameless window that
  // hosts just the chat; it controls its own visibility and forwards tool calls
  // to the main window (which owns the workspace state).
  widgetShow: () => ipcRenderer.send('widget:show'),
  widgetHide: () => ipcRenderer.send('widget:hide'),
  widgetRestoreMain: () => ipcRenderer.send('widget:restoreMain'),
  widgetResize: (height: number) => ipcRenderer.send('widget:resize', height),
  widgetForwardTool: (name: string, args: string): Promise<string> =>
    ipcRenderer.invoke('widget:forwardTool', name, args),
  // Main window only: run a tool the widget asked for, then reply with the id.
  onWidgetRunTool: (cb: (req: { id: string; name: string; args: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, req: { id: string; name: string; args: string }) => cb(req)
    ipcRenderer.on('widget:runTool', handler)
    return () => ipcRenderer.off('widget:runTool', handler)
  },
  widgetToolResult: (id: string, result: string) => ipcRenderer.send('widget:toolResult', id, result),

  // Best-effort live refresh of the coding-agent benchmarks leaderboard.
  fetchBenchmarks: () => ipcRenderer.invoke('benchmarks:fetch'),

  // Persistent SwarmVoice model cache (backs @xenova/transformers' custom cache).
  voiceCacheMatch: (key: string) => ipcRenderer.invoke('voiceCache:match', key),
  voiceCachePut: (key: string, data: ArrayBuffer, headers: Record<string, string>) =>
    ipcRenderer.invoke('voiceCache:put', key, data, headers),

  fsListDir: (dirPath: string) => ipcRenderer.invoke('fs:listDir', dirPath),
  fsListFiles: (rootPath: string, max?: number) => ipcRenderer.invoke('fs:listFiles', rootPath, max),
  fsReadFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  fsWriteFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  fsReadImage: (filePath: string) => ipcRenderer.invoke('fs:readImage', filePath),

  sessionList: (rootPath: string) => ipcRenderer.invoke('session:list', rootPath),
  scrollbackLoad: (paneId: string) => ipcRenderer.invoke('scrollback:load', paneId),
  scrollbackSave: (paneId: string, content: string) => ipcRenderer.invoke('scrollback:save', paneId, content),

  gitIsRepo: (root: string) => ipcRenderer.invoke('git:isRepo', root),
  gitCreateWorktree: (root: string, paneId: string, branchHint?: string) => ipcRenderer.invoke('git:createWorktree', root, paneId, branchHint),
  gitRemoveWorktree: (root: string, worktreePath: string, branch?: string, deleteBranch?: boolean) => ipcRenderer.invoke('git:removeWorktree', root, worktreePath, branch, deleteBranch),
  gitListWorktrees: (root: string) => ipcRenderer.invoke('git:listWorktrees', root),
  gitBaseBranch: (root: string) => ipcRenderer.invoke('git:baseBranch', root),
  gitWorktreeDiffStat: (root: string, worktreePath: string, baseRef?: string) => ipcRenderer.invoke('git:worktreeDiffStat', root, worktreePath, baseRef),
  gitWorktreeDiff: (root: string, worktreePath: string, file?: string, baseRef?: string) => ipcRenderer.invoke('git:worktreeDiff', root, worktreePath, file, baseRef),
  gitWorktreeCommit: (worktreePath: string, message: string) => ipcRenderer.invoke('git:worktreeCommit', worktreePath, message),
  gitWorktreeCommitFiles: (worktreePath: string, message: string, files: string[]) => ipcRenderer.invoke('git:worktreeCommitFiles', worktreePath, message, files),
  gitMergeBranch: (root: string, branch: string) => ipcRenderer.invoke('git:mergeBranch', root, branch),

  // Checkpoints & Rewind
  checkpointCreate: (label?: string, trigger?: string) => ipcRenderer.invoke('checkpoint:create', label, trigger),
  checkpointList: () => ipcRenderer.invoke('checkpoint:list'),
  checkpointRestore: (id: string) => ipcRenderer.invoke('checkpoint:restore', id),
  checkpointDelete: (id: string) => ipcRenderer.invoke('checkpoint:delete', id),

  platform: process.platform,

  getAppVersion: () => ipcRenderer.invoke('app:version'),

  onMenuOpenWorkspace: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('menu:openWorkspace', handler)
    return () => ipcRenderer.off('menu:openWorkspace', handler)
  },

  // Auto-update
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => cb(status)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.off('update:status', handler)
  }
})

// The renderer-facing type for `window.swarmmind` is declared canonically in
// src/types/swarmmind.d.ts; this preload module only registers the bridge.