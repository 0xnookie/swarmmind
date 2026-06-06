import React from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { AgentPane } from './AgentPane'
import { useWorkspaceStore, type PaneNode, type PaneGroup, type PaneLeaf } from '../store/workspace'

export function PaneManager() {
  const rootPane = useWorkspaceStore(s => s.rootPane)
  const splitPane = useWorkspaceStore(s => s.splitPane)
  const closePane = useWorkspaceStore(s => s.closePane)

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <PaneTree
        node={rootPane}
        onSplitH={(id) => splitPane(id, 'horizontal')}
        onSplitV={(id) => splitPane(id, 'vertical')}
        onClose={closePane}
      />
    </div>
  )
}

interface PaneTreeProps {
  node: PaneNode
  onSplitH: (id: string) => void
  onSplitV: (id: string) => void
  onClose: (id: string) => void
}

function PaneTree({ node, onSplitH, onSplitV, onClose }: PaneTreeProps) {
  if (node.type === 'leaf') {
    return (
      <LeafRenderer
        leaf={node}
        onSplitH={onSplitH}
        onSplitV={onSplitV}
        onClose={onClose}
      />
    )
  }
  return (
    <GroupRenderer
      group={node}
      onSplitH={onSplitH}
      onSplitV={onSplitV}
      onClose={onClose}
    />
  )
}

interface LeafRendererProps {
  leaf: PaneLeaf
  onSplitH: (id: string) => void
  onSplitV: (id: string) => void
  onClose: (id: string) => void
}

function LeafRenderer({ leaf, onSplitH, onSplitV, onClose }: LeafRendererProps) {
  // Subscribe to per-leaf state updates
  const agentId = useWorkspaceStore(s => {
    function findLeaf(node: PaneNode): PaneLeaf | null {
      if (node.type === 'leaf') return node.id === leaf.id ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.agentId ?? null
  })

  const ptyStatus = useWorkspaceStore(s => {
    function findLeaf(node: PaneNode): PaneLeaf | null {
      if (node.type === 'leaf') return node.id === leaf.id ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.ptyStatus ?? 'idle'
  })

  const paneCwd = useWorkspaceStore(s => {
    function findLeaf(node: PaneNode): PaneLeaf | null {
      if (node.type === 'leaf') return node.id === leaf.id ? node : null
      for (const c of node.children) { const f = findLeaf(c); if (f) return f }
      return null
    }
    return findLeaf(s.rootPane)?.cwd ?? null
  })

  return (
    <AgentPane
      paneId={leaf.id}
      agentId={agentId}
      ptyStatus={ptyStatus}
      paneCwd={paneCwd}
      onSplitH={() => onSplitH(leaf.id)}
      onSplitV={() => onSplitV(leaf.id)}
      onClose={() => onClose(leaf.id)}
    />
  )
}

interface GroupRendererProps {
  group: PaneGroup
  onSplitH: (id: string) => void
  onSplitV: (id: string) => void
  onClose: (id: string) => void
}

function GroupRenderer({ group, onSplitH, onSplitV, onClose }: GroupRendererProps) {
  return (
    <Allotment
      key={group.id}
      vertical={group.direction === 'vertical'}
      separator
    >
      {group.children.map(child => (
        <Allotment.Pane key={child.id} minSize={120}>
          <PaneTree
            node={child}
            onSplitH={onSplitH}
            onSplitV={onSplitV}
            onClose={onClose}
          />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}
