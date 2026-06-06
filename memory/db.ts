import Database from 'better-sqlite3'
import { AsyncLocalStorage } from 'async_hooks'

// ── Two separate DB connections ────────────────────────────────────────────────
// appDb       → userData/app.db        : workspaces registry, skills, app_state
// workspaceDb → .swarmmind/memory.db   : tasks, memory entries, layouts, agent configs

let appDb: Database.Database | null = null
// The foreground (active) workspace connection — what the renderer/IPC layer
// reads and writes.
let workspaceDb: Database.Database | null = null

// All open workspace connections, keyed by workspace id. Agents in a workspace
// keep running after the user switches away (their PTYs aren't killed), so each
// such workspace keeps its own live connection rather than everyone sharing the
// single foreground one — otherwise a background agent's MCP write would land in
// whatever workspace happens to be active.
const workspaceConnections = new Map<string, Database.Database>()

// Per-request workspace override. MCP tool calls run inside `runWithWorkspace`
// so getWorkspaceDb() resolves to the *calling agent's* workspace. Renderer/IPC
// calls run with no context, so they keep using the foreground connection.
const workspaceCtx = new AsyncLocalStorage<{ workspaceId: string }>()

// Run `fn` with the workspace context bound to `workspaceId`. Used by the MCP
// server (per request) and by background event emits so writes route to the
// right workspace DB regardless of which one is in the foreground.
export function runWithWorkspace<T>(workspaceId: string, fn: () => T): T {
  return workspaceCtx.run({ workspaceId }, fn)
}

// The workspace id bound to the current async context, if any (MCP request).
export function getRequestWorkspaceId(): string | null {
  return workspaceCtx.getStore()?.workspaceId ?? null
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  prompt_text TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#7c3aed',
  category    TEXT NOT NULL DEFAULT 'general',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id     TEXT,
  type         TEXT NOT NULL CHECK(type IN ('context','history','preference')),
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(workspace_id, agent_id, key)
);
CREATE INDEX IF NOT EXISTS idx_memory_workspace ON memory_entries(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(workspace_id, type);
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  notes          TEXT,
  status         TEXT NOT NULL CHECK(status IN ('pending','in_progress','needs_review','done','failed')),
  assigned_agent TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_id, status);
CREATE TABLE IF NOT EXISTS pane_layouts (
  workspace_id TEXT PRIMARY KEY,
  layout_json  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_configs (
  workspace_id TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_agent   TEXT NOT NULL,
  to_agent     TEXT NOT NULL,
  body         TEXT NOT NULL,
  delivered    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_undelivered ON messages(workspace_id, delivered);
-- Unified swarm event log: an ordered, append-only stream of everything the
-- swarm does (memory writes, task transitions, messages, agent spawn/exit,
-- questions, orchestrator dispatch, cost ticks). The substrate the Swarm
-- Timeline and cost meter read from. The payload column is a JSON blob whose
-- shape depends on the type column (see memory/events.ts).
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  type         TEXT NOT NULL,
  agent_id     TEXT,
  pane_id      TEXT,
  payload      TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(workspace_id, ts);
-- Workspace checkpoints (Rewind): each row pins a whole-workspace git snapshot.
-- trees_json is the array of { path, commit, head } produced by snapshotWorkspace.
CREATE TABLE IF NOT EXISTS checkpoints (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  label        TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  trees_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_ts ON checkpoints(workspace_id, ts);
`

// ── Getters ───────────────────────────────────────────────────────────────────

export function getAppDb(): Database.Database {
  if (!appDb) throw new Error('App database not initialized — call initAppDb first')
  return appDb
}

export function getWorkspaceDb(): Database.Database {
  // Inside an MCP request (or a background event emit), route to the calling
  // agent's workspace connection. Outside one — the renderer/IPC path — use the
  // foreground connection. Fall back to foreground if the context's connection
  // isn't open, so a stale context can never throw mid-tool-call.
  const ctx = workspaceCtx.getStore()
  if (ctx) {
    const scoped = workspaceConnections.get(ctx.workspaceId)
    if (scoped) return scoped
  }
  if (!workspaceDb) throw new Error('No workspace open — call initWorkspaceDb first')
  return workspaceDb
}

export function hasWorkspaceDb(): boolean {
  return workspaceDb !== null
}

// ── Init functions ────────────────────────────────────────────────────────────

export function initAppDb(dbPath: string): Database.Database {
  appDb = new Database(dbPath)
  appDb.pragma('journal_mode = WAL')
  appDb.pragma('foreign_keys = ON')
  appDb.exec(APP_SCHEMA)

  // Seed default skills once
  const count = (appDb.prepare('SELECT COUNT(*) as n FROM skills').get() as { n: number }).n
  if (count === 0) {
    const now = Date.now()
    const ins = appDb.prepare(
      'INSERT INTO skills (id, name, description, prompt_text, color, category, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    const seeds: [string, string, string, string, string, string, number][] = [
      ['1', 'Code Reviewer',      'Find bugs, security issues, and performance problems',  'Please carefully review the following code. Identify any bugs, security vulnerabilities, performance issues, and suggest concrete improvements with examples.',                                '#ef4444', 'review',   0],
      ['2', 'Test Writer',        'Generate comprehensive unit tests',                      'Write thorough unit tests for this code. Cover the happy path, edge cases, and error conditions. Use descriptive test names.',                                                          '#10b981', 'testing',  1],
      ['3', 'Documentation',      'Write clear docs with usage examples',                   'Write clear, comprehensive documentation for this code. Include a summary, parameter descriptions, return values, and concrete usage examples.',                                          '#3b82f6', 'docs',     2],
      ['4', 'Refactor Guide',     'Improve readability and maintainability',                'Suggest how to refactor this code to improve readability, maintainability, and performance. Show before/after examples where helpful.',                                                  '#f59e0b', 'refactor', 3],
      ['5', 'Debug Helper',       'Systematic debugging and root cause analysis',           'Help me debug this issue. Analyze the code systematically, identify the most likely root causes, and suggest targeted fixes.',                                                           '#a78bfa', 'debug',    4],
      ['6', 'Architecture Review','Evaluate design decisions and patterns',                 'Review the architecture and design decisions in this code. Point out anti-patterns, suggest better abstractions, and identify coupling issues.',                                          '#fb923c', 'review',   5],
    ]
    for (const [id, name, desc, prompt, color, cat, order] of seeds) {
      ins.run(id, name, desc, prompt, color, cat, order, now, now)
    }
  }

  return appDb
}

// Recreates a workspace table without any FOREIGN KEY constraints, preserving rows. No-op when the
// table has no FKs (i.e. it was created by the current schema). `createSql` must define the table
// without an FK; `columns` are copied from the old table; `indexSql` rebuilds indexes afterwards
// (the old indexes follow the renamed table and are dropped with it).
function stripWorkspaceFk(
  db: Database.Database,
  table: string,
  createSql: string,
  columns: string[],
  indexSql: string[]
): void {
  try {
    const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all()
    if (fks.length === 0) return
    const cols = columns.join(', ')
    db.pragma('foreign_keys = OFF')
    db.exec(`
      ALTER TABLE ${table} RENAME TO ${table}_old;
      ${createSql}
      INSERT OR IGNORE INTO ${table} (${cols}) SELECT ${cols} FROM ${table}_old;
      DROP TABLE ${table}_old;
      ${indexSql.join('\n')}
    `)
    db.pragma('foreign_keys = ON')
  } catch { /* migration not needed or already applied */ }
}

// Open (or reuse) the connection for a workspace and make it the foreground one.
// Connections are kept open in `workspaceConnections` so a workspace whose agents
// keep running in the background still has a valid DB after the user switches
// away. `closeAll()` (on quit) and `closeWorkspaceDb()` (on delete) free them.
export function initWorkspaceDb(dbPath: string, workspaceId: string): Database.Database {
  let db = workspaceConnections.get(workspaceId)
  if (!db) {
    db = new Database(dbPath)
    applyWorkspaceSchema(db)
    workspaceConnections.set(workspaceId, db)
  }
  workspaceDb = db
  return db
}

// Apply the workspace schema + idempotent migrations to a freshly-opened
// connection. Run once per connection when it's first opened.
function applyWorkspaceSchema(workspaceDb: Database.Database): void {
  workspaceDb.pragma('journal_mode = WAL')
  workspaceDb.pragma('foreign_keys = ON')
  workspaceDb.exec(WORKSPACE_SCHEMA)
  // Migration: notes column may be missing on older DBs
  try { workspaceDb.exec('ALTER TABLE tasks ADD COLUMN notes TEXT') } catch { /* already exists */ }
  // Migration: depends_on (comma-separated prerequisite task ids) for the
  // orchestrator's task DAG. Absent on older DBs.
  try { workspaceDb.exec('ALTER TABLE tasks ADD COLUMN depends_on TEXT') } catch { /* already exists */ }
  // Migration: old DBs declared workspace_id REFERENCES workspaces(id) on every workspace table.
  // The workspaces table moved to appDb in the dual-DB architecture, so any INSERT now fails the
  // FK check (SQLITE_CONSTRAINT_FOREIGNKEY). Detect and recreate each table without the constraint,
  // preserving existing rows.
  stripWorkspaceFk(workspaceDb, 'memory_entries',
    `CREATE TABLE IF NOT EXISTS memory_entries (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id     TEXT,
      type         TEXT NOT NULL CHECK(type IN ('context','history','preference')),
      key          TEXT NOT NULL,
      value        TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      UNIQUE(workspace_id, agent_id, key)
    );`,
    ['id', 'workspace_id', 'agent_id', 'type', 'key', 'value', 'created_at', 'updated_at'],
    ['CREATE INDEX IF NOT EXISTS idx_memory_workspace ON memory_entries(workspace_id);',
     'CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(workspace_id, type);'])
  // Migration: widen the status CHECK to allow 'needs_review' (the review gate).
  // CHECK constraints can only change by recreating the table, so detect the old
  // constraint in the live schema and rebuild without an FK, preserving rows.
  try {
    const tasksSql = (workspaceDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).get() as { sql?: string } | undefined)?.sql ?? ''
    if (tasksSql && !tasksSql.includes('needs_review')) {
      workspaceDb.pragma('foreign_keys = OFF')
      workspaceDb.exec(`
        ALTER TABLE tasks RENAME TO tasks_pre_review;
        CREATE TABLE tasks (
          id             TEXT PRIMARY KEY,
          workspace_id   TEXT NOT NULL,
          title          TEXT NOT NULL,
          description    TEXT,
          notes          TEXT,
          status         TEXT NOT NULL CHECK(status IN ('pending','in_progress','needs_review','done','failed')),
          assigned_agent TEXT,
          depends_on     TEXT,
          created_by     TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        );
        INSERT INTO tasks (id, workspace_id, title, description, notes, status, assigned_agent, depends_on, created_by, created_at, updated_at)
          SELECT id, workspace_id, title, description, notes, status, assigned_agent, depends_on, created_by, created_at, updated_at FROM tasks_pre_review;
        DROP TABLE tasks_pre_review;
        CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_id, status);
      `)
      workspaceDb.pragma('foreign_keys = ON')
    }
  } catch { /* already migrated or table not yet present */ }
  stripWorkspaceFk(workspaceDb, 'tasks',
    `CREATE TABLE IF NOT EXISTS tasks (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL,
      title          TEXT NOT NULL,
      description    TEXT,
      notes          TEXT,
      status         TEXT NOT NULL CHECK(status IN ('pending','in_progress','needs_review','done','failed')),
      assigned_agent TEXT,
      depends_on     TEXT,
      created_by     TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );`,
    ['id', 'workspace_id', 'title', 'description', 'notes', 'status', 'assigned_agent', 'depends_on', 'created_by', 'created_at', 'updated_at'],
    ['CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);',
     'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_id, status);'])
  stripWorkspaceFk(workspaceDb, 'agent_configs',
    `CREATE TABLE IF NOT EXISTS agent_configs (
      workspace_id TEXT NOT NULL,
      agent_id     TEXT NOT NULL,
      config_json  TEXT NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );`,
    ['workspace_id', 'agent_id', 'config_json'], [])
  stripWorkspaceFk(workspaceDb, 'pane_layouts',
    `CREATE TABLE IF NOT EXISTS pane_layouts (workspace_id TEXT PRIMARY KEY, layout_json TEXT NOT NULL);`,
    ['workspace_id', 'layout_json'], [])
}

// Close one workspace's connection (e.g. when it's deleted). Drops it from the
// pool and clears the foreground pointer if it was the active one.
export function closeWorkspaceDb(workspaceId: string): void {
  const db = workspaceConnections.get(workspaceId)
  if (!db) return
  if (workspaceDb === db) workspaceDb = null
  workspaceConnections.delete(workspaceId)
  try { db.close() } catch { /* already closed */ }
}

export function closeAll(): void {
  for (const db of workspaceConnections.values()) {
    try { db.close() } catch { /* already closed */ }
  }
  workspaceConnections.clear()
  workspaceDb = null
  appDb?.close()
  appDb = null
}
