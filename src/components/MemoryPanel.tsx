import React, { useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { useMemory, type MemoryEntry, type Task } from '../hooks/useMemory'

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--text-dim)',
  in_progress: 'var(--accent)',
  needs_review: 'var(--warning)',
  done: 'var(--success)',
  failed: 'var(--error)'
}

export function MemoryPanel() {
  const workspace = useWorkspaceStore(s => s.workspace)
  const [tab, setTab] = useState<'memory' | 'tasks'>('memory')
  const [filter, setFilter] = useState('')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)

  const { entries, tasks, refresh } = useMemory(workspace?.id ?? null)

  // Distinct agents present among entries, for the agent filter chips.
  const agentIds = Array.from(new Set(entries.map(e => e.agent_id).filter((a): a is string => !!a)))

  const filteredEntries = entries.filter(e => {
    if (agentFilter !== 'all' && (e.agent_id ?? '') !== agentFilter) return false
    if (!filter) return true
    const q = filter.toLowerCase()
    return e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)
  })

  const handleDelete = async (e: MemoryEntry) => {
    await window.swarmmind.memoryDelete(e.key, e.agent_id ?? undefined)
    if (editing?.id === e.id) setEditing(null)
    refresh()
  }

  const handleSaveEdit = async (e: MemoryEntry) => {
    if (!editing) return
    await window.swarmmind.memoryWrite(e.key, editing.value, e.type, e.agent_id ?? undefined)
    setEditing(null)
    refresh()
  }

  const grouped = filteredEntries.reduce<Record<string, MemoryEntry[]>>((acc, e) => {
    const key = e.type
    if (!acc[key]) acc[key] = []
    acc[key].push(e)
    return acc
  }, {})

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div style={styles.tabs}>
          <button
            style={{ ...styles.tab, ...(tab === 'memory' ? styles.tabActive : {}) }}
            onClick={() => setTab('memory')}
          >
            Memory ({entries.length})
          </button>
          <button
            style={{ ...styles.tab, ...(tab === 'tasks' ? styles.tabActive : {}) }}
            onClick={() => setTab('tasks')}
          >
            Tasks ({tasks.length})
          </button>
        </div>
        <button style={styles.refreshBtn} onClick={refresh} title="Refresh">↻</button>
      </div>

      {tab === 'memory' && (
        <>
          <div style={styles.search}>
            <input
              style={styles.searchInput}
              placeholder="Filter…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          </div>
          {agentIds.length > 0 && (
            <div style={styles.agentFilterRow}>
              <button
                style={{ ...styles.agentChip, ...(agentFilter === 'all' ? styles.agentChipActive : {}) }}
                onClick={() => setAgentFilter('all')}
              >all</button>
              {agentIds.map(a => (
                <button
                  key={a}
                  style={{ ...styles.agentChip, ...(agentFilter === a ? styles.agentChipActive : {}) }}
                  onClick={() => setAgentFilter(a)}
                >@{a}</button>
              ))}
            </div>
          )}
          <div style={styles.scroll}>
            {!workspace ? (
              <p style={styles.empty}>No workspace open</p>
            ) : entries.length === 0 ? (
              <p style={styles.empty}>No memory entries yet</p>
            ) : (
              Object.entries(grouped).map(([type, group]) => (
                <div key={type}>
                  <div style={styles.groupLabel}>{type}</div>
                  {group.map(e => (
                    <div key={e.id} style={styles.entry}>
                      <button
                        style={styles.entryHeader}
                        onClick={() => setExpanded(prev => prev === e.id ? null : e.id)}
                      >
                        <span style={styles.entryKey}>{e.key}</span>
                        {e.agent_id && <span style={styles.entryAgent}>@{e.agent_id}</span>}
                        <span style={styles.entryChevron}>{expanded === e.id ? '▾' : '▸'}</span>
                      </button>
                      {expanded === e.id && (
                        editing?.id === e.id ? (
                          <div style={styles.editWrap}>
                            <textarea
                              style={styles.editArea}
                              value={editing.value}
                              onChange={ev => setEditing({ id: e.id, value: ev.target.value })}
                              rows={6}
                              spellCheck={false}
                            />
                            <div style={styles.entryActions}>
                              <button style={styles.entryBtn} onClick={() => handleSaveEdit(e)}>Save</button>
                              <button style={styles.entryBtn} onClick={() => setEditing(null)}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <pre style={styles.entryValue}>{e.value}</pre>
                            <div style={styles.entryActions}>
                              <button style={styles.entryBtn} onClick={() => setEditing({ id: e.id, value: e.value })}>Edit</button>
                              <button style={{ ...styles.entryBtn, ...styles.entryBtnDanger }} onClick={() => handleDelete(e)}>Delete</button>
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {tab === 'tasks' && (
        <TasksTab tasks={tasks} refresh={refresh} workspaceId={workspace?.id ?? null} />
      )}
    </div>
  )
}

function TasksTab({ tasks, refresh, workspaceId }: { tasks: Task[]; refresh: () => void; workspaceId: string | null }) {
  const [newTitle, setNewTitle] = useState('')

  const createTask = async () => {
    if (!newTitle.trim() || !workspaceId) return
    await window.swarmmind.taskCreate(newTitle.trim())
    setNewTitle('')
    refresh()
  }

  const columns: Array<Task['status']> = ['pending', 'in_progress', 'needs_review', 'done', 'failed']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={styles.newTaskRow}>
        <input
          style={styles.newTaskInput}
          placeholder="New task title…"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createTask()}
        />
        <button style={styles.addBtn} onClick={createTask} disabled={!newTitle.trim()}>+</button>
      </div>
      <div style={styles.scroll}>
        {columns.map(status => {
          const col = tasks.filter(t => t.status === status)
          if (col.length === 0 && status !== 'pending') return null
          return (
            <div key={status}>
              <div style={{ ...styles.groupLabel, color: STATUS_COLORS[status] ?? 'var(--text-dim)' }}>
                {status.replace('_', ' ')} ({col.length})
              </div>
              {col.map(t => (
                <div key={t.id} style={styles.taskCard}>
                  <div style={styles.taskTitle}>{t.title}</div>
                  {t.description && <div style={styles.taskDesc}>{t.description}</div>}
                  {t.assigned_agent && <div style={styles.taskAgent}>@{t.assigned_agent}</div>}
                  <div style={styles.taskActions}>
                    {status !== 'done' && (
                      <button
                        style={styles.taskBtn}
                        onClick={async () => { await window.swarmmind.taskUpdate(t.id, 'done'); refresh() }}
                      >
                        ✓ Done
                      </button>
                    )}
                    {status === 'pending' && (
                      <button
                        style={styles.taskBtn}
                        onClick={async () => { await window.swarmmind.taskUpdate(t.id, 'in_progress'); refresh() }}
                      >
                        Start
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-panel)',
    borderLeft: '1px solid var(--border)',
    overflow: 'hidden'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 8px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    gap: 4
  },
  tabs: { display: 'flex', gap: 2, flex: 1 },
  tab: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 11,
    borderRadius: 'var(--radius)'
  },
  tabActive: {
    color: 'var(--text-primary)',
    background: 'var(--bg-active)'
  },
  refreshBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-dim)',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 4px'
  },
  search: {
    padding: '6px 8px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0
  },
  searchInput: {
    width: '100%',
    background: 'var(--bg-base)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '4px 8px',
    fontSize: 11,
    outline: 'none'
  },
  scroll: {
    flex: 1,
    overflowY: 'auto',
    padding: '4px 0'
  },
  empty: {
    color: 'var(--text-dim)',
    fontSize: 11,
    padding: '16px',
    textAlign: 'center'
  },
  groupLabel: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--text-dim)',
    padding: '8px 10px 4px'
  },
  entry: {
    borderBottom: '1px solid var(--border)'
  },
  entryHeader: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    background: 'transparent',
    border: 'none',
    padding: '5px 10px',
    gap: 6,
    cursor: 'pointer',
    color: 'var(--text-primary)',
    textAlign: 'left'
  },
  entryKey: { flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  entryAgent: { fontSize: 10, color: 'var(--accent)', background: 'var(--bg-active)', padding: '1px 5px', borderRadius: 8 },
  entryChevron: { color: 'var(--text-dim)', fontSize: 10, flexShrink: 0 },
  agentFilterRow: { display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0 8px 6px' },
  agentChip: { fontSize: 10, padding: '2px 8px', borderRadius: 9999, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' },
  agentChipActive: { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-subtle)' },
  entryActions: { display: 'flex', gap: 6, padding: '0 10px 8px', background: 'var(--bg-base)' },
  entryBtn: { fontSize: 10, padding: '2px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer' },
  entryBtnDanger: { color: 'var(--error)', borderColor: 'rgba(248,113,113,0.3)' },
  editWrap: { padding: '4px 10px 8px', background: 'var(--bg-base)' },
  editArea: { width: '100%', boxSizing: 'border-box', fontSize: 10, fontFamily: 'var(--font-mono)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 6, resize: 'vertical', outline: 'none' },
  entryValue: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
    padding: '4px 10px 8px',
    background: 'var(--bg-base)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 200,
    overflowY: 'auto',
    margin: 0
  },
  newTaskRow: {
    display: 'flex',
    gap: 4,
    padding: '6px 8px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0
  },
  newTaskInput: {
    flex: 1,
    background: 'var(--bg-base)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '4px 8px',
    fontSize: 11,
    outline: 'none'
  },
  addBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--accent-fg)',
    width: 26,
    cursor: 'pointer',
    fontSize: 16,
    fontWeight: 700
  },
  taskCard: {
    padding: '6px 10px',
    borderBottom: '1px solid var(--border)'
  },
  taskTitle: { fontSize: 11, color: 'var(--text-primary)', marginBottom: 2 },
  taskDesc: { fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4 },
  taskAgent: { fontSize: 10, color: 'var(--accent)', marginBottom: 4 },
  taskActions: { display: 'flex', gap: 4 },
  taskBtn: {
    background: 'var(--bg-active)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-secondary)',
    padding: '2px 7px',
    fontSize: 10,
    cursor: 'pointer'
  }
}
