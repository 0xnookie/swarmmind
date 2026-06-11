import { ipcMain } from 'electron'
import {
  memoryRead,
  memoryWrite,
  memoryDelete,
  memoryList,
  memorySearch,
  taskCreate,
  taskUpdate,
  taskAppendNote,
  taskList,
  messagesUndelivered,
  messageMarkDelivered,
  saveLayout,
  skillList,
  skillCreate,
  skillUpdate,
  skillDelete,
  skillReorder,
  type MemoryType,
  type TaskStatus,
  type AgentId
} from '../../memory/queries'
import { readAgentConfig, writeAgentConfig } from '../agent-config'
import { listAccounts, saveAccounts, setActiveAccount, createProfileAccount, type AgentAccount } from '../agent-accounts'

export function registerMemoryHandlers(getWorkspaceId: () => string | null): void {
  ipcMain.handle('memory:list', (_event, type?: MemoryType, agentId?: string) => {
    const wsId = getWorkspaceId()
    if (!wsId) return []
    return memoryList(wsId, type, agentId)
  })

  ipcMain.handle('memory:read', (_event, key: string, agentId?: string) => {
    const wsId = getWorkspaceId()
    if (!wsId) return null
    return memoryRead(wsId, key, agentId ?? null)
  })

  ipcMain.handle('memory:write', (_event, key: string, value: string, type: MemoryType, agentId?: string) => {
    const wsId = getWorkspaceId()
    if (!wsId) return null
    return memoryWrite(wsId, key, value, type, agentId ?? null)
  })

  ipcMain.handle('memory:delete', (_event, key: string, agentId?: string) => {
    const wsId = getWorkspaceId()
    if (!wsId) return false
    return memoryDelete(wsId, key, agentId ?? null)
  })

  ipcMain.handle('memory:search', (_event, query: string, k?: number, agentId?: string) => {
    const wsId = getWorkspaceId()
    if (!wsId) return []
    return memorySearch(wsId, query, k ?? 5, agentId ?? null)
  })

  ipcMain.handle('task:list', (_event, status?: TaskStatus, agentId?: string) => {
    const wsId = getWorkspaceId()
    if (!wsId) return []
    return taskList(wsId, status, agentId)
  })

  ipcMain.handle('task:create', (_event, title: string, description?: string, assignedAgent?: string, dependsOn?: string[]) => {
    const wsId = getWorkspaceId()
    if (!wsId) return null
    return taskCreate(wsId, title, description ?? null, assignedAgent ?? null, 'user', dependsOn ?? null)
  })

  ipcMain.handle('task:update', (_event, id: string, status: TaskStatus, assignedAgent?: string, notes?: string) => {
    return taskUpdate(id, status, assignedAgent, notes)
  })

  ipcMain.handle('task:appendNote', (_event, id: string, note: string) => {
    return taskAppendNote(id, note)
  })

  ipcMain.handle('messages:undelivered', () => {
    const wsId = getWorkspaceId()
    if (!wsId) return []
    return messagesUndelivered(wsId)
  })

  ipcMain.handle('messages:markDelivered', (_event, id: string) => {
    messageMarkDelivered(id)
  })

  ipcMain.handle('layout:save', (_event, layoutJson: string) => {
    const wsId = getWorkspaceId()
    if (!wsId) return
    saveLayout(wsId, layoutJson)
  })

  ipcMain.handle('settings:getAgentConfig', (_event, agentId: AgentId) => {
    const wsId = getWorkspaceId()
    if (!wsId) return {}
    return readAgentConfig(wsId, agentId)
  })

  ipcMain.handle('settings:setAgentConfig', (_event, agentId: AgentId, config: unknown) => {
    const wsId = getWorkspaceId()
    if (!wsId) return
    writeAgentConfig(wsId, agentId, config as Parameters<typeof writeAgentConfig>[2])
  })

  // ── Agent accounts (global, in app.db — not per-workspace) ────────────────
  ipcMain.handle('accounts:list', (_event, agentId: AgentId) => listAccounts(agentId))

  ipcMain.handle('accounts:save', (_event, agentId: AgentId, accounts: unknown, activeId?: string) => {
    saveAccounts(agentId, accounts as AgentAccount[], activeId)
  })

  ipcMain.handle('accounts:setActive', (_event, agentId: AgentId, accountId: string) => {
    setActiveAccount(agentId, accountId)
  })

  // One-click connect: create a fresh profile-dir account for the agent's CLI
  // login flow. The renderer follows up with pty:createLogin to run the login.
  ipcMain.handle('accounts:connect', (_event, agentId: AgentId, label: string) => {
    try {
      return { account: createProfileAccount(agentId, label) }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Skills (global, not per-workspace) ────────────────────────────────────
  ipcMain.handle('skill:list', () => skillList())

  ipcMain.handle('skill:create', (_event, name: string, description: string | null, promptText: string, color: string, category: string) =>
    skillCreate(name, description, promptText, color, category)
  )

  ipcMain.handle('skill:update', (_event, id: string, name: string, description: string | null, promptText: string, color: string, category: string) =>
    skillUpdate(id, name, description, promptText, color, category)
  )

  ipcMain.handle('skill:delete', (_event, id: string) => skillDelete(id))

  ipcMain.handle('skill:reorder', (_event, orderedIds: string[]) => skillReorder(orderedIds))
}
