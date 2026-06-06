import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RemoteWorkspace {
  id: string
  name: string
  root_path: string
  created_at: number
  updated_at: number
}

export interface WorkspaceSidebarProps {
  onOpenWorkspace: () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKSPACE_COLOR_PALETTE = [
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#a855f7', // purple
  '#ef4444', // red
  '#f97316', // orange
  '#14b8a6', // teal
  '#ec4899', // pink
]

function defaultColorFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return WORKSPACE_COLOR_PALETTE[Math.abs(hash) % WORKSPACE_COLOR_PALETTE.length]
}

function WorkspaceDot({ color }: { color: string }) {
  return (
    <span style={{ width: 8, height: 8, borderRadius: 9999, background: color, flexShrink: 0, display: 'inline-block' }} />
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ColorPicker({ onSelect }: { onSelect: (color: string) => void }) {
  return (
    <div
      style={{
        position: 'absolute', left: 20, top: '50%', transform: 'translateY(-50%)',
        zIndex: 200, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 8, display: 'flex', flexWrap: 'wrap' as const,
        gap: 4, width: 108, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      }}
      onClick={e => e.stopPropagation()}
    >
      {WORKSPACE_COLOR_PALETTE.map(c => (
        <button
          key={c}
          onClick={() => onSelect(c)}
          style={{ width: 18, height: 18, borderRadius: 9999, background: c, border: 'none', cursor: 'pointer', padding: 0 }}
        />
      ))}
    </div>
  )
}

function IconTrash() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6M14 11v6"/>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
    </svg>
  )
}

function IconPencil() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
    </svg>
  )
}

interface WorkspaceRowProps {
  ws: RemoteWorkspace
  active: boolean
  dotColor: string
  dragging: boolean
  sessionCount: number
  onClick: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDragEnd: () => void
  onColorSelect: (color: string) => void
  onDelete: () => void
  onRename: (name: string) => void
}

function WorkspaceRow({ ws, active, dotColor, dragging, sessionCount, onClick, onDragStart, onDragOver, onDragEnd, onColorSelect, onDelete, onRename }: WorkspaceRowProps) {
  const [hovered, setHovered] = useState(false)
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(ws.name)

  const beginEdit = () => { setEditValue(ws.name); setEditing(true) }
  const commitEdit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== ws.name) onRename(trimmed)
    setEditing(false)
  }

  // Close color picker when clicking outside
  useEffect(() => {
    if (!colorPickerOpen) return
    const handler = () => setColorPickerOpen(false)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [colorPickerOpen])

  return (
    <div
      draggable={!editing}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        height: 36,
        padding: '0 12px',
        marginBottom: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        cursor: 'grab',
        background: active || hovered ? 'var(--bg-elevated)' : 'transparent',
        opacity: dragging ? 0.45 : 1,
        transition: 'background 150ms ease-out, opacity 150ms ease-out',
      }}
    >
      {active && (
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: 'var(--accent)', borderRadius: '0 2px 2px 0' }} />
      )}

      {/* Color dot — click to open palette */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <WorkspaceDot color={dotColor} />
        <button
          onClick={e => { e.stopPropagation(); setColorPickerOpen(v => !v) }}
          style={{ position: 'absolute', inset: -5, background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 9999 }}
        />
        {colorPickerOpen && <ColorPicker onSelect={c => { onColorSelect(c); setColorPickerOpen(false) }} />}
      </div>

      {editing ? (
        <input
          autoFocus
          value={editValue}
          onClick={e => e.stopPropagation()}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter') commitEdit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          style={{
            flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500,
            color: 'var(--text-primary)', background: 'var(--bg-base)',
            border: '1px solid var(--accent)', borderRadius: 4, padding: '2px 6px', outline: 'none',
          }}
        />
      ) : (
        <span
          onDoubleClick={e => { e.stopPropagation(); beginEdit() }}
          title="Double-click to rename"
          style={{
            fontSize: 14, fontWeight: 500,
            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            flex: 1, minWidth: 0,
          }}
        >
          {ws.name}
        </span>
      )}

      {/* Running-agent count, tinted with this workspace's own colour. Only the
          active workspace has live agents (others are killed on switch), so in
          practice this shows on the active row — in its colour, not a fixed green. */}
      {!editing && sessionCount > 0 && (
        <span style={{
          fontSize: 10, fontWeight: 600,
          background: `${dotColor}26`, color: dotColor,
          borderRadius: 9999, padding: '1px 5px', flexShrink: 0,
        }}>
          {sessionCount}
        </span>
      )}

      {hovered && !editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <button
            onClick={e => { e.stopPropagation(); beginEdit() }}
            title="Rename workspace"
            style={{
              width: 20, height: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-dim)', borderRadius: 4, padding: 0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)' }}
          >
            <IconPencil />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            title="Remove workspace"
            style={{
              width: 20, height: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-dim)', borderRadius: 4, padding: 0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--error)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)' }}
          >
            <IconTrash />
          </button>
        </div>
      )}
    </div>
  )
}

// ── SVG icons ─────────────────────────────────────────────────────────────────

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  )
}

function IconChevronDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  )
}

// ── Icon button helper ────────────────────────────────────────────────────────

function IconBtn({
  label,
  children,
  onClick,
}: {
  label: string
  children: React.ReactNode
  onClick?: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      aria-label={label}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 24,
        height: 24,
        borderRadius: 4,
        border: 'none',
        background: hovered ? 'var(--bg-elevated-2)' : 'transparent',
        color: 'var(--text-muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease-out',
      }}
    >
      {children}
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WorkspaceSidebar({ onOpenWorkspace }: WorkspaceSidebarProps) {
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([])
  // Running agent counts per workspace id, from the main process. Agents keep
  // running across workspace switches, so inactive workspaces have live counts.
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({})
  const [appVersion, setAppVersion] = useState<string>('')
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([])
  const [workspaceColors, setWorkspaceColors] = useState<Record<string, string>>({})
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const activeId = useWorkspaceStore(s => s.workspace?.id)
  const runningCount = useWorkspaceStore(s => {
    function countRunning(node: import('../store/workspace').PaneNode): number {
      if (node.type === 'leaf') return node.ptyStatus === 'running' ? 1 : 0
      return node.children.reduce((sum, c) => sum + countRunning(c), 0)
    }
    return countRunning(s.rootPane)
  })
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace)
  const loadFromJson = useWorkspaceStore(s => s.loadFromJson)
  const resetLayout = useWorkspaceStore(s => s.resetLayout)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function fetchWorkspaces() {
    try {
      const list = await window.swarmmind.workspaceList()
      if (Array.isArray(list)) setWorkspaces(list as RemoteWorkspace[])
    } catch { /* silently ignore */ }
  }

  async function fetchAgentCounts() {
    try {
      const counts = await window.swarmmind.agentCounts()
      if (counts && typeof counts === 'object') setAgentCounts(counts)
    } catch { /* silently ignore */ }
  }

  useEffect(() => {
    Promise.all([
      window.swarmmind.getAppSetting('workspaceOrder').catch(() => null),
      window.swarmmind.getAppSetting('workspaceColors').catch(() => null),
    ]).then(([orderJson, colorsJson]) => {
      if (orderJson) try { setWorkspaceOrder(JSON.parse(orderJson)) } catch {}
      if (colorsJson) try { setWorkspaceColors(JSON.parse(colorsJson)) } catch {}
    })
    fetchWorkspaces()
    fetchAgentCounts()
    window.swarmmind.getAppVersion().then(setAppVersion).catch(() => {})
    intervalRef.current = setInterval(() => { fetchWorkspaces(); fetchAgentCounts() }, 5000)
    return () => { if (intervalRef.current !== null) clearInterval(intervalRef.current) }
  }, [])

  // Refetch the moment the active workspace changes — opening/creating one
  // should appear in the list (and reflect agent counts) instantly, not after
  // the next 5s poll tick.
  useEffect(() => { fetchWorkspaces(); fetchAgentCounts() }, [activeId])

  const sortedWorkspaces = useMemo(() => {
    // Stable base order = creation order. The list query returns rows by
    // updated_at DESC, which would shove the active workspace to the top every
    // time it's opened (opening bumps updated_at); creation order keeps each
    // workspace in a fixed place. Manual drag order, when set, overrides it.
    const base = [...workspaces].sort((a, b) => a.created_at - b.created_at)
    if (workspaceOrder.length === 0) return base
    return base.sort((a, b) => {
      const ai = workspaceOrder.indexOf(a.id)
      const bi = workspaceOrder.indexOf(b.id)
      if (ai === -1 && bi === -1) return 0
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  }, [workspaces, workspaceOrder])

  const handleSelectWorkspace = async (id: string) => {
    try {
      const info = await window.swarmmind.workspaceOpenById(id)
      if (info && !info.error) {
        setWorkspace({ id: info.id, name: info.name, rootPath: info.rootPath })
        if (info.savedLayout) loadFromJson(info.savedLayout)
        else resetLayout()
      }
    } catch { /* ignore */ }
  }

  const handleDragStart = (id: string) => setDraggedId(id)

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    if (!draggedId || draggedId === targetId) return
    const ids = sortedWorkspaces.map(w => w.id)
    const fromIdx = ids.indexOf(draggedId)
    const toIdx = ids.indexOf(targetId)
    if (fromIdx < 0 || toIdx < 0) return
    const newIds = [...ids]
    newIds.splice(fromIdx, 1)
    newIds.splice(toIdx, 0, draggedId)
    setWorkspaceOrder(newIds)
  }

  const handleDragEnd = () => {
    const newOrder = sortedWorkspaces.map(w => w.id)
    window.swarmmind.setAppSetting('workspaceOrder', JSON.stringify(newOrder)).catch(() => {})
    setDraggedId(null)
  }

  const handleColorChange = (wsId: string, color: string) => {
    const newColors = { ...workspaceColors, [wsId]: color }
    setWorkspaceColors(newColors)
    window.swarmmind.setAppSetting('workspaceColors', JSON.stringify(newColors)).catch(() => {})
  }

  const handleDelete = async (wsId: string) => {
    try {
      await window.swarmmind.workspaceDelete(wsId)
      setWorkspaces(prev => prev.filter(w => w.id !== wsId))
      if (wsId === activeId) {
        setWorkspace(null)
        resetLayout()
      }
    } catch { /* ignore */ }
  }

  const handleRename = async (wsId: string, name: string) => {
    try {
      const ok = await window.swarmmind.workspaceRename(wsId, name)
      if (!ok) return
      setWorkspaces(prev => prev.map(w => (w.id === wsId ? { ...w, name } : w)))
      if (wsId === activeId) {
        const active = useWorkspaceStore.getState().workspace
        if (active) setWorkspace({ ...active, name })
      }
    } catch { /* ignore */ }
  }

  return (
    <aside style={{
      width: 260, flexShrink: 0,
      background: 'var(--bg-panel)', borderRight: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: 16, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 500 }}>
          Workspaces
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <IconBtn label="New workspace" onClick={onOpenWorkspace}><IconPlus /></IconBtn>
          <IconBtn label="Workspace menu"><IconChevronDown /></IconBtn>
        </div>
      </div>

      {/* Workspace list */}
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}>
        {sortedWorkspaces.map(ws => (
          <WorkspaceRow
            key={ws.id}
            ws={ws}
            active={ws.id === activeId}
            dotColor={workspaceColors[ws.id] ?? defaultColorFor(ws.id)}
            dragging={draggedId === ws.id}
            // Active workspace uses the live store count (instant); others use
            // the polled per-workspace count from the main process.
            sessionCount={ws.id === activeId ? runningCount : (agentCounts[ws.id] ?? 0)}
            onClick={() => handleSelectWorkspace(ws.id)}
            onDragStart={() => handleDragStart(ws.id)}
            onDragOver={e => handleDragOver(e, ws.id)}
            onDragEnd={handleDragEnd}
            onColorSelect={color => handleColorChange(ws.id, color)}
            onDelete={() => handleDelete(ws.id)}
            onRename={name => handleRename(ws.id, name)}
          />
        ))}
        {sortedWorkspaces.length === 0 && (
          <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--text-dim)' }}>
            No workspaces yet
          </div>
        )}
      </div>

      {/* Footer — app version */}
      <div style={{
        flexShrink: 0, padding: '8px 16px', borderTop: '1px solid var(--border-subtle)',
        fontSize: 11, color: 'var(--text-dim)', letterSpacing: '0.02em',
      }}>
        SwarmMind{appVersion ? ` v${appVersion}` : ''}
      </div>
    </aside>
  )
}
