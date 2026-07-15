import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { confirmDialog } from './ConfirmDialog'
import { useT } from '../i18n'

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
  '#f97316', // orange
  '#ef4444', // red
  '#f43f5e', // rose
  '#ec4899', // pink
  '#d946ef', // fuchsia
  '#a855f7', // purple
  '#8b5cf6', // violet
  '#6366f1', // indigo
  '#3b82f6', // blue
  '#0ea5e9', // sky
  '#06b6d4', // cyan
  '#14b8a6', // teal
  '#10b981', // emerald
  '#22c55e', // green
  '#84cc16', // lime
  '#eab308', // yellow
  '#64748b', // slate
]

const UNGROUPED_LABEL = 'Ungrouped'

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
        gap: 5, width: 162, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
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

function IconStar({ filled }: { filled?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  )
}

interface WorkspaceRowProps {
  ws: RemoteWorkspace
  active: boolean
  dotColor: string
  dragging: boolean
  sessionCount: number
  favorite: boolean
  editRequested: boolean
  colorPickerOpen: boolean
  onClick: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDragEnd: () => void
  onColorPickerToggle: () => void
  onColorPickerClose: () => void
  onColorSelect: (color: string) => void
  onDelete: () => void
  onRename: (name: string) => void
  onToggleFavorite: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onEditConsume: () => void
}

function WorkspaceRow({ ws, active, dotColor, dragging, sessionCount, favorite, editRequested, colorPickerOpen, onClick, onDragStart, onDragOver, onDragEnd, onColorPickerToggle, onColorPickerClose, onColorSelect, onDelete, onRename, onToggleFavorite, onContextMenu, onEditConsume }: WorkspaceRowProps) {
  const t = useT()
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(ws.name)

  const beginEdit = () => { setEditValue(ws.name); setEditing(true) }
  const commitEdit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== ws.name) onRename(trimmed)
    setEditing(false)
  }

  // Rename can be triggered from the context menu via `editRequested`. Consume
  // the request so the parent can clear its flag.
  useEffect(() => {
    if (editRequested) {
      beginEdit()
      onEditConsume()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequested])

  return (
    <div
      draggable={!editing}
      onClick={onClick}
      onContextMenu={onContextMenu}
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
          onClick={e => { e.stopPropagation(); onColorPickerToggle() }}
          style={{ position: 'absolute', inset: -5, background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 9999 }}
        />
        {colorPickerOpen && <ColorPicker onSelect={c => { onColorSelect(c); onColorPickerClose() }} />}
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
          title={t('sidebar.renameDbl')}
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

      {/* Persistent favorite indicator when not hovered (hover surfaces the toggle button instead) */}
      {!editing && favorite && !hovered && (
        <span style={{ display: 'flex', alignItems: 'center', color: 'var(--accent)', flexShrink: 0 }}>
          <IconStar filled />
        </span>
      )}

      {hovered && !editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <button
            onClick={e => { e.stopPropagation(); onToggleFavorite() }}
            title={favorite ? t('sidebar.removeFromFav') : t('sidebar.addToFav')}
            style={{
              width: 20, height: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: favorite ? 'var(--accent)' : 'var(--text-dim)', borderRadius: 4, padding: 0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = favorite ? 'var(--accent)' : 'var(--text-dim)' }}
          >
            <IconStar filled={favorite} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); beginEdit() }}
            title={t('sidebar.renameWorkspace')}
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
            title={t('sidebar.removeWorkspace')}
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
  onClick?: (e: React.MouseEvent) => void
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

// ── Workspace menu (the header chevron dropdown) ──────────────────────────────

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
        padding: '6px 10px', fontSize: 13, fontFamily: 'inherit', borderRadius: 5,
        border: 'none', cursor: 'pointer',
        background: hovered ? 'var(--bg-elevated-2)' : 'transparent',
        color: danger
          ? 'var(--error)'
          : hovered ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </button>
  )
}

interface WorkspaceMenuProps {
  onSortName: () => void
  onSortRecent: () => void
  onResetOrder: () => void
  onRefresh: () => void
}

function WorkspaceMenu({ onSortName, onSortRecent, onResetOrder, onRefresh }: WorkspaceMenuProps) {
  const t = useT()
  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 200,
        minWidth: 184, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 4, boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
        display: 'flex', flexDirection: 'column', gap: 1,
      }}
    >
      <div style={{ fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '0.05em', color: 'var(--text-dim)', padding: '4px 10px 2px', fontWeight: 600 }}>
        {t('sidebar.sort')}
      </div>
      <MenuItem onClick={onSortName}>{t('sidebar.sortName')}</MenuItem>
      <MenuItem onClick={onSortRecent}>{t('sidebar.sortRecent')}</MenuItem>
      <MenuItem onClick={onResetOrder}>{t('sidebar.resetOrder')}</MenuItem>
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 2px' }} />
      <MenuItem onClick={onRefresh}>{t('sidebar.refreshList')}</MenuItem>
    </div>
  )
}

// ── Per-row right-click context menu ──────────────────────────────────────────

interface WorkspaceContextMenuProps {
  x: number
  y: number
  favorite: boolean
  groups: string[]
  currentGroup: string | undefined
  onReveal: () => void
  onRename: () => void
  onToggleFavorite: () => void
  onMoveToGroup: (name: string | null) => void
  onDelete: () => void
}

function WorkspaceContextMenu({ x, y, favorite, groups, currentGroup, onReveal, onRename, onToggleFavorite, onMoveToGroup, onDelete }: WorkspaceContextMenuProps) {
  const t = useT()
  const [view, setView] = useState<'main' | 'groups'>('main')
  const [adding, setAdding] = useState(false)
  const [newGroup, setNewGroup] = useState('')

  // Clamp to the viewport so the menu never opens off-screen.
  const left = Math.min(x, window.innerWidth - 210)
  const top = Math.min(y, window.innerHeight - 260)

  return (
    <div
      onClick={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}
      style={{
        position: 'fixed', left, top, zIndex: 300,
        minWidth: 196, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 4, boxShadow: '0 6px 16px rgba(0,0,0,0.45)',
        display: 'flex', flexDirection: 'column', gap: 1,
      }}
    >
      {view === 'main' ? (
        <>
          <MenuItem onClick={onReveal}>{t('sidebar.openExplorer')}</MenuItem>
          <MenuItem onClick={onRename}>{t('sidebar.rename')}</MenuItem>
          <MenuItem onClick={onToggleFavorite}>{favorite ? t('sidebar.removeFromFav') : t('sidebar.addToFav')}</MenuItem>
          <MenuItem onClick={() => { setView('groups'); setAdding(false); setNewGroup('') }}>{t('sidebar.moveToGroup')}</MenuItem>
          {currentGroup && <MenuItem onClick={() => onMoveToGroup(null)}>{t('sidebar.removeFromGroup')}</MenuItem>}
          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 2px' }} />
          <MenuItem onClick={onDelete} danger>{t('common.delete')}</MenuItem>
        </>
      ) : (
        <>
          <div style={{ fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '0.05em', color: 'var(--text-dim)', padding: '4px 10px 2px', fontWeight: 600 }}>
            {t('sidebar.moveToGroupHeader')}
          </div>
          {groups.length === 0 && !adding && (
            <div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--text-dim)' }}>{t('sidebar.noGroups')}</div>
          )}
          {groups.map(g => (
            <MenuItem key={g} onClick={() => onMoveToGroup(g)}>
              <span style={{ flex: 1 }}>{g}</span>
              {g === currentGroup && <span style={{ color: 'var(--accent)', fontSize: 12 }}>✓</span>}
            </MenuItem>
          ))}
          {adding ? (
            <input
              autoFocus
              value={newGroup}
              placeholder={t('sidebar.newGroupPlaceholder')}
              onChange={e => setNewGroup(e.target.value)}
              onKeyDown={e => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  const trimmed = newGroup.trim()
                  if (trimmed) onMoveToGroup(trimmed)
                } else if (e.key === 'Escape') {
                  setAdding(false)
                  setNewGroup('')
                }
              }}
              style={{
                margin: '2px 4px', fontSize: 13, fontFamily: 'inherit',
                color: 'var(--text-primary)', background: 'var(--bg-base)',
                border: '1px solid var(--accent)', borderRadius: 5, padding: '5px 8px', outline: 'none',
              }}
            />
          ) : (
            <MenuItem onClick={() => setAdding(true)}>{t('sidebar.newGroup')}</MenuItem>
          )}
          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 2px' }} />
          <MenuItem onClick={() => { setView('main'); setAdding(false) }}>{t('common.back')}</MenuItem>
        </>
      )}
    </div>
  )
}

// ── Collapsible section header ────────────────────────────────────────────────

function SectionHeader({ label, count, collapsed, onToggle, dropActive, onDragOver, onDrop }: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  dropActive?: boolean
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  return (
    <button
      onClick={onToggle}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
        padding: '6px 16px 4px', cursor: 'pointer',
        border: '1px solid transparent',
        borderColor: dropActive ? 'var(--accent)' : 'transparent',
        background: dropActive ? 'rgba(232,149,107,0.14)' : 'transparent',
        fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '0.05em',
        color: dropActive ? 'var(--accent)' : 'var(--text-dim)', fontWeight: 600, fontFamily: 'inherit',
        transition: 'background 120ms ease-out, border-color 120ms ease-out',
      }}
    >
      <span style={{
        display: 'inline-flex', transition: 'transform 120ms ease-out',
        transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
      }}>
        <IconChevronDown />
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ color: 'var(--text-dim)' }}>{count}</span>
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WorkspaceSidebar({ onOpenWorkspace }: WorkspaceSidebarProps) {
  const t = useT()
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([])
  // Running agent counts per workspace id, from the main process. Agents keep
  // running across workspace switches, so inactive workspaces have live counts.
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({})
  const [appVersion, setAppVersion] = useState<string>('')
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([])
  const [workspaceColors, setWorkspaceColors] = useState<Record<string, string>>({})
  const [workspaceGroups, setWorkspaceGroups] = useState<Record<string, string>>({})
  const [favorites, setFavorites] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})
  const [contextMenu, setContextMenu] = useState<{ wsId: string; x: number; y: number } | null>(null)
  const [editRequestId, setEditRequestId] = useState<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverSection, setDragOverSection] = useState<string | null>(null)
  const [colorPickerWsId, setColorPickerWsId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
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
      window.swarmmind.getAppSetting('workspaceGroups').catch(() => null),
      window.swarmmind.getAppSetting('workspaceFavorites').catch(() => null),
    ]).then(([orderJson, colorsJson, groupsJson, favoritesJson]) => {
      if (orderJson) try { setWorkspaceOrder(JSON.parse(orderJson)) } catch {}
      if (colorsJson) try { setWorkspaceColors(JSON.parse(colorsJson)) } catch {}
      if (groupsJson) try { setWorkspaceGroups(JSON.parse(groupsJson)) } catch {}
      if (favoritesJson) try { setFavorites(JSON.parse(favoritesJson)) } catch {}
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

  // Close the header menu on any outside click. The chevron toggle stops
  // propagation so opening it doesn't immediately re-close it.
  useEffect(() => {
    if (!menuOpen) return
    const handler = () => setMenuOpen(false)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [menuOpen])

  // Close the per-row context menu on any outside click. Clicks inside the menu
  // stop propagation, so navigating its submenus doesn't dismiss it.
  useEffect(() => {
    if (!contextMenu) return
    const handler = () => setContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [contextMenu])

  // At most one color picker is open across the whole sidebar. The dot button
  // and the picker popover both stop propagation, so an outside click clears the
  // single shared id.
  useEffect(() => {
    if (!colorPickerWsId) return
    const handler = () => setColorPickerWsId(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [colorPickerWsId])

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

  // Apply the case-insensitive search filter on top of the sorted order.
  const filteredWorkspaces = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return sortedWorkspaces
    return sortedWorkspaces.filter(w => w.name.toLowerCase().includes(q))
  }, [sortedWorkspaces, searchQuery])

  // Distinct, sorted list of group names actually in use (for the context menu).
  const existingGroups = useMemo(() => {
    const set = new Set<string>()
    for (const g of Object.values(workspaceGroups)) {
      const trimmed = g.trim()
      if (trimmed) set.add(trimmed)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [workspaceGroups])

  // Build the rendered sections: Favorites first, then groups (Ungrouped last).
  // Each preserves the filtered+sorted order within it.
  const sections = useMemo(() => {
    const out: { key: string; label: string; items: RemoteWorkspace[] }[] = []
    const favSet = new Set(favorites)
    const favItems = filteredWorkspaces.filter(w => favSet.has(w.id))
    const rest = filteredWorkspaces.filter(w => !favSet.has(w.id))
    if (favItems.length > 0) out.push({ key: '__favorites__', label: t('sidebar.favorites'), items: favItems })
    const buckets = new Map<string, RemoteWorkspace[]>()
    for (const w of rest) {
      const g = (workspaceGroups[w.id] ?? '').trim()
      const label = g || UNGROUPED_LABEL
      const bucket = buckets.get(label)
      if (bucket) bucket.push(w)
      else buckets.set(label, [w])
    }
    const labels = [...buckets.keys()].sort((a, b) => {
      if (a === UNGROUPED_LABEL) return 1
      if (b === UNGROUPED_LABEL) return -1
      return a.localeCompare(b)
    })
    for (const label of labels) out.push({ key: 'g:' + label, label: label === UNGROUPED_LABEL ? t('sidebar.ungrouped') : label, items: buckets.get(label)! })
    return out
  }, [filteredWorkspaces, favorites, workspaceGroups, t])

  // Only show section headers once the user actually organizes things; otherwise
  // keep the original flat list.
  const showSections = favorites.length > 0 || existingGroups.length > 0

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
    // Dragging over a row is a reorder gesture, not a group drop — drop any
    // pending section highlight so the two don't visually fight.
    if (dragOverSection) setDragOverSection(null)
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
    setDragOverSection(null)
  }

  // A section header is a drop target while a workspace is being dragged. Only
  // named groups and Ungrouped accept a drop; Favorites is left alone so a drop
  // never silently favorites a workspace (that stays an explicit action).
  const sectionIsDroppable = (key: string) => key !== '__favorites__'

  const handleSectionDragOver = (e: React.DragEvent, key: string) => {
    if (!draggedId || !sectionIsDroppable(key)) return
    e.preventDefault()
    if (dragOverSection !== key) setDragOverSection(key)
  }

  const handleSectionDrop = (e: React.DragEvent, key: string, label: string) => {
    e.preventDefault()
    setDragOverSection(null)
    if (!draggedId || !sectionIsDroppable(key)) return
    if (key === 'g:' + UNGROUPED_LABEL) {
      // Dropping onto Ungrouped removes the workspace from its current group.
      const next = { ...workspaceGroups }
      delete next[draggedId]
      persistGroups(next)
    } else {
      persistGroups({ ...workspaceGroups, [draggedId]: label })
    }
    setDraggedId(null)
  }

  // Menu actions reuse the same `workspaceOrder` setting that manual drag writes,
  // so sorting and dragging are one consistent mechanism. Reset clears it, which
  // falls back to creation order (see sortedWorkspaces).
  const persistOrder = (ids: string[]) => {
    setWorkspaceOrder(ids)
    window.swarmmind.setAppSetting('workspaceOrder', JSON.stringify(ids)).catch(() => {})
  }
  const handleSortName = () => {
    persistOrder([...workspaces].sort((a, b) => a.name.localeCompare(b.name)).map(w => w.id))
    setMenuOpen(false)
  }
  const handleSortRecent = () => {
    persistOrder([...workspaces].sort((a, b) => b.updated_at - a.updated_at).map(w => w.id))
    setMenuOpen(false)
  }
  const handleResetOrder = () => {
    persistOrder([])
    setMenuOpen(false)
  }
  const handleRefresh = () => {
    fetchWorkspaces()
    fetchAgentCounts()
    setMenuOpen(false)
  }

  const handleColorChange = (wsId: string, color: string) => {
    const newColors = { ...workspaceColors, [wsId]: color }
    setWorkspaceColors(newColors)
    window.swarmmind.setAppSetting('workspaceColors', JSON.stringify(newColors)).catch(() => {})
  }

  const persistGroups = (groups: Record<string, string>) => {
    setWorkspaceGroups(groups)
    window.swarmmind.setAppSetting('workspaceGroups', JSON.stringify(groups)).catch(() => {})
  }

  const handleMoveToGroup = (wsId: string, name: string | null) => {
    const next = { ...workspaceGroups }
    if (name === null) delete next[wsId]
    else next[wsId] = name
    persistGroups(next)
    setContextMenu(null)
  }

  const persistFavorites = (ids: string[]) => {
    setFavorites(ids)
    window.swarmmind.setAppSetting('workspaceFavorites', JSON.stringify(ids)).catch(() => {})
  }

  const handleToggleFavorite = (wsId: string) => {
    persistFavorites(favorites.includes(wsId) ? favorites.filter(id => id !== wsId) : [...favorites, wsId])
  }

  // Ask via the shared app-styled dialog, then delete on confirm.
  const confirmDelete = async (ws: RemoteWorkspace) => {
    const ok = await confirmDialog({
      title: t('sidebar.deleteTitle'),
      body: (
        <>
          {t('sidebar.deleteBodyPrefix')}{' '}
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>&ldquo;{ws.name}&rdquo;</span>
          {t('sidebar.deleteBodySuffix')}
        </>
      ),
      confirmLabel: t('common.delete'),
      danger: true,
    })
    if (ok) await handleDelete(ws.id)
  }

  // Actual deletion — only invoked after the confirmation dialog is accepted.
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

  const handleReveal = async (wsId: string) => {
    setContextMenu(null)
    try { await window.swarmmind.workspaceReveal(wsId) } catch { /* ignore */ }
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

  const toggleSection = (key: string) => {
    setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const renderRow = (ws: RemoteWorkspace) => (
    <WorkspaceRow
      key={ws.id}
      ws={ws}
      active={ws.id === activeId}
      dotColor={workspaceColors[ws.id] ?? defaultColorFor(ws.id)}
      dragging={draggedId === ws.id}
      // Active workspace uses the live store count (instant); others use
      // the polled per-workspace count from the main process.
      sessionCount={ws.id === activeId ? runningCount : (agentCounts[ws.id] ?? 0)}
      favorite={favorites.includes(ws.id)}
      editRequested={editRequestId === ws.id}
      colorPickerOpen={colorPickerWsId === ws.id}
      onClick={() => handleSelectWorkspace(ws.id)}
      onDragStart={() => handleDragStart(ws.id)}
      onDragOver={e => handleDragOver(e, ws.id)}
      onDragEnd={handleDragEnd}
      onColorPickerToggle={() => setColorPickerWsId(prev => (prev === ws.id ? null : ws.id))}
      onColorPickerClose={() => setColorPickerWsId(null)}
      onColorSelect={color => handleColorChange(ws.id, color)}
      onDelete={() => void confirmDelete(ws)}
      onRename={name => handleRename(ws.id, name)}
      onToggleFavorite={() => handleToggleFavorite(ws.id)}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ wsId: ws.id, x: e.clientX, y: e.clientY }) }}
      onEditConsume={() => setEditRequestId(null)}
    />
  )

  const contextWs = contextMenu ? workspaces.find(w => w.id === contextMenu.wsId) : undefined

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
          {t('sidebar.workspaces')}
        </span>
        <div style={{ display: 'flex', gap: 4, position: 'relative' }}>
          <IconBtn label={t('sidebar.newWorkspace')} onClick={onOpenWorkspace}><IconPlus /></IconBtn>
          <IconBtn label={t('sidebar.menu')} onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}><IconChevronDown /></IconBtn>
          {menuOpen && (
            <WorkspaceMenu
              onSortName={handleSortName}
              onSortRecent={handleSortRecent}
              onResetOrder={handleResetOrder}
              onRefresh={handleRefresh}
            />
          )}
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '0 12px 10px', flexShrink: 0 }}>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder={t('sidebar.search')}
          style={{
            width: '100%', boxSizing: 'border-box', fontSize: 13, fontFamily: 'inherit',
            color: 'var(--text-primary)', background: 'var(--bg-elevated)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', outline: 'none',
          }}
        />
      </div>

      {/* Workspace list */}
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}>
        {showSections ? (
          sections.map(section => {
            const collapsed = collapsedSections[section.key] ?? false
            return (
              <div key={section.key}>
                <SectionHeader
                  label={section.label}
                  count={section.items.length}
                  collapsed={collapsed}
                  onToggle={() => toggleSection(section.key)}
                  dropActive={dragOverSection === section.key}
                  onDragOver={e => handleSectionDragOver(e, section.key)}
                  onDrop={e => handleSectionDrop(e, section.key, section.label)}
                />
                {!collapsed && section.items.map(renderRow)}
              </div>
            )
          })
        ) : (
          filteredWorkspaces.map(renderRow)
        )}
        {filteredWorkspaces.length === 0 && (
          <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--text-dim)' }}>
            {searchQuery.trim() ? t('sidebar.noMatching') : t('sidebar.noWorkspaces')}
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

      {/* Per-row right-click context menu */}
      {contextMenu && contextWs && (
        <WorkspaceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          favorite={favorites.includes(contextWs.id)}
          groups={existingGroups}
          currentGroup={(workspaceGroups[contextWs.id] ?? '').trim() || undefined}
          onReveal={() => handleReveal(contextWs.id)}
          onRename={() => { setEditRequestId(contextWs.id); setContextMenu(null) }}
          onToggleFavorite={() => { handleToggleFavorite(contextWs.id); setContextMenu(null) }}
          onMoveToGroup={name => handleMoveToGroup(contextWs.id, name)}
          onDelete={() => { void confirmDelete(contextWs); setContextMenu(null) }}
        />
      )}
    </aside>
  )
}
