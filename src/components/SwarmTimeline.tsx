import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore, AGENT_IDS } from '../store/workspace'
import { AgentIcon } from '../data/agents'
import { useT, type TFunction, type TranslationKey } from '../i18n'
import { renderSessionHtml, renderSessionMarkdown, exportFileBase } from '../lib/sessionExport'

// ── Swarm Timeline ────────────────────────────────────────────────────────────
//
// A live "watch the swarm" surface: one ordered feed of everything the agents
// do — memory writes, task transitions, messages, spawns/exits, questions,
// orchestrator dispatches, and cost ticks — read from the swarm event bus
// (memory/events.ts). Loads the recent log on open and appends new events live
// via window.swarmmind.onSwarmEvent.

function agentColor(id: string | null): string {
  return id && (AGENT_IDS as readonly string[]).includes(id) ? `var(--agent-${id})` : 'var(--text-muted)'
}

// Short, themed label-key + glyph per event type. Glyphs are plain unicode so
// there are no extra assets; colour comes from the agent, not the type.
const TYPE_META: Record<string, { glyph: string; labelKey: TranslationKey }> = {
  memory_write:   { glyph: '◆', labelKey: 'timeline.type.memory' },
  task_create:    { glyph: '＋', labelKey: 'timeline.type.task' },
  task_update:    { glyph: '↻', labelKey: 'timeline.type.task' },
  task_note:      { glyph: '✎', labelKey: 'timeline.type.note' },
  message:        { glyph: '✉', labelKey: 'timeline.type.message' },
  agent_spawn:    { glyph: '⏻', labelKey: 'timeline.type.spawn' },
  agent_exit:     { glyph: '⏹', labelKey: 'timeline.type.exit' },
  agent_question: { glyph: '?', labelKey: 'timeline.type.needsYou' },
  dispatch:       { glyph: '→', labelKey: 'timeline.type.dispatch' },
  synthesis:      { glyph: '∑', labelKey: 'timeline.type.synthesis' },
  cost:           { glyph: '$', labelKey: 'timeline.type.cost' },
  file_changed:   { glyph: '✦', labelKey: 'timeline.type.file' },
  contention:     { glyph: '⚠', labelKey: 'timeline.type.contention' },
  file_intent:    { glyph: '⊡', labelKey: 'timeline.type.intent' },
  checkpoint:     { glyph: '📍', labelKey: 'timeline.type.checkpoint' },
  review:         { glyph: '⚖', labelKey: 'timeline.type.review' },
}

function summarize(ev: SwarmEvent, t: TFunction): string {
  const d = ev.payload ?? {}
  const s = (k: string, fallback = '?'): string => {
    const v = d[k]
    return v === undefined || v === null ? fallback : String(v)
  }
  switch (ev.type) {
    case 'memory_write':   return t('timeline.sum.memoryWrite', { key: s('key'), type: s('type', 'context') })
    case 'task_create':    return t('timeline.sum.taskCreate', { title: s('title') }) + (d.assigned_agent ? ` → @${s('assigned_agent')}` : '')
    case 'task_update':    return t('timeline.sum.taskUpdate', { title: s('title'), status: s('status') })
    case 'task_note':      return t('timeline.sum.taskNote', { title: s('title') })
    case 'message':        return t('timeline.sum.message', { from: s('from'), to: s('to'), body: s('body', '').slice(0, 80) })
    case 'agent_spawn':    return d.resume ? t('timeline.sum.spawnResumed') : t('timeline.sum.spawned')
    case 'agent_exit':     return d.exitCode !== undefined ? t('timeline.sum.exitedCode', { code: s('exitCode') }) : t('timeline.sum.exited')
    case 'agent_question': return t('timeline.sum.question')
    case 'dispatch':       return t('timeline.sum.dispatch', { title: s('title') })
    case 'synthesis':      return t('timeline.sum.synthesis', { n: s('results', '0') })
    case 'cost':           return d.tokens
      ? t('timeline.sum.costTokens', { usd: Number(d.usd ?? 0).toFixed(4), tokens: Number(d.tokens).toLocaleString() })
      : t('timeline.sum.cost', { usd: Number(d.usd ?? 0).toFixed(4) })
    case 'file_changed':   return t('timeline.sum.fileChanged', { path: s('path') })
    case 'contention':     return Array.isArray(d.agents) && d.agents.length
      ? t('timeline.sum.contentionAgents', { path: s('path'), agents: d.agents.join(', ') })
      : t('timeline.sum.contention', { path: s('path') })
    case 'file_intent':    return (Array.isArray(d.paths) ? t('timeline.sum.intentN', { n: d.paths.length }) : t('timeline.sum.intentFiles'))
      + (d.note ? t('timeline.sum.intentNote', { note: s('note') }) : '')
    case 'checkpoint':     return d.trigger === 'restore' ? t('timeline.sum.rewound', { label: s('label') }) : t('timeline.sum.checkpoint', { label: s('label'), trigger: s('trigger', 'manual') })
    case 'review':         return d.verdict === 'assigned' ? t('timeline.sum.reviewing', { title: s('title') }) : t('timeline.sum.review', { verdict: s('verdict'), title: s('title') })
    default:               return ev.type
  }
}

function relTime(ts: number, now: number, t: TFunction): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return t('time.justNow')
  if (s < 60) return t('time.secondsAgo', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('time.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgo', { n: h })
  return t('time.daysAgo', { n: Math.floor(h / 24) })
}

export function SwarmTimeline() {
  const t = useT()
  const workspace = useWorkspaceStore(s => s.workspace)
  const [events, setEvents] = useState<SwarmEvent[]>([]) // ascending by ts
  const [filter, setFilter] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [exportState, setExportState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const wsId = workspace?.id ?? null
  const seen = useRef<Set<string>>(new Set())

  // Session export: pull the full retained log (not just the 400 shown), render
  // both artifacts with the pure lib, and let the save dialog's chosen extension
  // pick the format (main writes whichever matches).
  const exportSession = async () => {
    if (exportState === 'busy' || !workspace) return
    setExportState('busy')
    try {
      const all = await window.swarmmind.eventsList(undefined, 2000)
      const list = Array.isArray(all) ? all : []
      const meta = { workspaceName: workspace.name, exportedAt: Date.now() }
      const res = await window.swarmmind.exportSaveSession(
        exportFileBase(meta.workspaceName, meta.exportedAt),
        renderSessionHtml(list, meta),
        renderSessionMarkdown(list, meta)
      )
      setExportState(res?.ok ? 'done' : res?.canceled ? 'idle' : 'failed')
    } catch {
      setExportState('failed')
    }
    setTimeout(() => setExportState(s => (s === 'busy' ? s : 'idle')), 2500)
  }

  // Load the recent log whenever the workspace changes.
  useEffect(() => {
    let cancelled = false
    seen.current = new Set()
    if (!wsId) { setEvents([]); return }
    window.swarmmind.eventsList(undefined, 400).then(list => {
      if (cancelled) return
      const arr = Array.isArray(list) ? list : []
      seen.current = new Set(arr.map(e => e.id))
      setEvents(arr)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [wsId])

  // Append new events live. Dedupe by id (the initial load and the live stream
  // can overlap), and ignore events from a different workspace.
  useEffect(() => {
    const unsub = window.swarmmind.onSwarmEvent((ev) => {
      if (!ev || (wsId && ev.workspace_id !== wsId)) return
      if (seen.current.has(ev.id)) return
      seen.current.add(ev.id)
      setEvents(prev => {
        const next = [...prev, ev]
        return next.length > 600 ? next.slice(next.length - 600) : next
      })
    })
    return unsub
  }, [wsId])

  // Tick the clock so relative timestamps stay fresh.
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(h)
  }, [])

  const agents = useMemo(() => {
    const set = new Set<string>()
    for (const e of events) if (e.agent_id) set.add(e.agent_id)
    return Array.from(set).sort()
  }, [events])

  const shown = useMemo(() => {
    const list = filter ? events.filter(e => e.agent_id === filter) : events
    return [...list].reverse() // newest first for display
  }, [events, filter])

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>{t('timeline.title')}</span>
        <span style={styles.count}>{t(shown.length === 1 ? 'timeline.eventOne' : 'timeline.eventMany', { n: shown.length })}</span>
        <div style={{ flex: 1 }} />
        <div style={styles.chips}>
          <Chip label={t('timeline.all')} active={filter === null} color="var(--accent)" onClick={() => setFilter(null)} />
          {agents.map(a => (
            <Chip key={a} label={a} iconId={a} active={filter === a} color={agentColor(a)} onClick={() => setFilter(filter === a ? null : a)} />
          ))}
        </div>
        <button
          onClick={exportSession}
          disabled={exportState === 'busy' || events.length === 0}
          title={t('timeline.exportTip')}
          style={{
            ...styles.exportBtn,
            color: exportState === 'failed' ? 'var(--error)' : exportState === 'done' ? 'var(--success)' : 'var(--text-secondary)',
            opacity: events.length === 0 ? 0.5 : 1,
          }}
        >
          {exportState === 'busy' ? t('timeline.exporting')
            : exportState === 'done' ? t('timeline.exported')
            : exportState === 'failed' ? t('timeline.exportFailed')
            : `⬇ ${t('timeline.export')}`}
        </button>
      </div>

      <div style={styles.feed}>
        {shown.length === 0 ? (
          <div style={styles.empty}>
            {t('timeline.empty')}
          </div>
        ) : (
          shown.map(ev => {
            const meta = TYPE_META[ev.type]
            const glyph = meta?.glyph ?? '•'
            const typeLabel = meta ? t(meta.labelKey) : ev.type
            const color = agentColor(ev.agent_id)
            return (
              <div key={ev.id} style={styles.row}>
                <span style={{ ...styles.glyph, color }}>{glyph}</span>
                <div style={styles.body}>
                  <div style={styles.line1}>
                    {ev.agent_id && (
                      <span style={{ ...styles.agent, color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <AgentIcon id={ev.agent_id} size={12} />
                        {ev.agent_id}
                      </span>
                    )}
                    <span style={styles.text}>{summarize(ev, t)}</span>
                  </div>
                  <div style={styles.meta}>
                    <span style={styles.typeTag}>{typeLabel}</span>
                    <span style={styles.time}>{relTime(ev.ts, now, t)}</span>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function Chip({ label, active, color, iconId, onClick }: { label: string; active: boolean; color: string; iconId?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.chip,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: active ? color : 'transparent',
        color: active ? 'var(--accent-fg)' : 'var(--text-secondary)',
        borderColor: active ? color : 'var(--border-strong)',
      }}
    >
      {iconId && <AgentIcon id={iconId} size={12} />}
      {label}
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-base)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-subtle)',
    flexWrap: 'wrap',
  },
  title: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  count: { fontSize: 12, color: 'var(--text-muted)' },
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: {
    fontSize: 11,
    padding: '3px 9px',
    borderRadius: 999,
    border: '1px solid',
    cursor: 'pointer',
    textTransform: 'capitalize',
    transition: 'background 120ms, color 120ms',
  },
  exportBtn: {
    fontSize: 11,
    padding: '3px 10px',
    borderRadius: 999,
    border: '1px solid var(--border-strong)',
    background: 'transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'color 120ms, border-color 120ms',
  },
  feed: { flex: 1, overflowY: 'auto', padding: '6px 0' },
  empty: {
    maxWidth: 460,
    margin: '48px auto',
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 13,
    lineHeight: 1.6,
    padding: '0 24px',
  },
  row: {
    display: 'flex',
    gap: 12,
    padding: '8px 18px',
    alignItems: 'flex-start',
  },
  glyph: {
    width: 20,
    flexShrink: 0,
    textAlign: 'center',
    fontSize: 14,
    lineHeight: '20px',
    fontWeight: 700,
  },
  body: { flex: 1, minWidth: 0 },
  line1: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' },
  agent: { fontSize: 12, fontWeight: 600, textTransform: 'capitalize', flexShrink: 0 },
  text: { fontSize: 13, color: 'var(--text-secondary)', wordBreak: 'break-word' },
  meta: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 },
  typeTag: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--text-dim)',
    background: 'var(--bg-elevated)',
    padding: '1px 6px',
    borderRadius: 4,
  },
  time: { fontSize: 11, color: 'var(--text-dim)' },
}
