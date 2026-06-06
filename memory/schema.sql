-- Reference schema. The authoritative schema (plus runtime migrations) lives in
-- memory/db.ts as inline strings, split across two databases: workspaces/skills/
-- app_state in app.db, and the rest in each workspace's .swarmmind/memory.db.
-- Keep this file in sync with db.ts when columns change.

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  description    TEXT,
  notes          TEXT,
  status         TEXT NOT NULL CHECK(status IN ('pending','in_progress','done','failed')),
  assigned_agent TEXT,
  -- Comma-separated ids of prerequisite tasks (the orchestrator's task DAG).
  depends_on     TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_id, status);

-- Directed agent-to-agent mailbox; the conductor delivers undelivered rows into
-- a running pane of the recipient agent.
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_agent   TEXT NOT NULL,
  to_agent     TEXT NOT NULL,
  body         TEXT NOT NULL,
  delivered    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_undelivered ON messages(workspace_id, delivered);

CREATE TABLE IF NOT EXISTS pane_layouts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  layout_json  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_configs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
