import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useWorkspaceStore, type AgentId } from '../store/workspace'
import { AGENTS, AgentIcon } from '../data/agents'
import { useT, type TranslationKey } from '../i18n'

export interface KanbanTask {
  id: string
  workspace_id: string
  title: string
  description: string | null
  notes: string | null
  status: 'pending' | 'in_progress' | 'needs_review' | 'done' | 'failed'
  assigned_agent: string | null
  // Comma-separated ids of prerequisite tasks (see memory/queries.ts Task).
  depends_on: string | null
  created_by: string
  created_at: number
  updated_at: number
}

const COLUMNS: { key: KanbanTask['status']; labelKey: TranslationKey }[] = [
  { key: 'pending',      labelKey: 'kanban.col.pending' },
  { key: 'in_progress',  labelKey: 'kanban.col.in_progress' },
  { key: 'needs_review', labelKey: 'kanban.col.needs_review' },
  { key: 'done',         labelKey: 'kanban.col.done' },
  { key: 'failed',       labelKey: 'kanban.col.failed' },
]

// `depends_on` is a comma-separated list of prerequisite task ids (see
// memory/queries.ts). Parse it into a clean array.
const parseDeps = (t: KanbanTask): string[] =>
  t.depends_on ? t.depends_on.split(',').map(s => s.trim()).filter(Boolean) : []

// Filter value for the agent chips: 'all', the unassigned sentinel, or an agent id.
const UNASSIGNED = '__none__'

export function KanbanBoard() {
  const t = useT()
  const [tasks, setTasks] = useState<KanbanTask[]>([])

  const refresh = useCallback(async () => {
    const tsk = await window.swarmmind.taskList() as KanbanTask[]
    setTasks(tsk ?? [])
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [refresh])

  const onRefresh = refresh
  const workspace = useWorkspaceStore(s => s.workspace)
  const addPane = useWorkspaceStore(s => s.addPane)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newAgent, setNewAgent] = useState<AgentId | ''>('')
  const [newDeps, setNewDeps] = useState<string[]>([])
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [noteInput, setNoteInput] = useState<{ id: string; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [agentFilter, setAgentFilter] = useState<string>('all')

  // Lookups derived from the raw task list (cheap, kept fresh on each refresh):
  //  - byId: resolve a prerequisite id → its task (for dependency labels/status)
  //  - doneIds: ids of completed tasks, so we can flag still-blocked work exactly
  //    the way the conductor gates dispatch (all depends_on must be `done`).
  const byId = useMemo(() => {
    const m = new Map<string, KanbanTask>()
    for (const t of tasks) m.set(t.id, t)
    return m
  }, [tasks])
  const doneIds = useMemo(() => new Set(tasks.filter(t => t.status === 'done').map(t => t.id)), [tasks])
  const isBlocked = useCallback(
    (t: KanbanTask) => parseDeps(t).some(d => byId.has(d) && !doneIds.has(d)),
    [byId, doneIds]
  )

  // Which agents actually appear on the board (drives the filter chips), plus
  // whether any task is currently unassigned.
  const presentAgents = useMemo(() => {
    const ids = new Set(tasks.map(t => t.assigned_agent).filter(Boolean) as string[])
    return AGENTS.filter(a => ids.has(a.id))
  }, [tasks])
  const hasUnassigned = useMemo(() => tasks.some(t => !t.assigned_agent), [tasks])

  // Apply the search + agent filter once, then bucket by status for the columns.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tasks.filter(t => {
      if (agentFilter === UNASSIGNED ? !!t.assigned_agent
        : agentFilter !== 'all' && t.assigned_agent !== agentFilter) return false
      if (!q) return true
      return t.title.toLowerCase().includes(q) || (t.description?.toLowerCase().includes(q) ?? false)
    })
  }, [tasks, search, agentFilter])

  const byStatus = useMemo(() => {
    const m: Record<KanbanTask['status'], KanbanTask[]> = {
      pending: [], in_progress: [], needs_review: [], done: [], failed: []
    }
    for (const t of filtered) m[t.status].push(t)
    return m
  }, [filtered])

  const doneCount = byStatus.done.length
  const filterActive = !!search.trim() || agentFilter !== 'all'

  const handleCreate = async () => {
    if (!newTitle.trim() || !workspace) return
    await window.swarmmind.taskCreate(
      newTitle.trim(), newDesc.trim() || undefined, newAgent || undefined,
      newDeps.length ? newDeps : undefined
    )
    setNewTitle(''); setNewDesc(''); setNewAgent(''); setNewDeps([]); setCreating(false)
    onRefresh()
  }

  const toggleDep = (id: string) =>
    setNewDeps(prev => prev.includes(id) ? prev.filter(d => d !== id) : [...prev, id])

  const handleStatusChange = async (id: string, status: KanbanTask['status']) => {
    await window.swarmmind.taskUpdate(id, status)
    onRefresh()
  }

  const handleLaunch = async (task: KanbanTask) => {
    if (!workspace) return
    const agentId = (task.assigned_agent as AgentId) || 'claude'
    const context = [
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description}` : '',
      task.notes ? `Previous findings:\n${task.notes}` : ''
    ].filter(Boolean).join('\n')

    // Write task context to shared memory so MCP can serve it
    await window.swarmmind.memoryWrite('current_task', JSON.stringify({
      id: task.id, title: task.title, description: task.description, notes: task.notes
    }), 'context', agentId)

    // Move task to in_progress
    if (task.status === 'pending') {
      await window.swarmmind.taskUpdate(task.id, 'in_progress')
      onRefresh()
    }

    addPane(agentId, task.id)
  }

  const handleDrop = async (targetStatus: KanbanTask['status'], taskId: string) => {
    if (!taskId) return
    await window.swarmmind.taskUpdate(taskId, targetStatus)
    setDragging(null); setDragOver(null)
    onRefresh()
  }

  const handleAppendNote = async (id: string, note: string) => {
    await window.swarmmind.taskAppendNote(id, note)
    setNoteInput(null)
    onRefresh()
  }

  const handleDelete = async (id: string) => {
    await window.swarmmind.taskDelete(id)
    if (expandedTask === id) setExpandedTask(null)
    if (confirmDelete === id) setConfirmDelete(null)
    onRefresh()
  }

  return (
    <div style={styles.board}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.heading}>{t('kanban.heading')}</span>
        {tasks.length > 0 && (
          <span style={styles.sessionCount}>{t('kanban.progress', { done: doneCount, total: tasks.length })}</span>
        )}
        <span style={styles.sessionCount}>{t('kanban.active', { n: tasks.filter(tk => tk.status === 'in_progress').length })}</span>
        <button
          style={styles.newBtn}
          onClick={() => setCreating(v => !v)}
          disabled={!workspace}
        >
          {t('kanban.newTask')}
        </button>
      </div>

      {/* Search + agent filter */}
      {tasks.length > 0 && (
        <div style={styles.toolbar}>
          <input
            style={styles.searchInput}
            placeholder={t('kanban.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setSearch('')}
          />
          <div style={styles.filterChips}>
            <FilterChip active={agentFilter === 'all'} onClick={() => setAgentFilter('all')}>
              {t('kanban.filterAll')}
            </FilterChip>
            {presentAgents.map(a => (
              <FilterChip
                key={a.id}
                active={agentFilter === a.id}
                color={a.color}
                onClick={() => setAgentFilter(agentFilter === a.id ? 'all' : a.id)}
              >
                <AgentIcon id={a.id} size={11} />
                {a.label}
              </FilterChip>
            ))}
            {hasUnassigned && (
              <FilterChip active={agentFilter === UNASSIGNED} onClick={() => setAgentFilter(agentFilter === UNASSIGNED ? 'all' : UNASSIGNED)}>
                {t('kanban.filterUnassigned')}
              </FilterChip>
            )}
          </div>
        </div>
      )}

      {/* New task form */}
      {creating && (
        <div style={styles.newForm}>
          <input
            style={styles.input}
            placeholder={t('kanban.titlePlaceholder')}
            value={newTitle}
            autoFocus
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <input
            style={styles.input}
            placeholder={t('kanban.descPlaceholder')}
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
          />
          <select
            style={styles.select}
            value={newAgent}
            onChange={e => setNewAgent(e.target.value as AgentId | '')}
          >
            <option value="">{t('kanban.assignAgent')}</option>
            {AGENTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>

          {/* Prerequisite picker — wires task dependencies the orchestrator honors */}
          <span style={styles.prereqHeading}>{t('kanban.addPrereqs')}</span>
          <div style={styles.prereqList}>
            {tasks.length === 0 && <span style={styles.prereqEmpty}>{t('kanban.noPrereqs')}</span>}
            {tasks.map(tk => (
              <label key={tk.id} style={styles.prereqItem}>
                <input
                  type="checkbox"
                  checked={newDeps.includes(tk.id)}
                  onChange={() => toggleDep(tk.id)}
                />
                <span style={{ ...styles.colDot, background: COL_COLORS[tk.status] }} />
                <span style={styles.prereqTitle}>{tk.title}</span>
              </label>
            ))}
          </div>

          <div style={styles.formActions}>
            <button style={styles.createBtn} onClick={handleCreate} disabled={!newTitle.trim()}>{t('common.create')}</button>
            <button style={styles.cancelBtn} onClick={() => setCreating(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {/* Columns */}
      <div style={styles.columns}>
        {COLUMNS.map(col => {
          const colTasks = byStatus[col.key]
          return (
            <div
              key={col.key}
              style={{
                ...styles.column,
                ...(dragOver === col.key ? styles.columnDragOver : {})
              }}
              onDragOver={e => { e.preventDefault(); setDragOver(col.key) }}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => { e.preventDefault(); if (dragging) handleDrop(col.key, dragging) }}
            >
              <div style={styles.colHeader}>
                <span style={{ ...styles.colDot, background: COL_COLORS[col.key] }} />
                <span style={styles.colLabel}>{t(col.labelKey)}</span>
                <span style={styles.colCount}>{colTasks.length}</span>
              </div>

              <div style={styles.cards}>
                {colTasks.map(task => {
                  const agent = AGENTS.find(a => a.id === task.assigned_agent)
                  const isExpanded = expandedTask === task.id
                  const deps = parseDeps(task)
                  const blocked = isBlocked(task)
                  const unmet = deps.filter(d => byId.has(d) && !doneIds.has(d)).length
                  return (
                    <div
                      key={task.id}
                      style={{
                        ...styles.card,
                        ...(isExpanded ? styles.cardExpanded : {}),
                        ...(blocked ? styles.cardBlocked : {}),
                        opacity: dragging === task.id ? 0.4 : blocked ? 0.7 : 1
                      }}
                      draggable
                      onDragStart={(e) => {
                        setDragging(task.id)
                        // Allow dropping the task onto a terminal pane (AgentPane reads this).
                        e.dataTransfer.setData('application/task', JSON.stringify({
                          id: task.id, title: task.title, description: task.description,
                          notes: task.notes, assigned_agent: task.assigned_agent,
                        }))
                        e.dataTransfer.effectAllowed = 'copyMove'
                      }}
                      onDragEnd={() => { setDragging(null); setDragOver(null) }}
                    >
                      <div
                        style={styles.cardTop}
                        onClick={() => setExpandedTask(isExpanded ? null : task.id)}
                      >
                        <span style={styles.cardTitle}>{task.title}</span>
                        {blocked && (
                          <span style={styles.blockedChip} title={t('kanban.dependsOn')}>
                            🔒 {t('kanban.blocked', { n: unmet })}
                          </span>
                        )}
                        {agent && (
                          <span style={{ ...styles.agentChip, color: agent.color, borderColor: agent.color }}>
                            <AgentIcon id={agent.id} size={12} />
                            {agent.label}
                          </span>
                        )}
                      </div>

                      {isExpanded && (
                        <div style={styles.cardBody}>
                          {task.description && (
                            <p style={styles.cardDesc}>{task.description}</p>
                          )}

                          {/* Dependencies — what this task waits on before dispatch */}
                          {deps.length > 0 && (
                            <div style={styles.depsBox}>
                              <span style={styles.notesLabel}>{t('kanban.dependsOn')}</span>
                              {deps.map(d => {
                                const dep = byId.get(d)
                                return (
                                  <div key={d} style={styles.depRow}>
                                    <span style={{ ...styles.colDot, background: COL_COLORS[dep?.status ?? 'pending'] }} />
                                    <span style={{ ...styles.depTitle, ...(dep && dep.status === 'done' ? styles.depDone : {}) }}>
                                      {dep?.title ?? d}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Task Knowledge */}
                          {task.notes && (
                            <div style={styles.notesBox}>
                              <span style={styles.notesLabel}>{t('kanban.taskKnowledge')}</span>
                              <pre style={styles.notesText}>{task.notes}</pre>
                            </div>
                          )}

                          {noteInput?.id === task.id ? (
                            <div style={styles.noteInputRow}>
                              <textarea
                                style={styles.noteTextarea}
                                placeholder={t('kanban.appendPlaceholder')}
                                value={noteInput.text}
                                onChange={e => setNoteInput({ id: task.id, text: e.target.value })}
                                rows={3}
                              />
                              <div style={styles.noteActions}>
                                <button style={styles.noteSaveBtn} onClick={() => handleAppendNote(task.id, noteInput.text)}>
                                  {t('kanban.append')}
                                </button>
                                <button style={styles.cancelBtn} onClick={() => setNoteInput(null)}>{t('common.cancel')}</button>
                              </div>
                            </div>
                          ) : (
                            <button style={styles.addNoteBtn} onClick={() => setNoteInput({ id: task.id, text: '' })}>
                              {t('kanban.appendFinding')}
                            </button>
                          )}

                          <div style={styles.cardActions}>
                            <button
                              style={{ ...styles.launchBtn, ...(col.key === 'done' ? styles.launchBtnDim : {}) }}
                              onClick={() => handleLaunch(task)}
                              disabled={!workspace}
                              title={t('kanban.launchTitle', { agent: agent?.label ?? t('kanban.agentFallback') })}
                            >
                              {t('kanban.launch')}
                            </button>

                            {col.key !== 'done' && (
                              <button style={styles.doneBtn} onClick={() => handleStatusChange(task.id, 'done')}>
                                {t('common.done')}
                              </button>
                            )}
                            {col.key === 'pending' && (
                              <button style={styles.startBtn} onClick={() => handleStatusChange(task.id, 'in_progress')}>
                                {t('common.start')}
                              </button>
                            )}

                            {confirmDelete === task.id ? (
                              <>
                                <button style={styles.deleteConfirmBtn} onClick={() => handleDelete(task.id)}>
                                  {t('kanban.confirmDelete')}
                                </button>
                                <button style={styles.startBtn} onClick={() => setConfirmDelete(null)}>
                                  {t('common.cancel')}
                                </button>
                              </>
                            ) : (
                              <button
                                style={styles.deleteBtn}
                                onClick={() => setConfirmDelete(task.id)}
                                title={t('common.delete')}
                              >
                                🗑
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}

                {colTasks.length === 0 && (
                  <div style={styles.emptyCol}>
                    {filterActive ? t('kanban.noMatches') : t('kanban.dropHere')}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FilterChip({ active, color, onClick, children }: {
  active: boolean; color?: string; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      style={{
        ...styles.filterChip,
        ...(active ? styles.filterChipActive : {}),
        ...(active && color ? { borderColor: color, color } : {})
      }}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const COL_COLORS: Record<string, string> = {
  pending: 'var(--text-dim)',
  in_progress: 'var(--accent)',
  needs_review: 'var(--warning)',
  done: 'var(--success)',
  failed: 'var(--error)'
}

const styles: Record<string, React.CSSProperties> = {
  board: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    background: 'var(--bg-panel)',
    borderRight: '1px solid var(--border)'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px 8px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 14px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    flexWrap: 'wrap'
  },
  searchInput: {
    flex: 1,
    minWidth: 180,
    background: 'var(--bg-base)',
    border: '1px solid var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '8px 12px',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit'
  },
  filterChips: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap'
  },
  filterChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 10,
    color: 'var(--text-dim)',
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 600,
    whiteSpace: 'nowrap'
  },
  filterChipActive: {
    background: 'var(--bg-active)',
    borderColor: 'var(--border-mid)',
    color: 'var(--text-primary)'
  },
  heading: {
    fontWeight: 700,
    fontSize: 12,
    color: 'var(--accent)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    flex: 1
  },
  sessionCount: {
    fontSize: 10,
    color: 'var(--text-dim)',
    background: 'var(--bg-active)',
    padding: '2px 7px',
    borderRadius: 10
  },
  newBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--accent-fg)',
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap'
  },
  newForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '12px 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-card)',
    flexShrink: 0
  },
  input: {
    background: 'var(--bg-base)',
    border: '1px solid var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '9px 12px',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit'
  },
  select: {
    background: 'var(--bg-base)',
    border: '1px solid var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '9px 12px',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit'
  },
  prereqHeading: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-dim)',
    marginTop: 2
  },
  prereqList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxHeight: 120,
    overflowY: 'auto',
    background: 'var(--bg-base)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '4px 6px'
  },
  prereqEmpty: {
    fontSize: 10,
    color: 'var(--text-dim)',
    padding: '2px 0'
  },
  prereqItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '2px 0'
  },
  prereqTitle: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  formActions: { display: 'flex', gap: 6 },
  createBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--accent-fg)',
    padding: '7px 14px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600
  },
  cancelBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-dim)',
    padding: '7px 12px',
    cursor: 'pointer',
    fontSize: 12
  },
  columns: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    gap: 0
  },
  column: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid var(--border)',
    overflow: 'hidden',
    transition: 'background 0.1s'
  },
  columnDragOver: {
    background: 'var(--accent-subtle)'
  },
  colHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 10px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0
  },
  colDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0
  },
  colLabel: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
    flex: 1
  },
  colCount: {
    fontSize: 10,
    color: 'var(--text-dim)',
    background: 'var(--bg-active)',
    width: 18,
    height: 18,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  cards: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  },
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    cursor: 'grab',
    transition: 'border-color 0.1s',
    overflow: 'hidden'
  },
  cardExpanded: {
    borderColor: 'var(--border-mid)'
  },
  cardBlocked: {
    borderColor: 'var(--warning)',
    borderStyle: 'dashed'
  },
  blockedChip: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--warning)',
    background: 'var(--bg-base)',
    border: '1px solid var(--warning)',
    borderRadius: 10,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
    letterSpacing: '0.03em'
  },
  depsBox: {
    background: 'var(--bg-base)',
    borderRadius: 'var(--radius)',
    padding: '6px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 3
  },
  depRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12
  },
  depTitle: {
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  depDone: {
    color: 'var(--text-dim)',
    textDecoration: 'line-through'
  },
  cardTop: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '12px 13px',
    cursor: 'pointer'
  },
  cardTitle: {
    flex: 1,
    fontSize: 13,
    color: 'var(--text-primary)',
    lineHeight: 1.45,
    fontWeight: 500
  },
  agentChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    border: '1px solid',
    borderRadius: 10,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
    opacity: 0.85,
    letterSpacing: '0.03em'
  },
  cardBody: {
    padding: '0 13px 13px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10
  },
  cardDesc: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5
  },
  notesBox: {
    background: 'var(--bg-base)',
    borderRadius: 'var(--radius)',
    padding: '6px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4
  },
  notesLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--cyan)'
  },
  notesText: {
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 120,
    overflowY: 'auto',
    margin: 0,
    lineHeight: 1.4
  },
  noteInputRow: { display: 'flex', flexDirection: 'column', gap: 4 },
  noteTextarea: {
    background: 'var(--bg-base)',
    border: '1px solid var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '8px 10px',
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    resize: 'vertical',
    outline: 'none',
    lineHeight: 1.5
  },
  noteActions: { display: 'flex', gap: 4 },
  noteSaveBtn: {
    background: 'var(--cyan)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: '#000',
    padding: '7px 12px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700
  },
  addNoteBtn: {
    background: 'transparent',
    border: '1px dashed var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-dim)',
    padding: '7px 10px',
    cursor: 'pointer',
    fontSize: 12,
    width: '100%',
    textAlign: 'left'
  },
  cardActions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  launchBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--accent-fg)',
    padding: '7px 13px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    boxShadow: '0 0 8px var(--accent-glow)'
  },
  launchBtnDim: { background: 'var(--bg-active)', boxShadow: 'none', color: 'var(--text-dim)' },
  doneBtn: {
    background: 'var(--success-dim)',
    border: '1px solid var(--success)',
    borderRadius: 'var(--radius)',
    color: 'var(--success)',
    padding: '7px 11px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600
  },
  startBtn: {
    background: 'transparent',
    border: '1px solid var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-secondary)',
    padding: '7px 11px',
    cursor: 'pointer',
    fontSize: 12
  },
  deleteBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-dim)',
    padding: '7px 10px',
    cursor: 'pointer',
    fontSize: 12,
    marginLeft: 'auto'
  },
  deleteConfirmBtn: {
    background: 'var(--error)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: '#fff',
    padding: '7px 11px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700
  },
  emptyCol: {
    fontSize: 10,
    color: 'var(--text-dim)',
    textAlign: 'center',
    padding: '20px 8px',
    border: '1px dashed var(--border)',
    borderRadius: 'var(--radius)',
    margin: '4px 0'
  }
}
