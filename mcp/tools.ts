import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  memoryRead,
  memoryWrite,
  memoryDelete,
  memoryList,
  memorySearch,
  taskCreate,
  taskUpdate,
  taskGet,
  taskAppendNote,
  taskList,
  messageSend,
  type MemoryType,
  type TaskStatus
} from '../memory/queries'
import { eventEmit } from '../memory/events'

// The MCP SDK threads a per-request `extra` object through each tool callback;
// SwarmMind injects the calling agent's id onto it at spawn time. Pull it out so
// every event we log is attributed to the agent that caused it.
function agentOf(extra: unknown): string | undefined {
  return (extra as { agentId?: string } | undefined)?.agentId
}

export function registerTools(server: McpServer, getWorkspaceId: () => string | null): void {
  // ── Memory tools ─────────────────────────────────────────────────────────────

  server.tool(
    'memory_read',
    'Read a value from shared workspace memory',
    {
      key: z.string().describe('The memory key to read'),
      agent_id: z.string().optional().describe('Agent scope (omit for shared memory)')
    },
    async ({ key, agent_id }) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const entry = memoryRead(workspaceId, key, agent_id ?? null)
      if (!entry) return { content: [{ type: 'text', text: `Key "${key}" not found` }], isError: true }
      return { content: [{ type: 'text', text: entry.value }] }
    }
  )

  server.tool(
    'memory_write',
    'Write a value to shared workspace memory',
    {
      key: z.string().describe('The memory key'),
      value: z.string().describe('The value to store (JSON or plain text)'),
      type: z.enum(['context', 'history', 'preference']).default('context').describe('Memory category'),
      agent_id: z.string().optional().describe('Agent scope (omit for shared memory)')
    },
    async ({ key, value, type, agent_id }, extra) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      memoryWrite(workspaceId, key, value, type as MemoryType, agent_id ?? null)
      eventEmit(workspaceId, 'memory_write', {
        agentId: agent_id ?? agentOf(extra),
        payload: { key, type },
      })
      return { content: [{ type: 'text', text: `Stored "${key}"` }] }
    }
  )

  server.tool(
    'memory_delete',
    'Delete a value from shared workspace memory',
    {
      key: z.string().describe('The memory key to delete'),
      agent_id: z.string().optional().describe('Agent scope (omit for shared memory)')
    },
    async ({ key, agent_id }) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const deleted = memoryDelete(workspaceId, key, agent_id ?? null)
      return { content: [{ type: 'text', text: deleted ? `Deleted "${key}"` : `Key "${key}" not found` }] }
    }
  )

  server.tool(
    'memory_list',
    'List keys in shared workspace memory',
    {
      type: z.enum(['context', 'history', 'preference']).optional().describe('Filter by category'),
      agent_id: z.string().optional().describe('Filter by agent scope')
    },
    async ({ type, agent_id }) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const entries = memoryList(workspaceId, type as MemoryType | undefined, agent_id)
      const lines = entries.map(e => `[${e.type}] ${e.agent_id ? `(${e.agent_id}) ` : ''}${e.key}`)
      return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'No entries found' }] }
    }
  )

  server.tool(
    'memory_search',
    'Search shared workspace memory by relevance to a query (ranked, not exact-key). Use this to find what the swarm already knows about a topic before re-discovering it.',
    {
      query: z.string().describe('What you are looking for, in natural language or keywords'),
      k: z.number().optional().describe('Max results to return (default 5)'),
      agent_id: z.string().optional().describe('Restrict to one agent scope (omit for shared memory)')
    },
    async ({ query, k, agent_id }) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const hits = memorySearch(workspaceId, query, k ?? 5, agent_id ?? undefined)
      if (!hits.length) return { content: [{ type: 'text', text: 'No relevant memory found' }] }
      const text = hits
        .map(h => `[${h.type}]${h.agent_id ? ` (${h.agent_id})` : ''} ${h.key}\n${h.value}`)
        .join('\n---\n')
      return { content: [{ type: 'text', text }] }
    }
  )

  // ── Task tools ────────────────────────────────────────────────────────────────

  server.tool(
    'task_create',
    'Create a task in the shared task queue. Returns the new task id, which can be passed as a dependency of later tasks.',
    {
      title: z.string().describe('Short task title'),
      description: z.string().optional().describe('Detailed description'),
      assigned_agent: z.string().optional().describe('Which agent to assign (claude|codex|kilo|opencode)'),
      depends_on: z.array(z.string()).optional().describe('Ids of tasks that must be done before this one can start (the orchestrator enforces this ordering)')
    },
    async ({ title, description, assigned_agent, depends_on }, extra) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const createdBy = agentOf(extra) ?? 'agent'
      const task = taskCreate(workspaceId, title, description ?? null, assigned_agent ?? null, createdBy, depends_on ?? null)
      eventEmit(workspaceId, 'task_create', {
        agentId: createdBy,
        payload: { taskId: task.id, title: task.title, assigned_agent: assigned_agent ?? null },
      })
      return { content: [{ type: 'text', text: `Created task ${task.id}: "${task.title}"` }] }
    }
  )

  server.tool(
    'task_update',
    'Update the status, assignment, or notes of a task',
    {
      id: z.string().describe('Task ID'),
      status: z.enum(['pending', 'in_progress', 'done', 'failed']).describe('New status'),
      assigned_agent: z.string().optional().describe('Reassign to agent'),
      notes: z.string().optional().describe('Replace the task notes (use task_note to append instead)')
    },
    async ({ id, status, assigned_agent, notes }, extra) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const task = taskUpdate(id, status as TaskStatus, assigned_agent, notes)
      if (!task) return { content: [{ type: 'text', text: `Task ${id} not found` }], isError: true }
      eventEmit(workspaceId, 'task_update', {
        agentId: assigned_agent ?? task.assigned_agent ?? agentOf(extra),
        payload: { taskId: id, title: task.title, status },
      })
      return { content: [{ type: 'text', text: `Updated task ${id} → ${status}` }] }
    }
  )

  server.tool(
    'task_get',
    'Get the full detail of a single task (title, description, status, notes, dependencies)',
    {
      id: z.string().describe('Task ID')
    },
    async ({ id }) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const t = taskGet(id)
      if (!t || t.workspace_id !== workspaceId) return { content: [{ type: 'text', text: `Task ${id} not found` }], isError: true }
      const lines = [
        `id: ${t.id}`,
        `title: ${t.title}`,
        `status: ${t.status}`,
        t.assigned_agent ? `assigned_agent: ${t.assigned_agent}` : null,
        t.depends_on ? `depends_on: ${t.depends_on}` : null,
        t.description ? `\ndescription:\n${t.description}` : null,
        t.notes ? `\nnotes:\n${t.notes}` : null
      ].filter(Boolean)
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }
  )

  server.tool(
    'task_note',
    'Append a timestamped progress note to a task without changing its status. Use this to record intermediate progress so other agents and the orchestrator can follow along.',
    {
      id: z.string().describe('Task ID'),
      note: z.string().describe('The progress note to append')
    },
    async ({ id, note }, extra) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const stamped = `[${new Date().toISOString()}] ${note}`
      const task = taskAppendNote(id, stamped)
      if (!task) return { content: [{ type: 'text', text: `Task ${id} not found` }], isError: true }
      eventEmit(workspaceId, 'task_note', {
        agentId: task.assigned_agent ?? agentOf(extra),
        payload: { taskId: id, title: task.title, note },
      })
      return { content: [{ type: 'text', text: `Noted on task ${id}` }] }
    }
  )

  server.tool(
    'task_list',
    'List tasks in the shared task queue',
    {
      status: z.enum(['pending', 'in_progress', 'done', 'failed']).optional().describe('Filter by status'),
      assigned_agent: z.string().optional().describe('Filter by assigned agent')
    },
    async ({ status, assigned_agent }) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const tasks = taskList(workspaceId, status as TaskStatus | undefined, assigned_agent)
      if (!tasks.length) return { content: [{ type: 'text', text: 'No tasks found' }] }
      const lines = tasks.map(t => `[${t.status}] ${t.id.slice(0, 8)} ${t.title}${t.assigned_agent ? ` → @${t.assigned_agent}` : ''}`)
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }
  )

  server.tool(
    'task_review',
    'Record a review verdict on a task that is awaiting review (status needs_review). approve → the task is marked done; reject → it returns to pending with your comment appended so the author can revise. Use this as the reviewer; do not review your own work.',
    {
      id: z.string().describe('Task ID under review'),
      verdict: z.enum(['approve', 'reject']).describe('approve = done, reject = back to pending'),
      comment: z.string().optional().describe('Review feedback (required-in-spirit for reject)')
    },
    async ({ id, verdict, comment }, extra) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      const t = taskGet(id)
      if (!t || t.workspace_id !== workspaceId) return { content: [{ type: 'text', text: `Task ${id} not found` }], isError: true }
      const reviewer = agentOf(extra)
      if (comment) taskAppendNote(id, `[review:${verdict}${reviewer ? ` by ${reviewer}` : ''}] ${comment}`)
      const newStatus: TaskStatus = verdict === 'approve' ? 'done' : 'pending'
      taskUpdate(id, newStatus)
      eventEmit(workspaceId, 'review', {
        agentId: reviewer,
        payload: { taskId: id, title: t.title, verdict, comment: comment?.slice(0, 200) ?? null },
      })
      return { content: [{ type: 'text', text: `Recorded ${verdict} on task ${id} → ${newStatus}` }] }
    }
  )

  // ── Agent messaging ─────────────────────────────────────────────────────────

  server.tool(
    'send_message',
    'Send a direct message to another agent. SwarmMind delivers it into a running pane of the recipient agent (when one is free). Use this for handoffs and coordination instead of polling shared memory.',
    {
      to: z.string().describe('Recipient agent id (claude|codex|cursor|windsurf|kilo|opencode|cline)'),
      from: z.string().describe('Your own agent id, so the recipient knows who sent it'),
      message: z.string().describe('The message body (kept to a concise single thought works best)')
    },
    async ({ to, from, message }) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      messageSend(workspaceId, from, to, message)
      eventEmit(workspaceId, 'message', {
        agentId: from,
        payload: { from, to, body: message.slice(0, 200) },
      })
      return { content: [{ type: 'text', text: `Message queued for ${to}` }] }
    }
  )

  // ── Coordination: declare file intent ────────────────────────────────────────

  server.tool(
    'file_intent',
    'Announce the files you are about to work on so other agents (and the human) can see it on the Changes panel and avoid editing the same files. Call this before a multi-file change.',
    {
      paths: z.array(z.string()).describe('Repo-relative file paths you intend to modify'),
      note: z.string().optional().describe('Optional short note about what you plan to do')
    },
    async ({ paths, note }, extra) => {
      const workspaceId = getWorkspaceId()
      if (!workspaceId) return { content: [{ type: 'text', text: 'No workspace open' }], isError: true }
      eventEmit(workspaceId, 'file_intent', {
        agentId: agentOf(extra),
        payload: { paths: paths.slice(0, 50), note: note ?? null },
      })
      return { content: [{ type: 'text', text: `Noted intent on ${paths.length} file(s)` }] }
    }
  )
}
