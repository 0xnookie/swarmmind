import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { useMemory, type MemoryEntry, type Task } from '../hooks/useMemory'

type NodeKind = 'agent' | 'entry' | 'task'
interface GNode {
  id: string
  kind: NodeKind
  label: string
  color: string
  r: number
  x: number
  y: number
  vx: number
  vy: number
  data?: MemoryEntry | Task
}
interface GLink { source: string; target: string }

const AGENT_COLOR = '#e8956b'
const TYPE_COLOR: Record<string, string> = {
  context: '#60a5fa',
  history: '#a78bfa',
  preference: '#34d399',
}
const STATUS_COLOR: Record<string, string> = {
  pending: '#9b8f82',
  in_progress: '#e8956b',
  needs_review: '#fbbf24',
  done: '#34d399',
  failed: '#f87171',
}

function buildGraph(entries: MemoryEntry[], tasks: Task[]): { nodes: GNode[]; links: GLink[] } {
  const nodes = new Map<string, GNode>()
  const links: GLink[] = []
  const ensureAgent = (id: string) => {
    const key = `agent:${id}`
    if (!nodes.has(key)) {
      nodes.set(key, { id: key, kind: 'agent', label: id, color: AGENT_COLOR, r: 13, x: 0, y: 0, vx: 0, vy: 0 })
    }
    return key
  }

  for (const e of entries) {
    const key = `entry:${e.id}`
    nodes.set(key, { id: key, kind: 'entry', label: e.key, color: TYPE_COLOR[e.type] ?? '#7dd3fc', r: 6, x: 0, y: 0, vx: 0, vy: 0, data: e })
    if (e.agent_id) links.push({ source: ensureAgent(e.agent_id), target: key })
  }
  for (const t of tasks) {
    const key = `task:${t.id}`
    nodes.set(key, { id: key, kind: 'task', label: t.title, color: STATUS_COLOR[t.status] ?? '#9b8f82', r: 8, x: 0, y: 0, vx: 0, vy: 0, data: t })
    if (t.assigned_agent) links.push({ source: ensureAgent(t.assigned_agent), target: key })
  }

  // Seed positions on a circle so the simulation unfolds nicely.
  const arr = [...nodes.values()]
  arr.forEach((n, i) => {
    const a = (i / Math.max(1, arr.length)) * Math.PI * 2
    n.x = Math.cos(a) * 180 + (Math.random() - 0.5) * 40
    n.y = Math.sin(a) * 180 + (Math.random() - 0.5) * 40
  })
  return { nodes: arr, links }
}

export function MemoryGraph() {
  const workspace = useWorkspaceStore(s => s.workspace)
  const { entries, tasks } = useMemory(workspace?.id ?? null)

  const svgRef = useRef<SVGSVGElement>(null)
  const nodesRef = useRef<GNode[]>([])
  const linksRef = useRef<GLink[]>([])
  const frameRef = useRef(0)
  const dragRef = useRef<{ id: string | null }>({ id: null })
  const viewRef = useRef({ k: 1, x: 0, y: 0, panning: false, px: 0, py: 0 })

  const [, force] = useState(0)
  const rerender = () => force(n => n + 1)
  const [selected, setSelected] = useState<GNode | null>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })

  // Rebuild graph when the underlying data identity changes (count or ids).
  const dataKey = useMemo(
    () => entries.map(e => e.id).join(',') + '|' + tasks.map(t => `${t.id}:${t.status}:${t.assigned_agent}`).join(','),
    [entries, tasks]
  )

  useEffect(() => {
    const { nodes, links } = buildGraph(entries, tasks)
    // Preserve positions of nodes that still exist for visual stability.
    const prev = new Map(nodesRef.current.map(n => [n.id, n]))
    for (const n of nodes) {
      const p = prev.get(n.id)
      if (p) { n.x = p.x; n.y = p.y }
    }
    nodesRef.current = nodes
    linksRef.current = links
    setSelected(s => (s && nodes.find(n => n.id === s.id)) || null)
    rerender()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey])

  // Track container size.
  useEffect(() => {
    const el = svgRef.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Force simulation loop.
  useEffect(() => {
    const tick = () => {
      const nodes = nodesRef.current
      const links = linksRef.current
      const REPULSION = 2400
      const SPRING = 0.02
      const LINK_LEN = 70
      const CENTER = 0.012
      const DAMP = 0.86

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          let dx = a.x - b.x, dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 0.01) { dx = Math.random(); dy = Math.random(); d2 = dx * dx + dy * dy }
          const f = REPULSION / d2
          const d = Math.sqrt(d2)
          const fx = (dx / d) * f, fy = (dy / d) * f
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
        }
      }
      const byId = new Map(nodes.map(n => [n.id, n]))
      for (const l of links) {
        const s = byId.get(l.source), t = byId.get(l.target)
        if (!s || !t) continue
        const dx = t.x - s.x, dy = t.y - s.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const f = (d - LINK_LEN) * SPRING
        const fx = (dx / d) * f, fy = (dy / d) * f
        s.vx += fx; s.vy += fy; t.vx -= fx; t.vy -= fy
      }
      for (const n of nodes) {
        n.vx -= n.x * CENTER
        n.vy -= n.y * CENTER
        if (dragRef.current.id === n.id) { n.vx = 0; n.vy = 0; continue }
        n.vx *= DAMP; n.vy *= DAMP
        n.x += n.vx; n.y += n.vy
      }
      rerender()
      frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  }, [])

  // ── Pointer interaction (drag nodes, pan, zoom) ──
  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - rect.left - size.w / 2 - v.x) / v.k,
      y: (clientY - rect.top - size.h / 2 - v.y) / v.k,
    }
  }

  const onPointerDownNode = (e: React.PointerEvent, n: GNode) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    dragRef.current.id = n.id
    setSelected(n)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const v = viewRef.current
    if (dragRef.current.id) {
      const p = toWorld(e.clientX, e.clientY)
      const n = nodesRef.current.find(nn => nn.id === dragRef.current.id)
      if (n) { n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0 }
    } else if (v.panning) {
      v.x += e.clientX - v.px; v.y += e.clientY - v.py
      v.px = e.clientX; v.py = e.clientY
      rerender()
    }
  }
  const onPointerUp = () => { dragRef.current.id = null; viewRef.current.panning = false }
  const onBgPointerDown = (e: React.PointerEvent) => {
    const v = viewRef.current
    v.panning = true; v.px = e.clientX; v.py = e.clientY
    setSelected(null)
  }
  const onWheel = (e: React.WheelEvent) => {
    const v = viewRef.current
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    v.k = Math.max(0.3, Math.min(3, v.k * factor))
    rerender()
  }

  const nodes = nodesRef.current
  const links = linksRef.current
  const byId = new Map(nodes.map(n => [n.id, n]))
  const v = viewRef.current
  const transform = `translate(${size.w / 2 + v.x}, ${size.h / 2 + v.y}) scale(${v.k})`

  return (
    <main style={styles.wrap}>
      <div style={styles.toolbar}>
        <span style={styles.title}>Memory Graph</span>
        <span style={styles.count}>{nodes.filter(n => n.kind === 'agent').length} agents · {entries.length} entries · {tasks.length} tasks</span>
        <div style={{ flex: 1 }} />
        <Legend />
      </div>

      <div style={styles.canvasWrap}>
        {!workspace ? (
          <div style={styles.empty}>Open a workspace to see its memory graph.</div>
        ) : nodes.length === 0 ? (
          <div style={styles.empty}>No memory entries or tasks yet. As agents write to shared memory, nodes appear here.</div>
        ) : (
          <svg
            ref={svgRef}
            width={size.w}
            height={size.h}
            style={{ display: 'block', cursor: viewRef.current.panning ? 'grabbing' : 'grab' }}
            onPointerDown={onBgPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onWheel={onWheel}
          >
            <g transform={transform}>
              {links.map((l, i) => {
                const s = byId.get(l.source), t = byId.get(l.target)
                if (!s || !t) return null
                const active = selected && (selected.id === l.source || selected.id === l.target)
                return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={active ? 'var(--accent)' : 'var(--border-strong)'} strokeWidth={active ? 1.5 : 1} />
              })}
              {nodes.map(n => {
                const isSel = selected?.id === n.id
                return (
                  <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer' }} onPointerDown={e => onPointerDownNode(e, n)}>
                    <circle r={n.r} fill={n.color} stroke={isSel ? 'var(--text-primary)' : 'rgba(0,0,0,0.35)'} strokeWidth={isSel ? 2 : 1} opacity={n.kind === 'entry' ? 0.92 : 1} />
                    {(n.kind === 'agent' || isSel || v.k > 1.4) && (
                      <text x={0} y={n.r + 11} textAnchor="middle" fontSize={n.kind === 'agent' ? 11 : 9.5} fill="var(--text-secondary)" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                        {n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        )}

        {selected && <DetailCard node={selected} onClose={() => setSelected(null)} />}
      </div>
    </main>
  )
}

function Legend() {
  const items = [
    { c: AGENT_COLOR, label: 'Agent' },
    { c: TYPE_COLOR.context, label: 'Memory' },
    { c: STATUS_COLOR.in_progress, label: 'Task' },
  ]
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {items.map(it => (
        <span key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: it.c }} />{it.label}
        </span>
      ))}
    </div>
  )
}

function DetailCard({ node, onClose }: { node: GNode; onClose: () => void }) {
  const e = node.kind === 'entry' ? (node.data as MemoryEntry) : null
  const t = node.kind === 'task' ? (node.data as Task) : null
  return (
    <div style={styles.detail}>
      <div style={styles.detailHeader}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: node.color, flexShrink: 0 }} />
        <span style={styles.detailTitle}>{node.label}</span>
        <button style={styles.detailClose} onClick={onClose}>✕</button>
      </div>
      <div style={styles.detailKind}>{node.kind}{e?.agent_id ? ` · @${e.agent_id}` : ''}{t?.assigned_agent ? ` · @${t.assigned_agent}` : ''}{e ? ` · ${e.type}` : ''}{t ? ` · ${t.status}` : ''}</div>
      {e && <pre style={styles.detailBody}>{e.value}</pre>}
      {t && <pre style={styles.detailBody}>{t.description || ''}{t.notes ? `\n\n${t.notes}` : ''}</pre>}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflow: 'hidden' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 },
  title: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' },
  count: { fontSize: 11.5, color: 'var(--text-muted)' },
  canvasWrap: { flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' },
  empty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 40, color: 'var(--text-dim)', fontSize: 13 },
  detail: { position: 'absolute', top: 14, right: 14, width: 300, maxHeight: '80%', overflowY: 'auto', background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 12 },
  detailHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  detailTitle: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detailClose: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 },
  detailKind: { fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 8px', fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
  detailBody: { fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 320, overflowY: 'auto' },
}
