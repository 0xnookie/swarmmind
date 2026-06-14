import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { AgentIcon } from '../data/agents'
import { useT, type TFunction } from '../i18n'

// ── Changes panel (shared world model) ────────────────────────────────────────
//
// A live picture of *what changed and who changed it*, aggregated from the
// `file_changed` / `contention` / `file_intent` swarm events. Files touched by
// more than one active agent are flagged as contended and floated to the top —
// the proactive "you're both editing auth.ts" warning that saves a merge fight.
// Event-sourced: no extra IPC, it reads the same bus the timeline does.

const FILE_TYPES = ['file_changed', 'contention', 'file_intent']

interface FileEntry {
  path: string
  agents: Set<string>   // agents who actually changed the file
  intents: Set<string>  // agents who declared intent on it
  count: number
  lastTs: number
  contended: boolean
}

function relTime(ts: number, now: number, t: TFunction): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return t('time.justNow')
  if (s < 60) return t('time.secondsAgo', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('time.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  return h < 24 ? t('time.hoursAgo', { n: h }) : t('time.daysAgo', { n: Math.floor(h / 24) })
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

export function ChangesPanel() {
  const t = useT()
  const workspace = useWorkspaceStore(s => s.workspace)
  const [events, setEvents] = useState<SwarmEvent[]>([])
  const [now, setNow] = useState(Date.now())
  const wsId = workspace?.id ?? null
  const seen = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    seen.current = new Set()
    if (!wsId) { setEvents([]); return }
    window.swarmmind.eventsList(undefined, 800, FILE_TYPES).then(list => {
      if (cancelled) return
      const arr = Array.isArray(list) ? list : []
      seen.current = new Set(arr.map(e => e.id))
      setEvents(arr)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [wsId])

  useEffect(() => {
    const unsub = window.swarmmind.onSwarmEvent((ev) => {
      if (!ev || !FILE_TYPES.includes(ev.type)) return
      if (wsId && ev.workspace_id !== wsId) return
      if (seen.current.has(ev.id)) return
      seen.current.add(ev.id)
      setEvents(prev => {
        const next = [...prev, ev]
        return next.length > 1200 ? next.slice(next.length - 1200) : next
      })
    })
    return unsub
  }, [wsId])

  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(h)
  }, [])

  const files = useMemo(() => {
    const map = new Map<string, FileEntry>()
    const ensure = (path: string): FileEntry => {
      let e = map.get(path)
      if (!e) { e = { path, agents: new Set(), intents: new Set(), count: 0, lastTs: 0, contended: false }; map.set(path, e) }
      return e
    }
    for (const ev of events) {
      const d = ev.payload ?? {}
      if (ev.type === 'file_changed') {
        const path = typeof d.path === 'string' ? d.path : null
        if (!path) continue
        const e = ensure(path)
        if (ev.agent_id) e.agents.add(ev.agent_id)
        e.count += 1
        e.lastTs = Math.max(e.lastTs, ev.ts)
      } else if (ev.type === 'contention') {
        const path = typeof d.path === 'string' ? d.path : null
        if (!path) continue
        const e = ensure(path)
        e.contended = true
        e.lastTs = Math.max(e.lastTs, ev.ts)
        if (Array.isArray(d.agents)) for (const a of d.agents) if (typeof a === 'string') e.agents.add(a)
      } else if (ev.type === 'file_intent') {
        const paths = Array.isArray(d.paths) ? d.paths : []
        for (const raw of paths) {
          if (typeof raw !== 'string') continue
          const path = raw.replace(/\\/g, '/')
          const e = ensure(path)
          if (ev.agent_id) e.intents.add(ev.agent_id)
          e.lastTs = Math.max(e.lastTs, ev.ts)
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.contended !== b.contended) return a.contended ? -1 : 1
      return b.lastTs - a.lastTs
    })
  }, [events])

  const contendedCount = files.filter(f => f.contended).length

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>{t('changes.title')}</span>
        <span style={styles.count}>{t(files.length === 1 ? 'changes.fileOne' : 'changes.fileMany', { n: files.length })}</span>
        {contendedCount > 0 && (
          <span style={styles.contendBadge}>{t('changes.contended', { n: contendedCount })}</span>
        )}
      </div>

      <div style={styles.list}>
        {files.length === 0 ? (
          <div style={styles.empty}>
            {t('changes.empty')}
          </div>
        ) : (
          files.map(f => (
            <div key={f.path} style={{ ...styles.row, ...(f.contended ? styles.rowContended : null) }}>
              <div style={styles.fileMain}>
                <span style={styles.fileName} title={f.path}>{baseName(f.path)}</span>
                <span style={styles.filePath} title={f.path}>{f.path}</span>
              </div>
              <div style={styles.rowRight}>
                {f.contended && <span style={styles.contendTag}>{t('changes.contendedTag')}</span>}
                <div style={styles.dots}>
                  {Array.from(f.agents).map(a => (
                    <AgentIcon key={a} id={a} size={13} title={t('changes.changedThis', { agent: a })} />
                  ))}
                  {Array.from(f.intents).filter(a => !f.agents.has(a)).map(a => (
                    <span key={`i-${a}`} style={{ display: 'inline-flex', opacity: 0.4 }}>
                      <AgentIcon id={a} size={13} title={t('changes.declaredIntent', { agent: a })} />
                    </span>
                  ))}
                </div>
                {f.count > 0 && <span style={styles.changeCount}>{f.count}×</span>}
                <span style={styles.time}>{relTime(f.lastTs, now, t)}</span>
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
  contendBadge: {
    fontSize: 11, fontWeight: 600, color: 'var(--accent-fg)', background: 'var(--danger, #e5484d)',
    padding: '2px 8px', borderRadius: 999,
  },
  list: { flex: 1, overflowY: 'auto', padding: '4px 0' },
  empty: { maxWidth: 480, margin: '48px auto', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6, padding: '0 24px' },
  row: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '8px 18px',
    borderBottom: '1px solid var(--border-subtle)',
  },
  rowContended: { background: 'color-mix(in srgb, var(--danger, #e5484d) 10%, transparent)' },
  fileMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  fileName: { fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  filePath: { fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowRight: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  contendTag: { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--danger, #e5484d)', fontWeight: 700 },
  dots: { display: 'flex', alignItems: 'center', gap: 3 },
  changeCount: { fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' },
  time: { fontSize: 11, color: 'var(--text-dim)', minWidth: 56, textAlign: 'right' },
}
