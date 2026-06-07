import { v4 as uuidv4 } from 'uuid'
import { basename } from 'path'
import { getAppDb, getWorkspaceDb } from './db'

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryType = 'context' | 'history' | 'preference'
export type TaskStatus = 'pending' | 'in_progress' | 'needs_review' | 'done' | 'failed'
// Keep this union in sync with the renderer-side copy in src/store/workspace.ts.
// (The two process bundles can't share a module without restructuring the
// tsconfig includes, so the canonical list is mirrored in both places.)
export type AgentId = 'claude' | 'codex' | 'cursor' | 'windsurf' | 'kilo' | 'opencode' | 'cline'

export interface Workspace {
  id: string
  name: string
  root_path: string
  created_at: number
  updated_at: number
}

export interface MemoryEntry {
  id: string
  workspace_id: string
  agent_id: string | null
  type: MemoryType
  key: string
  value: string
  created_at: number
  updated_at: number
}

export interface Task {
  id: string
  workspace_id: string
  title: string
  description: string | null
  notes: string | null
  status: TaskStatus
  assigned_agent: string | null
  // Comma-separated ids of prerequisite tasks; the orchestrator only dispatches
  // a task once all of these are `done`. Null/empty = no dependencies.
  depends_on: string | null
  created_by: string
  created_at: number
  updated_at: number
}

export interface AgentConfig {
  apiKey?: string
  model?: string
  extraFlags?: string[]
  executablePath?: string
  env?: Record<string, string>
  // HMAC over the spawn-affecting fields (executablePath/extraFlags/env), set by
  // writeAgentConfig using a per-install key stored in app.db. The PTY spawn path
  // only honors those fields when this verifies, so a cloned/untrusted repo's
  // workspace memory.db can't inject a malicious launch command. See
  // electron/agent-config.ts::readAgentConfigForSpawn.
  _sig?: string
}

// ── Workspaces ────────────────────────────────────────────────────────────────

// `name` is only applied when explicitly provided (workspace creation/rename).
// Re-opening an existing workspace passes no name so the user's custom name is
// preserved rather than being reset to the folder basename on every open.
export function upsertWorkspace(rootPath: string, name?: string): Workspace {
  const db = getAppDb()
  const now = Date.now()
  const existing = db.prepare('SELECT * FROM workspaces WHERE root_path = ?').get(rootPath) as Workspace | undefined
  if (existing) {
    const newName = name?.trim() || existing.name
    db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?').run(newName, now, existing.id)
    return { ...existing, name: newName, updated_at: now }
  }
  const finalName = name?.trim() || basename(rootPath)
  const id = uuidv4()
  db.prepare('INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, finalName, rootPath, now, now)
  return { id, name: finalName, root_path: rootPath, created_at: now, updated_at: now }
}

export function renameWorkspace(id: string, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  return getAppDb().prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, Date.now(), id).changes > 0
}

export function listWorkspaces(): Workspace[] {
  return getAppDb().prepare('SELECT * FROM workspaces ORDER BY updated_at DESC').all() as Workspace[]
}

export function deleteWorkspace(id: string): boolean {
  return getAppDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes > 0
}

// ── Memory entries ────────────────────────────────────────────────────────────

export function memoryWrite(
  workspaceId: string,
  key: string,
  value: string,
  type: MemoryType,
  agentId: string | null = null
): MemoryEntry {
  const db = getWorkspaceDb()
  const now = Date.now()
  const existing = db.prepare(
    'SELECT * FROM memory_entries WHERE workspace_id = ? AND key = ? AND agent_id IS ?'
  ).get(workspaceId, key, agentId) as MemoryEntry | undefined

  if (existing) {
    db.prepare('UPDATE memory_entries SET value = ?, type = ?, updated_at = ? WHERE id = ?').run(value, type, now, existing.id)
    return { ...existing, value, type, updated_at: now }
  }
  const id = uuidv4()
  db.prepare(
    'INSERT INTO memory_entries (id, workspace_id, agent_id, type, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, workspaceId, agentId, type, key, value, now, now)
  return { id, workspace_id: workspaceId, agent_id: agentId, type, key, value, created_at: now, updated_at: now }
}

export function memoryRead(workspaceId: string, key: string, agentId: string | null = null): MemoryEntry | null {
  return (getWorkspaceDb().prepare(
    'SELECT * FROM memory_entries WHERE workspace_id = ? AND key = ? AND agent_id IS ?'
  ).get(workspaceId, key, agentId) as MemoryEntry | undefined) ?? null
}

export function memoryDelete(workspaceId: string, key: string, agentId: string | null = null): boolean {
  const result = getWorkspaceDb().prepare(
    'DELETE FROM memory_entries WHERE workspace_id = ? AND key = ? AND agent_id IS ?'
  ).run(workspaceId, key, agentId)
  return result.changes > 0
}

export function memoryList(workspaceId: string, type?: MemoryType, agentId?: string | null): MemoryEntry[] {
  const db = getWorkspaceDb()
  if (type && agentId !== undefined) {
    return db.prepare(
      'SELECT * FROM memory_entries WHERE workspace_id = ? AND type = ? AND agent_id IS ? ORDER BY updated_at DESC'
    ).all(workspaceId, type, agentId) as MemoryEntry[]
  }
  if (type) {
    return db.prepare(
      'SELECT * FROM memory_entries WHERE workspace_id = ? AND type = ? ORDER BY updated_at DESC'
    ).all(workspaceId, type) as MemoryEntry[]
  }
  return db.prepare(
    'SELECT * FROM memory_entries WHERE workspace_id = ? ORDER BY updated_at DESC'
  ).all(workspaceId) as MemoryEntry[]
}

// ── Memory search (relevance ranking) ─────────────────────────────────────────
// A lexical TF·IDF ranker over memory entries — the dependable, zero-dependency
// baseline for "what do we know about X". (A vector/semantic upgrade can slot in
// behind this same signature later; see docs/swarm-upgrades.md Phase 4.) Powers
// the memory_search MCP tool and the conductor's context compiler.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'into', 'will', 'should',
])

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
}

export interface ScoredMemoryEntry extends MemoryEntry {
  score: number
}

export function memorySearch(workspaceId: string, query: string, k = 5, agentId?: string | null): ScoredMemoryEntry[] {
  const terms = tokenize(query)
  if (!terms.length) return []
  const entries = memoryList(workspaceId, undefined, agentId)
  if (!entries.length) return []

  // Precompute per-entry token bags. The key is weighted heavily (a key match is
  // a strong topical signal) by counting its tokens multiple times.
  const KEY_BOOST = 3
  const bags = entries.map(e => {
    const counts = new Map<string, number>()
    const add = (text: string, weight: number) => {
      for (const tok of tokenize(text)) counts.set(tok, (counts.get(tok) ?? 0) + weight)
    }
    add(e.key, KEY_BOOST)
    add(e.value, 1)
    return counts
  })

  // Document frequency for IDF, restricted to query terms.
  const df = new Map<string, number>()
  for (const term of new Set(terms)) {
    let n = 0
    for (const bag of bags) if (bag.has(term)) n++
    df.set(term, n)
  }
  const N = entries.length

  const scored = entries.map((e, i) => {
    const bag = bags[i]
    let score = 0
    for (const term of terms) {
      const tf = bag.get(term) ?? 0
      if (!tf) continue
      const idf = Math.log(1 + N / (1 + (df.get(term) ?? 0)))
      score += tf * idf
    }
    // Gentle recency nudge so fresher facts win ties.
    if (score > 0) score += Math.min(0.25, (e.updated_at / Date.now()) * 0.25)
    return { ...e, score }
  })

  return scored
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(k, 25)))
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function taskCreate(
  workspaceId: string,
  title: string,
  description: string | null,
  assignedAgent: string | null,
  createdBy: string,
  dependsOn: string[] | null = null
): Task {
  const db = getWorkspaceDb()
  const now = Date.now()
  const id = uuidv4()
  const deps = dependsOn && dependsOn.length ? dependsOn.join(',') : null
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, description, notes, status, assigned_agent, depends_on, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)'
  ).run(id, workspaceId, title, description, 'pending', assignedAgent, deps, createdBy, now, now)
  return { id, workspace_id: workspaceId, title, description, notes: null, status: 'pending', assigned_agent: assignedAgent, depends_on: deps, created_by: createdBy, created_at: now, updated_at: now }
}

export function taskUpdate(id: string, status: TaskStatus, assignedAgent?: string | null, notes?: string): Task | null {
  const db = getWorkspaceDb()
  const now = Date.now()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined
  if (!task) return null
  const newAgent = assignedAgent !== undefined ? assignedAgent : task.assigned_agent
  const newNotes = notes !== undefined ? notes : task.notes
  db.prepare('UPDATE tasks SET status = ?, assigned_agent = ?, notes = ?, updated_at = ? WHERE id = ?').run(status, newAgent, newNotes, now, id)
  return { ...task, status, assigned_agent: newAgent, notes: newNotes, updated_at: now }
}

export function taskGet(id: string): Task | null {
  return (getWorkspaceDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined) ?? null
}

export function taskAppendNote(id: string, note: string): Task | null {
  const db = getWorkspaceDb()
  const now = Date.now()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined
  if (!task) return null
  const newNotes = task.notes ? `${task.notes}\n---\n${note}` : note
  db.prepare('UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?').run(newNotes, now, id)
  return { ...task, notes: newNotes, updated_at: now }
}

export function taskList(workspaceId: string, status?: TaskStatus, assignedAgent?: string): Task[] {
  const db = getWorkspaceDb()
  if (status && assignedAgent) {
    return db.prepare(
      'SELECT * FROM tasks WHERE workspace_id = ? AND status = ? AND assigned_agent = ? ORDER BY created_at DESC'
    ).all(workspaceId, status, assignedAgent) as Task[]
  }
  if (status) {
    return db.prepare(
      'SELECT * FROM tasks WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC'
    ).all(workspaceId, status) as Task[]
  }
  return db.prepare(
    'SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC'
  ).all(workspaceId) as Task[]
}

// ── Agent-to-agent messages ─────────────────────────────────────────────────
// A lightweight directed mailbox. Agents post with the send_message MCP tool;
// the renderer-side conductor polls undelivered messages each tick and injects
// them into a running pane of the recipient agent, then marks them delivered.

export interface Message {
  id: string
  workspace_id: string
  from_agent: string
  to_agent: string
  body: string
  delivered: number
  created_at: number
}

export function messageSend(workspaceId: string, fromAgent: string, toAgent: string, body: string): Message {
  const db = getWorkspaceDb()
  const id = uuidv4()
  const now = Date.now()
  db.prepare(
    'INSERT INTO messages (id, workspace_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(id, workspaceId, fromAgent, toAgent, body, now)
  return { id, workspace_id: workspaceId, from_agent: fromAgent, to_agent: toAgent, body, delivered: 0, created_at: now }
}

export function messagesUndelivered(workspaceId: string): Message[] {
  return getWorkspaceDb().prepare(
    'SELECT * FROM messages WHERE workspace_id = ? AND delivered = 0 ORDER BY created_at ASC'
  ).all(workspaceId) as Message[]
}

export function messageMarkDelivered(id: string): void {
  getWorkspaceDb().prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(id)
}

// ── Checkpoints (Rewind) ──────────────────────────────────────────────────────
// A checkpoint pins a whole-workspace git snapshot (see git-manager.ts
// snapshotWorkspace). `trees` is opaque to the DB layer — stored as JSON and
// handed back to git-manager for restore.

export interface CheckpointRecord {
  id: string
  workspace_id: string
  ts: number
  label: string
  trigger: string
  trees: { path: string; commit: string; head: string | null }[]
}

interface CheckpointRow {
  id: string
  workspace_id: string
  ts: number
  label: string
  trigger: string
  trees_json: string
}

function checkpointRowTo(r: CheckpointRow): CheckpointRecord {
  let trees: CheckpointRecord['trees'] = []
  try { trees = JSON.parse(r.trees_json) } catch { trees = [] }
  return { id: r.id, workspace_id: r.workspace_id, ts: r.ts, label: r.label, trigger: r.trigger, trees }
}

export function checkpointInsert(
  workspaceId: string,
  id: string,
  label: string,
  trigger: string,
  trees: CheckpointRecord['trees']
): CheckpointRecord {
  const ts = Date.now()
  getWorkspaceDb().prepare(
    'INSERT INTO checkpoints (id, workspace_id, ts, label, trigger, trees_json) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, workspaceId, ts, label, trigger, JSON.stringify(trees))
  return { id, workspace_id: workspaceId, ts, label, trigger, trees }
}

export function checkpointList(workspaceId: string): CheckpointRecord[] {
  const rows = getWorkspaceDb().prepare(
    'SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY ts DESC'
  ).all(workspaceId) as CheckpointRow[]
  return rows.map(checkpointRowTo)
}

export function checkpointGet(id: string): CheckpointRecord | null {
  const row = getWorkspaceDb().prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as CheckpointRow | undefined
  return row ? checkpointRowTo(row) : null
}

export function checkpointDelete(id: string): boolean {
  return getWorkspaceDb().prepare('DELETE FROM checkpoints WHERE id = ?').run(id).changes > 0
}

// ── Pane layout ───────────────────────────────────────────────────────────────

export function saveLayout(workspaceId: string, layoutJson: string): void {
  getWorkspaceDb().prepare(
    'INSERT OR REPLACE INTO pane_layouts (workspace_id, layout_json) VALUES (?, ?)'
  ).run(workspaceId, layoutJson)
}

export function loadLayout(workspaceId: string): string | null {
  const row = getWorkspaceDb().prepare('SELECT layout_json FROM pane_layouts WHERE workspace_id = ?').get(workspaceId) as { layout_json: string } | undefined
  return row?.layout_json ?? null
}

// ── Agent configs ─────────────────────────────────────────────────────────────

export function getAgentConfig(workspaceId: string, agentId: AgentId): AgentConfig {
  const row = getWorkspaceDb().prepare(
    'SELECT config_json FROM agent_configs WHERE workspace_id = ? AND agent_id = ?'
  ).get(workspaceId, agentId) as { config_json: string } | undefined
  return row ? (JSON.parse(row.config_json) as AgentConfig) : {}
}

export function setAgentConfig(workspaceId: string, agentId: AgentId, config: AgentConfig): void {
  getWorkspaceDb().prepare(
    'INSERT OR REPLACE INTO agent_configs (workspace_id, agent_id, config_json) VALUES (?, ?, ?)'
  ).run(workspaceId, agentId, JSON.stringify(config))
}

// ── Skills ────────────────────────────────────────────────────────────────────

export interface Skill {
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

export function skillList(): Skill[] {
  return getAppDb().prepare('SELECT * FROM skills ORDER BY sort_order ASC, created_at ASC').all() as Skill[]
}

export function skillCreate(name: string, description: string | null, promptText: string, color: string, category: string): Skill {
  const db = getAppDb()
  const now = Date.now()
  const id = uuidv4()
  const maxOrder = (db.prepare('SELECT MAX(sort_order) as m FROM skills').get() as { m: number | null }).m ?? -1
  db.prepare(
    'INSERT INTO skills (id, name, description, prompt_text, color, category, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, name, description, promptText, color, category, maxOrder + 1, now, now)
  return { id, name, description, prompt_text: promptText, color, category, sort_order: maxOrder + 1, created_at: now, updated_at: now }
}

export function skillUpdate(id: string, name: string, description: string | null, promptText: string, color: string, category: string): Skill | null {
  const db = getAppDb()
  const now = Date.now()
  const existing = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill | undefined
  if (!existing) return null
  db.prepare('UPDATE skills SET name=?, description=?, prompt_text=?, color=?, category=?, updated_at=? WHERE id=?').run(name, description, promptText, color, category, now, id)
  return { ...existing, name, description, prompt_text: promptText, color, category, updated_at: now }
}

export function skillDelete(id: string): boolean {
  return getAppDb().prepare('DELETE FROM skills WHERE id = ?').run(id).changes > 0
}

// Persist a new ordering. `orderedIds` is the full list of skill ids in the
// desired display order; each row's sort_order is rewritten to its index.
export function skillReorder(orderedIds: string[]): void {
  const db = getAppDb()
  const now = Date.now()
  const upd = db.prepare('UPDATE skills SET sort_order = ?, updated_at = ? WHERE id = ?')
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((id, i) => upd.run(i, now, id))
  })
  tx(orderedIds)
}

// ── App state (last workspace, etc.) ─────────────────────────────────────────

export function getAppState(key: string): string | null {
  const row = getAppDb().prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setAppState(key: string, value: string): void {
  getAppDb().prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run(key, value)
}
