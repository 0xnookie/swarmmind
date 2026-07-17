import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { memoryList, taskList } from '../memory/queries'

export function registerResources(server: McpServer, getWorkspaceId: () => string | null): void {
  server.resource(
    'project_context',
    'swarmmind://project_context',
    async () => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { contents: [{ uri: 'swarmmind://project_context', text: 'No workspace open', mimeType: 'text/plain' }] }
      const entries = memoryList(workspaceId, 'context')
      const text = entries.map(e => `# ${e.key}\n${e.value}`).join('\n\n---\n\n')
      return { contents: [{ uri: 'swarmmind://project_context', text: text || '(empty)', mimeType: 'text/markdown' }] }
    }
  )

  server.resource(
    'task_list',
    'swarmmind://task_list',
    async () => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { contents: [{ uri: 'swarmmind://task_list', text: 'No workspace open', mimeType: 'text/plain' }] }
      const tasks = taskList(workspaceId)
      const text = tasks.map(t => {
        const prio = (t.priority ?? 0) !== 0 ? ` ★${t.priority}` : ''
        const assignee = t.assigned_agent ? `\n  → @${t.assigned_agent}` : ''
        const deps = t.depends_on ? `\n  depends_on: ${t.depends_on}` : ''
        return `[${t.status}]${prio} ${t.id.slice(0, 8)} — ${t.title}${t.description ? `\n  ${t.description}` : ''}${assignee}${deps}`
      }).join('\n\n')
      return { contents: [{ uri: 'swarmmind://task_list', text: text || '(no tasks)', mimeType: 'text/plain' }] }
    }
  )

  const historyTemplate = new ResourceTemplate('swarmmind://conversation_history/{agentId}', { list: undefined })
  server.resource(
    'conversation_history',
    historyTemplate,
    async (uri, { agentId }) => {
      const workspaceId = getWorkspaceId()
      const agent = Array.isArray(agentId) ? agentId[0] : agentId
      if (!workspaceId) return { contents: [{ uri: uri.href, text: 'No workspace open', mimeType: 'text/plain' }] }
      const entries = memoryList(workspaceId, 'history', agent)
      const text = entries.map(e => `## ${e.key}\n${e.value}`).join('\n\n---\n\n')
      return { contents: [{ uri: uri.href, text: text || '(no history)', mimeType: 'text/markdown' }] }
    }
  )
}
