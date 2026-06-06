import React, { useEffect, useState } from 'react'

interface SessionPickerProps {
  rootPath: string
  onPick: (sessionId: string) => void
  onClose: () => void
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

export function SessionPicker({ rootPath, onPick, onClose }: SessionPickerProps) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)

  useEffect(() => {
    window.swarmmind.sessionList(rootPath)
      .then(list => setSessions(Array.isArray(list) ? list : []))
      .catch(() => setSessions([]))
  }, [rootPath])

  return (
    <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h3 style={styles.title}>Resume a session</h3>
          <button style={styles.close} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p style={styles.subtitle}>Claude Code conversations recorded for this folder.</p>

        <div style={styles.list}>
          {sessions === null && <div style={styles.empty}>Loading…</div>}
          {sessions && sessions.length === 0 && <div style={styles.empty}>No recorded sessions for this folder.</div>}
          {sessions && sessions.map(s => (
            <button key={s.id} style={styles.row} onClick={() => onPick(s.id)}>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={styles.preview}>{s.preview || <span style={{ color: 'var(--text-dim)' }}>(no preview)</span>}</div>
                <div style={styles.meta}>{relativeTime(s.mtime)} · {s.id.slice(0, 8)}</div>
              </div>
              <span style={styles.resume}>Resume</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 600 },
  card: { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 22px', width: 560, maxHeight: '74vh', display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' },
  close: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 },
  subtitle: { margin: '4px 0 14px', fontSize: 12.5, color: 'var(--text-muted)' },
  list: { display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' },
  empty: { padding: '24px 0', textAlign: 'center', fontSize: 13, color: 'var(--text-dim)' },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', cursor: 'pointer', textAlign: 'left' },
  preview: { fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  meta: { fontSize: 11, color: 'var(--text-dim)', marginTop: 2, fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
  resume: { flexShrink: 0, fontSize: 11, fontWeight: 600, color: 'var(--accent)', background: 'var(--accent-subtle)', border: '1px solid rgba(212,132,90,0.25)', borderRadius: 'var(--radius)', padding: '4px 12px' },
}
