import React, { useMemo, useState } from 'react'
import {
  useWorkspaceStore,
  type PaneNode,
  type PaneLeaf,
  type SwarmLoop,
  type AgentId,
  type LoopInput,
} from '../store/workspace'
import { useT, type TFunction } from '../i18n'

// ── Loops panel ───────────────────────────────────────────────────────────────
//
// Manage SwarmMind's recurring prompt schedules ("Claude Code loops"). Each loop
// re-injects a prompt into an agent pane on an interval; the runner is
// hooks/useLoops.ts. This overlay is purely the editor + status view: it shows
// how many loops are running, each with its name and description, and lets the
// user create, edit, pause/resume and delete them. The SwarmAgent can drive the
// same loops via tools (see swarmagent/tools.ts).

type Unit = 'sec' | 'min' | 'hour'
const UNIT_SECONDS: Record<Unit, number> = { sec: 1, min: 60, hour: 3600 }

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

// Split a second-count into the largest whole unit for editing (e.g. 90 → 90s,
// 120 → 2min, 3600 → 1hour).
function splitInterval(sec: number): { value: number; unit: Unit } {
  if (sec % 3600 === 0) return { value: sec / 3600, unit: 'hour' }
  if (sec % 60 === 0) return { value: sec / 60, unit: 'min' }
  return { value: sec, unit: 'sec' }
}

function formatInterval(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return s ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem ? `${m}m ${rem}s` : `${m}m`
}

interface PaneOption {
  id: string
  label: string
  agentId: AgentId | null
}

interface FormState {
  name: string
  description: string
  prompt: string
  intervalValue: number
  intervalUnit: Unit
  paneId: string // '' = all running agents
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  prompt: '',
  intervalValue: 5,
  intervalUnit: 'min',
  paneId: '',
}

export function LoopsPanel() {
  const t = useT()
  const loops = useWorkspaceStore(s => s.loops)
  const cliLoops = useWorkspaceStore(s => s.cliLoops)
  const rootPane = useWorkspaceStore(s => s.rootPane)
  const addLoop = useWorkspaceStore(s => s.addLoop)
  const updateLoop = useWorkspaceStore(s => s.updateLoop)
  const removeLoop = useWorkspaceStore(s => s.removeLoop)
  const setLoopEnabled = useWorkspaceStore(s => s.setLoopEnabled)
  const removeCliLoop = useWorkspaceStore(s => s.removeCliLoop)

  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [pendingDelete, setPendingDelete] = useState<SwarmLoop | null>(null)
  // Re-render once a second so the next-run countdowns tick.
  const [now, setNow] = useState(Date.now())
  React.useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(h)
  }, [])

  const panes: PaneOption[] = useMemo(() => {
    return collectLeaves(rootPane)
      .filter(l => l.agentId)
      .map(l => ({
        id: l.id,
        agentId: l.agentId,
        label: l.title?.trim() || l.agentId || t('pane.noAgent'),
      }))
  }, [rootPane, t])

  const runningCount = loops.filter(l => l.enabled).length + cliLoops.length
  const paneLabel = (id: string) => panes.find(p => p.id === id)?.label ?? id.slice(0, 6)

  const startCreate = () => {
    setForm({ ...EMPTY_FORM, paneId: panes[0]?.id ?? '' })
    setEditing('new')
  }

  const startEdit = (loop: SwarmLoop) => {
    const { value, unit } = splitInterval(loop.intervalSec)
    setForm({
      name: loop.name,
      description: loop.description,
      prompt: loop.prompt,
      intervalValue: value,
      intervalUnit: unit,
      paneId: loop.paneId ?? '',
    })
    setEditing(loop.id)
  }

  const cancel = () => { setEditing(null); setForm(EMPTY_FORM) }

  const submit = () => {
    if (!form.prompt.trim()) return
    const intervalSec = Math.max(5, Math.round(form.intervalValue * UNIT_SECONDS[form.intervalUnit]) || 60)
    const pane = panes.find(p => p.id === form.paneId)
    const base: LoopInput = {
      name: form.name,
      description: form.description,
      prompt: form.prompt,
      intervalSec,
      paneId: form.paneId || null,
      agentId: pane?.agentId ?? null,
    }
    if (editing === 'new') addLoop(base)
    else if (editing) updateLoop(editing, base)
    cancel()
  }

  const confirmDelete = () => {
    if (pendingDelete) removeLoop(pendingDelete.id)
    setPendingDelete(null)
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>{t('loops.title')}</span>
        <span style={styles.runningPill}>
          <span style={{ ...styles.dot, background: runningCount ? 'var(--success, #5cc88f)' : 'var(--text-dim)' }} />
          {t('loops.running', { n: runningCount })}
        </span>
        <div style={{ flex: 1 }} />
        {editing === null && (
          <button onClick={startCreate} style={styles.newBtn}>{t('loops.new')}</button>
        )}
      </div>

      {editing !== null && (
        <LoopForm
          t={t}
          form={form}
          setForm={setForm}
          panes={panes}
          isNew={editing === 'new'}
          onSubmit={submit}
          onCancel={cancel}
        />
      )}

      <div style={styles.list}>
        {cliLoops.length > 0 && (
          <>
            <div style={styles.sectionHead}>{t('loops.cli.section')}</div>
            {cliLoops.map(c => (
              <div key={c.id} style={styles.row}>
                <div style={styles.rowMain}>
                  <div style={styles.rowTop}>
                    <span style={styles.rowName}>{c.command}</span>
                    <span style={styles.cliTag}>{t('loops.cli.tag')}</span>
                    {c.interval && <span style={styles.badge}>{t('loops.everyInterval', { interval: c.interval })}</span>}
                    {!c.interval && <span style={styles.pausedTag}>{t('loops.cli.selfPaced')}</span>}
                  </div>
                  <span style={styles.rowMeta}>{t('loops.cli.runningIn', { pane: paneLabel(c.paneId) })}</span>
                </div>
                <div style={styles.rowActions}>
                  <button onClick={() => removeCliLoop(c.id)} style={styles.iconBtn} title={t('loops.cli.dismiss')}>✕</button>
                </div>
              </div>
            ))}
            {loops.length > 0 && <div style={styles.sectionHead}>{t('loops.cli.managed')}</div>}
          </>
        )}

        {loops.length === 0 && cliLoops.length === 0 && editing === null ? (
          <div style={styles.empty}>{t('loops.empty')}</div>
        ) : (
          loops.map(loop => {
            const targetGone = loop.paneId != null && !panes.some(p => p.id === loop.paneId)
            const targetLabel = loop.paneId
              ? (panes.find(p => p.id === loop.paneId)?.label ?? t('loops.targetGone'))
              : t('loops.targetAll')
            const countdown = loop.enabled && loop.nextRunAt != null ? loop.nextRunAt - now : null
            return (
              <div key={loop.id} style={styles.row}>
                <div style={styles.rowMain}>
                  <div style={styles.rowTop}>
                    <span style={styles.rowName}>{loop.name}</span>
                    <span style={styles.badge}>{t('loops.everyInterval', { interval: formatInterval(loop.intervalSec) })}</span>
                    {!loop.enabled && <span style={styles.pausedTag}>{t('loops.paused')}</span>}
                    {targetGone && loop.enabled && <span style={styles.warnTag}>{t('loops.targetGone')}</span>}
                  </div>
                  {loop.description && <span style={styles.rowDesc}>{loop.description}</span>}
                  <span style={styles.rowMeta}>
                    → {targetLabel} · {t('loops.runs', { n: loop.runCount })}
                    {countdown != null && ` · ${t('loops.nextRun', { time: formatCountdown(countdown) })}`}
                  </span>
                </div>
                <div style={styles.rowActions}>
                  <button
                    onClick={() => setLoopEnabled(loop.id, !loop.enabled)}
                    style={loop.enabled ? styles.pauseBtn : styles.resumeBtn}
                  >
                    {loop.enabled ? t('loops.pause') : t('loops.resume')}
                  </button>
                  <button onClick={() => startEdit(loop)} style={styles.iconBtn} title={t('loops.edit')}>✎</button>
                  <button onClick={() => setPendingDelete(loop)} style={styles.iconBtn} title={t('loops.delete')}>✕</button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {pendingDelete && (
        <DeleteLoopDialog
          t={t}
          loop={pendingDelete}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}

function DeleteLoopDialog({
  t, loop, onConfirm, onCancel,
}: {
  t: TFunction
  loop: SwarmLoop
  onConfirm: () => void
  onCancel: () => void
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onConfirm, onCancel])

  return (
    <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={styles.dialog} role="dialog" aria-modal="true">
        <h2 style={styles.dialogTitle}>{t('loops.confirmDelete', { name: loop.name })}</h2>
        <p style={styles.dialogBody}>{t('loops.confirmDeleteBody')}</p>
        <div style={styles.dialogActions}>
          <button onClick={onCancel} style={styles.cancelBtn} autoFocus>{t('loops.cancel')}</button>
          <button onClick={onConfirm} style={styles.dangerBtn}>{t('loops.delete')}</button>
        </div>
      </div>
    </div>
  )
}

function LoopForm({
  t, form, setForm, panes, isNew, onSubmit, onCancel,
}: {
  t: TFunction
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  panes: PaneOption[]
  isNew: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <div style={styles.form}>
      <div style={styles.formRow}>
        <input
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder={t('loops.namePlaceholder')}
          style={{ ...styles.input, flex: 1 }}
        />
      </div>
      <input
        value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        placeholder={t('loops.descPlaceholder')}
        style={styles.input}
      />
      <textarea
        value={form.prompt}
        onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
        placeholder={t('loops.promptPlaceholder')}
        rows={2}
        style={styles.textarea}
      />
      <div style={styles.formRow}>
        <label style={styles.fieldLabel}>{t('loops.interval')}</label>
        <input
          type="number"
          min={1}
          value={form.intervalValue}
          onChange={e => setForm(f => ({ ...f, intervalValue: Number(e.target.value) }))}
          style={{ ...styles.input, width: 72 }}
        />
        <select
          value={form.intervalUnit}
          onChange={e => setForm(f => ({ ...f, intervalUnit: e.target.value as Unit }))}
          style={styles.select}
        >
          <option value="sec">{t('loops.unit.sec')}</option>
          <option value="min">{t('loops.unit.min')}</option>
          <option value="hour">{t('loops.unit.hour')}</option>
        </select>
        <label style={{ ...styles.fieldLabel, marginLeft: 8 }}>{t('loops.target')}</label>
        <select
          value={form.paneId}
          onChange={e => setForm(f => ({ ...f, paneId: e.target.value }))}
          style={{ ...styles.select, flex: 1, minWidth: 0 }}
        >
          <option value="">{t('loops.targetAll')}</option>
          {panes.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      <div style={styles.formActions}>
        <button onClick={onCancel} style={styles.cancelBtn}>{t('loops.cancel')}</button>
        <button onClick={onSubmit} disabled={!form.prompt.trim()} style={styles.submitBtn}>
          {isNew ? t('loops.create') : t('loops.save')}
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' },
  title: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  runningPill: {
    display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600,
    color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
    borderRadius: 999, padding: '2px 9px',
  },
  dot: { width: 6, height: 6, borderRadius: '50%' },
  newBtn: {
    fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
    background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', whiteSpace: 'nowrap',
  },
  form: {
    display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px',
    borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-panel)',
  },
  formRow: { display: 'flex', alignItems: 'center', gap: 8 },
  fieldLabel: { fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 },
  input: {
    fontSize: 12.5, padding: '6px 9px', borderRadius: 6,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)',
  },
  textarea: {
    fontSize: 12.5, padding: '6px 9px', borderRadius: 6, resize: 'vertical', minHeight: 38,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)',
    fontFamily: 'inherit', lineHeight: 1.5,
  },
  select: {
    fontSize: 12.5, padding: '6px 8px', borderRadius: 6,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)',
  },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
  cancelBtn: {
    fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
    background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-strong)',
  },
  submitBtn: {
    fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
    background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
  },
  list: { flex: 1, overflowY: 'auto', padding: '4px 0' },
  sectionHead: {
    fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
    color: 'var(--text-muted)', padding: '12px 18px 4px',
  },
  cliTag: {
    fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, color: 'var(--bg-base)', background: 'var(--text-muted)',
    padding: '1px 7px', borderRadius: 999,
  },
  empty: { maxWidth: 460, margin: '48px auto', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6, padding: '0 24px' },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderBottom: '1px solid var(--border-subtle)' },
  rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  rowTop: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  badge: {
    fontSize: 10.5, fontWeight: 600, color: 'var(--accent)', padding: '1px 7px', borderRadius: 999,
    background: 'color-mix(in srgb, var(--accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
  },
  pausedTag: { fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', padding: '1px 7px', borderRadius: 999, border: '1px solid var(--border-strong)' },
  warnTag: {
    fontSize: 10.5, fontWeight: 600, color: 'var(--danger, #e5484d)', padding: '1px 7px', borderRadius: 999,
    background: 'color-mix(in srgb, var(--danger, #e5484d) 12%, transparent)',
  },
  rowDesc: { fontSize: 12, color: 'var(--text-secondary)' },
  rowMeta: { fontSize: 11, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' },
  rowActions: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  pauseBtn: {
    fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)',
  },
  resumeBtn: {
    fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
    background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
  },
  iconBtn: {
    fontSize: 12, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
    background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-strong)',
  },
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500,
  },
  dialog: {
    background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 12,
    padding: '24px 24px 20px', width: 380, maxWidth: '90vw',
    display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
  },
  dialogTitle: { margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' },
  dialogBody: { margin: '10px 0 0', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 },
  dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 },
  dangerBtn: {
    fontSize: 12, fontWeight: 600, padding: '6px 16px', borderRadius: 6, cursor: 'pointer',
    background: 'var(--danger, #e5484d)', color: '#fff', border: 'none',
  },
}
