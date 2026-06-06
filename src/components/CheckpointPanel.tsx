import React, { useCallback, useEffect, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'

// ── Checkpoints & Rewind ──────────────────────────────────────────────────────
//
// Snapshot the whole workspace (main checkout + every SwarmMind worktree) and
// rewind to any snapshot — the fearless undo that makes autonomous orchestration
// safe to let rip. Each restore first auto-creates a "Before rewind" safety
// checkpoint, so a rewind is itself undoable.

const TRIGGER_LABEL: Record<string, string> = {
  manual: 'manual',
  orchestration: 'run start',
  'pre-restore': 'safety',
  restore: 'restore',
}

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

export function CheckpointPanel() {
  const workspace = useWorkspaceStore(s => s.workspace)
  const [list, setList] = useState<CheckpointRecord[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const wsId = workspace?.id ?? null

  const refresh = useCallback(() => {
    window.swarmmind.checkpointList().then(l => setList(Array.isArray(l) ? l : [])).catch(() => {})
  }, [])

  useEffect(() => { refresh() }, [wsId, refresh])
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(h)
  }, [])

  const create = async () => {
    setBusy('create'); setError(null)
    const res = await window.swarmmind.checkpointCreate(label.trim() || 'Checkpoint', 'manual')
    setBusy(null)
    if (res && 'error' in res) setError(res.error)
    else { setLabel(''); refresh() }
  }

  const restore = async (rec: CheckpointRecord) => {
    const ok = window.confirm(
      `Rewind the workspace to “${rec.label}” (${relTime(rec.ts, now)})?\n\n` +
      `This resets the main checkout and every SwarmMind worktree to that snapshot ` +
      `and removes files created since (ignored files like .swarmmind are kept). ` +
      `A “Before rewind” checkpoint is saved first so you can undo.`
    )
    if (!ok) return
    setBusy(rec.id); setError(null)
    const res = await window.swarmmind.checkpointRestore(rec.id)
    setBusy(null)
    if (res && 'error' in res) setError(res.error)
    else {
      refresh()
      if (res.errors?.length) setError(`Restored ${res.restored} dir(s); issues: ${res.errors.join('; ')}`)
    }
  }

  const remove = async (rec: CheckpointRecord) => {
    setBusy(rec.id)
    await window.swarmmind.checkpointDelete(rec.id).catch(() => {})
    setBusy(null)
    refresh()
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Checkpoints</span>
        <span style={styles.count}>{list.length}</span>
        <div style={{ flex: 1 }} />
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') create() }}
          placeholder="Label (optional)"
          style={styles.input}
        />
        <button onClick={create} disabled={busy === 'create'} style={styles.snapBtn}>
          {busy === 'create' ? 'Snapshot…' : '📍 Snapshot now'}
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.list}>
        {list.length === 0 ? (
          <div style={styles.empty}>
            No checkpoints yet. Take a snapshot before a risky run, or start an
            orchestration run (one is captured automatically). Rewinding restores the
            whole workspace — main checkout and every worktree — to the snapshot.
          </div>
        ) : (
          list.map(rec => (
            <div key={rec.id} style={styles.row}>
              <div style={styles.rowMain}>
                <span style={styles.rowLabel}>{rec.label}</span>
                <span style={styles.rowMeta}>
                  {TRIGGER_LABEL[rec.trigger] ?? rec.trigger} · {rec.trees.length} dir{rec.trees.length === 1 ? '' : 's'} · {relTime(rec.ts, now)}
                </span>
              </div>
              <div style={styles.rowActions}>
                <button onClick={() => restore(rec)} disabled={busy === rec.id} style={styles.restoreBtn}>
                  {busy === rec.id ? '…' : 'Rewind'}
                </button>
                <button onClick={() => remove(rec)} disabled={busy === rec.id} style={styles.delBtn} title="Delete checkpoint">✕</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' },
  title: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  count: { fontSize: 12, color: 'var(--text-muted)' },
  input: {
    fontSize: 12, padding: '4px 8px', borderRadius: 6, width: 160,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)',
  },
  snapBtn: {
    fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
    background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', whiteSpace: 'nowrap',
  },
  error: { margin: '8px 16px 0', padding: '8px 10px', borderRadius: 6, fontSize: 12, color: 'var(--danger, #e5484d)', background: 'color-mix(in srgb, var(--danger, #e5484d) 12%, transparent)' },
  list: { flex: 1, overflowY: 'auto', padding: '6px 0' },
  empty: { maxWidth: 460, margin: '48px auto', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6, padding: '0 24px' },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '9px 18px', borderBottom: '1px solid var(--border-subtle)' },
  rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  rowLabel: { fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowMeta: { fontSize: 11, color: 'var(--text-dim)' },
  rowActions: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  restoreBtn: {
    fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)',
  },
  delBtn: {
    fontSize: 12, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
    background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-strong)',
  },
}
