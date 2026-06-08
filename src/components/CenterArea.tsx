import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AgentPane } from './AgentPane'
import { BroadcastBar } from './BroadcastBar'
import { OrchestratorBar } from './OrchestratorBar'
import { useWorkspaceStore, type PaneNode, type PaneLeaf } from '../store/workspace'

// ── Tree helper ───────────────────────────────────────────────────────────────

function getLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return node.children.flatMap(getLeaves)
}

// ── TerminalCard ──────────────────────────────────────────────────────────────

interface TerminalCardProps {
  leafId: string
  isExpanded: boolean
  // False for the hidden background tabs in fullscreen; true everywhere else.
  isVisible?: boolean
  // True when the fullscreen tab strip sits directly above this pane, so the
  // pane squares its top corners to dock onto the strip.
  dockedTop?: boolean
  onToggleExpand: () => void
}

function TerminalCard({ leafId, isExpanded, isVisible = true, dockedTop = false, onToggleExpand }: TerminalCardProps) {
  const splitPane = useWorkspaceStore(s => s.splitPane)
  const closePane = useWorkspaceStore(s => s.closePane)
  const swapPanes = useWorkspaceStore(s => s.swapPanes)
  const isActive = useWorkspaceStore(s => s.activePaneId === leafId)
  const isSelected = useWorkspaceStore(s => s.selectedPaneIds.includes(leafId))
  const [isDragging, setIsDragging] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const dragOverCount = useRef(0)

  const agentId = useWorkspaceStore(s => {
    function findLeaf(node: PaneNode): PaneLeaf | null {
      if (node.type === 'leaf') return node.id === leafId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.agentId ?? null
  })

  const ptyStatus = useWorkspaceStore(s => {
    function findLeaf(node: PaneNode): PaneLeaf | null {
      if (node.type === 'leaf') return node.id === leafId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.ptyStatus ?? 'idle'
  })

  const paneCwd = useWorkspaceStore(s => {
    function findLeaf(node: PaneNode): PaneLeaf | null {
      if (node.type === 'leaf') return node.id === leafId ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.cwd ?? null
  })

  const handleSplitH = useCallback(() => splitPane(leafId, 'horizontal'), [leafId, splitPane])
  const handleClose = useCallback(() => closePane(leafId), [leafId, closePane])

  const handlePaneDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/pane-id', leafId)
    e.dataTransfer.effectAllowed = 'move'
    setIsDragging(true)
  }, [leafId])

  const handlePaneDragEnd = useCallback(() => {
    setIsDragging(false)
    dragOverCount.current = 0
    setIsDragOver(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/pane-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/pane-id')) return
    dragOverCount.current += 1
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    dragOverCount.current -= 1
    if (dragOverCount.current <= 0) {
      dragOverCount.current = 0
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragOverCount.current = 0
    setIsDragOver(false)
    const sourceId = e.dataTransfer.getData('application/pane-id')
    if (sourceId && sourceId !== leafId) swapPanes(sourceId, leafId)
  }, [leafId, swapPanes])

  const showDropTarget = isDragOver && !isDragging
  const borderVal = showDropTarget || isSelected
    ? '2px solid var(--accent)'
    : '1px solid var(--border-subtle)'

  return (
    <div
      style={{
        flex: 1,
        background: 'var(--bg-terminal)',
        // When docked under the fullscreen tab strip, square the top corners and
        // drop the top border so the strip and pane read as one card with a
        // single divider (the strip's bottom border) instead of rounded corners
        // poking out below a flat-bottomed strip.
        ...(dockedTop
          ? { borderLeft: borderVal, borderRight: borderVal, borderBottom: borderVal, borderTop: 'none', borderRadius: '0 0 10px 10px' }
          : { border: borderVal, borderRadius: 10 }),
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
        opacity: isDragging ? 0.45 : 1,
        transition: 'box-shadow 150ms, opacity 150ms',
        boxShadow: showDropTarget
          ? '0 0 0 1px var(--accent)'
          : isActive
          ? '0 2px 10px rgba(0,0,0,0.45), 0 0 0 1px var(--accent-glow)'
          : '0 2px 8px rgba(0,0,0,0.35)',
      }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <AgentPane
        paneId={leafId}
        agentId={agentId}
        ptyStatus={ptyStatus}
        paneCwd={paneCwd}
        onSplitH={handleSplitH}
        onSplitV={() => splitPane(leafId, 'vertical')}
        onClose={handleClose}
        isExpanded={isExpanded}
        isVisible={isVisible}
        onToggleExpand={onToggleExpand}
        onPaneDragStart={handlePaneDragStart}
        onPaneDragEnd={handlePaneDragEnd}
      />
    </div>
  )
}

// ── PaneTabs (expanded-view navigation strip) ──────────────────────────────────

interface PaneTabsProps {
  leaves: PaneLeaf[]
  activeId: string
  onSelect: (id: string) => void
  onExit: () => void
}

function PaneTabs({ leaves, activeId, onSelect, onExit }: PaneTabsProps) {
  const paneAttention = useWorkspaceStore(s => s.paneAttention)
  const activeTabRef = useRef<HTMLButtonElement>(null)

  // Keep the active tab in view when the strip overflows — important when
  // cycling with Ctrl+Tab through more tabs than fit horizontally.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const stripStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'stretch',
    gap: 4,
    height: 34,
    flex: '0 0 auto',
    padding: '0 4px',
    background: 'var(--bg-panel)',
    // Top + side borders match the pane's side borders below (whose top border
    // is removed when docked), so the strip and pane form one continuous
    // rounded card; the bottom border is the tab/content divider.
    border: '1px solid var(--border-subtle)',
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    overflowX: 'auto',
  }

  return (
    <div style={stripStyle}>
      {leaves.map((leaf, i) => {
        const isActive = leaf.id === activeId
        const label = leaf.title || leaf.agentId || `Pane ${i + 1}`
        const waiting = paneAttention[leaf.id] === 'waiting'
        return (
          <button
            key={leaf.id}
            ref={isActive ? activeTabRef : undefined}
            type="button"
            onClick={() => onSelect(leaf.id)}
            title={label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              maxWidth: 200,
              padding: '0 10px',
              border: 'none',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              background: isActive ? 'var(--bg-elevated)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              fontSize: 12,
              fontWeight: isActive ? 600 : 500,
              cursor: 'pointer',
              borderTopLeftRadius: 6,
              borderTopRightRadius: 6,
              transition: 'background 120ms, color 120ms',
            }}
          >
            <span
              style={{
                flex: '0 0 auto',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: leaf.color || 'var(--text-dim)',
              }}
            />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </span>
            {waiting && (
              <span
                title="Waiting for input"
                style={{
                  flex: '0 0 auto',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                }}
              />
            )}
          </button>
        )
      })}
      <button
        type="button"
        onClick={onExit}
        title="Exit fullscreen (Esc)"
        style={{
          marginLeft: 'auto',
          flex: '0 0 auto',
          alignSelf: 'center',
          padding: '4px 8px',
          border: '1px solid var(--border-subtle)',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--text-secondary)',
          fontSize: 13,
          lineHeight: 1,
          cursor: 'pointer',
        }}
      >
        ⤢
      </button>
    </div>
  )
}

// ── CenterArea ────────────────────────────────────────────────────────────────

export function CenterArea() {
  const rootPane = useWorkspaceStore(s => s.rootPane)
  const [expandedPaneId, setExpandedPaneId] = useState<string | null>(null)

  const leaves = getLeaves(rootPane)
  const count = leaves.length

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedPaneId(prev => prev === id ? null : id)
  }, [])

  // Keyboard nav for the expanded (fullscreen) view: Ctrl+Tab / Ctrl+Shift+Tab
  // cycle panes (wrap), Escape exits to grid. Only handle these specific combos
  // so terminal typing is never swallowed.
  useEffect(() => {
    if (!expandedPaneId) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setExpandedPaneId(null)
        return
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const ids = getLeaves(rootPane).map(l => l.id)
        if (ids.length <= 1) return
        const cur = ids.indexOf(expandedPaneId)
        if (cur === -1) return
        const delta = e.shiftKey ? -1 : 1
        const nextIdx = (cur + delta + ids.length) % ids.length
        setExpandedPaneId(ids[nextIdx])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expandedPaneId, rootPane])

  const mainStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    background: 'var(--bg-base)',
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  }

  // Expanded (fullscreen) view. Every pane stays mounted — only the active tab
  // is shown (the rest are display:none) — so switching tabs never disposes and
  // rebuilds an xterm. That keeps switching instant, preserves each terminal's
  // scroll position, and keeps every pane's PTY output subscription alive so
  // output produced while a pane is a background tab isn't lost. The hidden
  // panes refit automatically when shown (their size goes 0 → real).
  if (expandedPaneId && leaves.some(l => l.id === expandedPaneId)) {
    return (
      <main style={mainStyle}>
        {count > 1 && (
          <PaneTabs
            leaves={leaves}
            activeId={expandedPaneId}
            onSelect={setExpandedPaneId}
            onExit={() => setExpandedPaneId(null)}
          />
        )}
        <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
          {leaves.map(leaf => {
            const visible = leaf.id === expandedPaneId
            return (
              <div
                key={leaf.id}
                style={{ position: 'absolute', inset: 0, display: visible ? 'flex' : 'none' }}
              >
                <TerminalCard
                  leafId={leaf.id}
                  isExpanded={true}
                  isVisible={visible}
                  dockedTop={count > 1}
                  onToggleExpand={() => handleToggleExpand(leaf.id)}
                />
              </div>
            )
          })}
        </div>
        <OrchestratorBar />
        <BroadcastBar />
      </main>
    )
  }

  // Grid view — columns scale with pane count
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3
  const rows = Math.max(1, Math.ceil(count / cols))
  const gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`
  const gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`

  return (
    <main style={mainStyle}>
      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns,
        gridTemplateRows,
        gap: 8,
        minHeight: 0,
        minWidth: 0,
      }}>
        {leaves.map(leaf => (
          <TerminalCard
            key={leaf.id}
            leafId={leaf.id}
            isExpanded={false}
            onToggleExpand={() => handleToggleExpand(leaf.id)}
          />
        ))}
      </div>
      <OrchestratorBar />
      <BroadcastBar />
    </main>
  )
}
