import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'

// ── Swarm Timeline ────────────────────────────────────────────────────────────
//
// A live "watch the swarm" surface: one ordered feed of everything the agents
// do — memory writes, task transitions, messages, spawns/exits, questions,
// orchestrator dispatches, and cost ticks — read from the swarm event bus
// (memory/events.ts). Loads the recent log on open and appends new events live
// via window.swarmmind.onSwarmEvent.

const AGENT_IDS = ['claude', 'codex', 'cursor', 'windsurf', 'kilo', 'opencode', 'cline']

function agentColor(id: string | null): string {
  return id && AGENT_IDS.includes(id) ? `var(--agent-${id})` : 'var(--text-muted)'
}

// Short, themed label + glyph per event type. Glyphs are plain unicode so there
// are no extra assets; colour comes from the agent, not the type.
const TYPE_META: Record<string, { glyph: string; label: string }> = {
  memory_write:   { glyph: '◆', label: 'memory' },
  task_create:    { glyph: '＋', label: 'task' },
  task_update:    { glyph: '↻', label: 'task' },
  task_note:      { glyph: '✎', label: 'note' },
  message:        { glyph: '✉', label: 'message' },
  agent_spawn:    { glyph: '⏻', label: 'spawn' },
  agent_exit:     { glyph: '⏹', label: 'exit' },
  agent_question: { glyph: '?', label: 'needs you' },
  dispatch:       { glyph: '→', label: 'dispatch' },
  synthesis:      { glyph: '∑', label: 'synthesis' },
  cost:           { glyph: '$', label: 'cost' },
  file_changed:   { glyph: '✦', label: 'file' },
  contention:     { glyph: '⚠', label: 'contention' },
  file_intent:    { glyph: '⊡', label: 'intent' },
  checkpoint:     { glyph: '📍', label: 'checkpoint' },
  review:         { glyph: '⚖', label: 'review' },
}

function summarize(ev: SwarmEvent): string {
  const d = ev.payload ?? {}
  const s = (k: string, fallback = '?'): string => {
    const v = d[k]
    return v === undefined || v === null ? fallback : String(v)
  }
  switch (ev.type) {
    case 'memory_write':   return `wrote memory “${s('key')}” [${s('type', 'context')}]`
    case 'task_create':    return `created task “${s('title')}”${d.assigned_agent ? ` → @${s('assigned_agent')}` : ''}`
    case 'task_update':    return `task “${s('title')}” → ${s('status')}`
    case 'task_note':      return `noted on “${s('title')}”`
    case 'message':        return `${s('from')} → ${s('to')}: ${s('body', '').slice(0, 80)}`
    case 'agent_spawn':    return d.resume ? 'spawned (resumed session)' : 'spawned'
    case 'agent_exit':     return `exited${d.exitCode !== undefined ? ` (code ${s('exitCode')})` : ''}`
    case 'agent_question': return 'is waiting for your input'
    case 'dispatch':       return `dispatched “${s('title')}”`
    case 'synthesis':      return `synthesising ${s('results', '0')} result(s)`
    case 'cost':           return `spend $${Number(d.usd ?? 0).toFixed(4)}${d.tokens ? ` · ${Number(d.tokens).toLocaleString()} tok` : ''}`
    case 'file_changed':   return `changed ${s('path')}`
    case 'contention':     return `⚠ contention on ${s('path')}${Array.isArray(d.agents) && d.agents.length ? ` (${d.agents.join(', ')})` : ''}`
    case 'file_intent':    return `intends to edit ${Array.isArray(d.paths) ? `${d.paths.length} file(s)` : 'files'}${d.note ? ` — ${s('note')}` : ''}`
    case 'checkpoint':     return d.trigger === 'restore' ? `rewound to “${s('label')}”` : `checkpoint “${s('label')}” (${s('trigger', 'manual')})`
    case 'review':         return d.verdict === 'assigned' ? `reviewing “${s('title')}”` : `review ${s('verdict')} on “${s('title')}”`
    default:               return ev.type
  }
}

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function SwarmTimeline() {
  const workspace = useWorkspaceStore(s => s.workspace)
  const [events, setEvents] = useState<SwarmEvent[]>([]) // ascending by ts
  const [filter, setFilter] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const wsId = workspace?.id ?? null
  const seen = useRef<Set<string>>(new Set())

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
        <span style={styles.title}>Swarm Timeline</span>
        <span style={styles.count}>{shown.length} event{shown.length === 1 ? '' : 's'}</span>
        <div style={{ flex: 1 }} />
        <div style={styles.chips}>
          <Chip label="All" active={filter === null} color="var(--accent)" onClick={() => setFilter(null)} />
          {agents.map(a => (
            <Chip key={a} label={a} active={filter === a} color={agentColor(a)} onClick={() => setFilter(filter === a ? null : a)} />
          ))}
        </div>
      </div>

      <div style={styles.feed}>
        {shown.length === 0 ? (
          <div style={styles.empty}>
            No activity yet. As agents read/write memory, move tasks, message each
            other, or the orchestrator dispatches work, it streams here in real time.
          </div>
        ) : (
          shown.map(ev => {
            const meta = TYPE_META[ev.type] ?? { glyph: '•', label: ev.type }
            const color = agentColor(ev.agent_id)
            return (
              <div key={ev.id} style={styles.row}>
                <span style={{ ...styles.glyph, color }}>{meta.glyph}</span>
                <div style={styles.body}>
                  <div style={styles.line1}>
                    {ev.agent_id && <span style={{ ...styles.agent, color }}>{ev.agent_id}</span>}
                    <span style={styles.text}>{summarize(ev)}</span>
                  </div>
                  <div style={styles.meta}>
                    <span style={styles.typeTag}>{meta.label}</span>
                    <span style={styles.time}>{relTime(ev.ts, now)}</span>
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

function Chip({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.chip,
        background: active ? color : 'transparent',
        color: active ? 'var(--accent-fg)' : 'var(--text-secondary)',
        borderColor: active ? color : 'var(--border-strong)',
      }}
    >
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
