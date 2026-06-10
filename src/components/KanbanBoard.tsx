import React, { useState, useEffect, useCallback } from 'react'
import { useWorkspaceStore, type AgentId } from '../store/workspace'
import { useT, type TranslationKey } from '../i18n'

export interface KanbanTask {
  id: string
  workspace_id: string
  title: string
  description: string | null
  notes: string | null
  status: 'pending' | 'in_progress' | 'needs_review' | 'done' | 'failed'
  assigned_agent: string | null
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

const AGENTS: { id: AgentId; label: string; color: string }[] = [
  { id: 'claude',   label: 'Claude Code', color: 'var(--agent-claude)' },
  { id: 'codex',    label: 'Codex',       color: 'var(--agent-codex)' },
  { id: 'cursor',   label: 'Cursor',      color: 'var(--agent-cursor)' },
  { id: 'windsurf', label: 'Windsurf',    color: 'var(--agent-windsurf)' },
  { id: 'kilo',     label: 'Kilo Code',   color: 'var(--agent-kilo)' },
  { id: 'opencode', label: 'OpenCode',    color: 'var(--agent-opencode)' },
  { id: 'cline',    label: 'Cline',       color: 'var(--agent-cline)' },
]

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
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [noteInput, setNoteInput] = useState<{ id: string; text: string } | null>(null)

  const handleCreate = async () => {
    if (!newTitle.trim() || !workspace) return
    await window.swarmmind.taskCreate(newTitle.trim(), newDesc.trim() || undefined, newAgent || undefined)
    setNewTitle(''); setNewDesc(''); setNewAgent(''); setCreating(false)
    onRefresh()
  }

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

  return (
    <div style={styles.board}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.heading}>{t('kanban.heading')}</span>
        <span style={styles.sessionCount}>{t('kanban.active', { n: tasks.filter(tk => tk.status === 'in_progress').length })}</span>
        <button
          style={styles.newBtn}
          onClick={() => setCreating(v => !v)}
          disabled={!workspace}
        >
          {t('kanban.newTask')}
        </button>
      </div>

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
          <div style={styles.formActions}>
            <button style={styles.createBtn} onClick={handleCreate} disabled={!newTitle.trim()}>{t('common.create')}</button>
            <button style={styles.cancelBtn} onClick={() => setCreating(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {/* Columns */}
      <div style={styles.columns}>
        {COLUMNS.map(col => {
          const colTasks = tasks.filter(tk => tk.status === col.key)
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
                  return (
                    <div
                      key={task.id}
                      style={{
                        ...styles.card,
                        ...(isExpanded ? styles.cardExpanded : {}),
                        opacity: dragging === task.id ? 0.4 : 1
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
                        {agent && (
                          <span style={{ ...styles.agentChip, color: agent.color, borderColor: agent.color }}>
                            {agent.label}
                          </span>
                        )}
                      </div>

                      {isExpanded && (
                        <div style={styles.cardBody}>
                          {task.description && (
                            <p style={styles.cardDesc}>{task.description}</p>
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
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}

                {colTasks.length === 0 && (
                  <div style={styles.emptyCol}>{t('kanban.dropHere')}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
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
    gap: 6,
    padding: '10px 12px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-card)',
    flexShrink: 0
  },
  input: {
    background: 'var(--bg-base)',
    border: '1px solid var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '5px 9px',
    fontSize: 11,
    outline: 'none',
    fontFamily: 'inherit'
  },
  select: {
    background: 'var(--bg-base)',
    border: '1px solid var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '5px 9px',
    fontSize: 11,
    outline: 'none',
    fontFamily: 'inherit'
  },
  formActions: { display: 'flex', gap: 6 },
  createBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--accent-fg)',
    padding: '4px 12px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600
  },
  cancelBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-dim)',
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 11
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
  cardTop: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    padding: '8px 10px',
    cursor: 'pointer'
  },
  cardTitle: {
    flex: 1,
    fontSize: 11,
    color: 'var(--text-primary)',
    lineHeight: 1.4,
    fontWeight: 500
  },
  agentChip: {
    fontSize: 9,
    fontWeight: 600,
    border: '1px solid',
    borderRadius: 10,
    padding: '1px 6px',
    whiteSpace: 'nowrap',
    opacity: 0.85,
    letterSpacing: '0.03em'
  },
  cardBody: {
    padding: '0 10px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  },
  cardDesc: {
    fontSize: 10,
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
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--cyan)'
  },
  notesText: {
    fontSize: 10,
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
    padding: '5px 8px',
    fontSize: 10,
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
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 700
  },
  addNoteBtn: {
    background: 'transparent',
    border: '1px dashed var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-dim)',
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: 10,
    width: '100%',
    textAlign: 'left'
  },
  cardActions: { display: 'flex', gap: 5, flexWrap: 'wrap' },
  launchBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--accent-fg)',
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 700,
    boxShadow: '0 0 8px var(--accent-glow)'
  },
  launchBtnDim: { background: 'var(--bg-active)', boxShadow: 'none', color: 'var(--text-dim)' },
  doneBtn: {
    background: 'var(--success-dim)',
    border: '1px solid var(--success)',
    borderRadius: 'var(--radius)',
    color: 'var(--success)',
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 600
  },
  startBtn: {
    background: 'transparent',
    border: '1px solid var(--border-mid)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-secondary)',
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: 10
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
