import React, { useEffect, useState, useCallback } from 'react'
import { useT } from '../i18n'

interface FileExplorerProps {
  rootPath: string
  onFileSelect: (filePath: string, fileName: string) => void
  selectedPath?: string | null
}

interface TreeNode {
  entry: FsEntry
  children: TreeNode[] | null // null = not loaded, [] = loaded+empty
  expanded: boolean
  depth: number
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function FolderClosedIcon({ color }: { color: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function FolderOpenIcon({ color }: { color: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <polyline points="8 10 12 14 16 10" />
    </svg>
  )
}

function FileIcon({ ext }: { ext: string }) {
  const color = fileColor(ext)
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  )
}

export function fileColor(ext: string): string {
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.py':
    case '.go':
      return '#60a5fa'
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return '#fbbf24'
    case '.css':
    case '.scss':
    case '.sass':
    case '.less':
      return '#2dd4bf'
    case '.html':
    case '.htm':
    case '.xml':
    case '.svg':
    case '.vue':
    case '.svelte':
      return '#fb923c'
    case '.json':
    case '.yml':
    case '.yaml':
    case '.toml':
      return '#34d399'
    case '.md':
    case '.mdx':
    case '.txt':
      return '#a78bfa'
    case '.php':
    case '.sql':
      return '#818cf8'
    case '.rs':
    case '.c':
    case '.h':
    case '.cpp':
    case '.hpp':
    case '.cs':
    case '.java':
    case '.kt':
    case '.swift':
      return '#f87171'
    case '.sh':
    case '.bash':
    case '.ps1':
    case '.bat':
    case '.cmd':
      return '#4ade80'
    case '.rb':
      return '#fb7185'
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.bmp':
    case '.ico':
    case '.avif':
      return '#c084fc'
    default:
      return 'var(--text-muted)'
  }
}

const FOLDER_COLOR = '#e8b97e'

// ── Helper ────────────────────────────────────────────────────────────────────

function rootFolderName(path: string): string {
  // Works for both Windows (backslash) and POSIX paths
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

async function loadDir(dirPath: string): Promise<FsEntry[]> {
  return window.swarmmind.fsListDir(dirPath)
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FileExplorer({ rootPath, onFileSelect, selectedPath }: FileExplorerProps) {
  const t = useT()
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load root on mount / rootPath change
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadDir(rootPath)
      .then((entries) => {
        if (cancelled) return
        const sorted = sortEntries(entries)
        setNodes(
          sorted.map((e) => ({
            entry: e,
            children: e.type === 'dir' ? null : null,
            expanded: false,
            depth: 1,
          }))
        )
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(String(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  const sortEntries = (entries: FsEntry[]): FsEntry[] => {
    return [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  const toggle = useCallback(
    async (nodeIndex: number, node: TreeNode) => {
      if (node.entry.type === 'file') {
        onFileSelect(node.entry.path, node.entry.name)
        return
      }

      // Toggle dir
      if (node.expanded) {
        // Collapse: remove children from flat list
        setNodes((prev) => collapseNode(prev, nodeIndex))
      } else {
        // Expand: lazy load if needed
        if (node.children === null) {
          // Load first
          try {
            const entries = await loadDir(node.entry.path)
            const sorted = sortEntries(entries)
            const childNodes: TreeNode[] = sorted.map((e) => ({
              entry: e,
              children: e.type === 'dir' ? null : null,
              expanded: false,
              depth: node.depth + 1,
            }))
            setNodes((prev) => expandNode(prev, nodeIndex, childNodes))
          } catch {
            // ignore load errors gracefully
          }
        } else {
          setNodes((prev) => expandNode(prev, nodeIndex, node.children!))
        }
      }
    },
    [onFileSelect]
  )

  if (loading) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: 12,
          background: 'var(--bg-panel)',
        }}
      >
        {t('common.loading')}
      </div>
    )
  }

  if (error) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#ef4444',
          fontSize: 12,
          padding: 8,
          background: 'var(--bg-panel)',
        }}
      >
        {error}
      </div>
    )
  }

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        background: 'var(--bg-panel)',
        userSelect: 'none',
      }}
    >
      {/* Root folder header */}
      <div
        style={{
          height: 28,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 8,
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <FolderOpenIcon color={FOLDER_COLOR} />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={rootPath}
        >
          {rootFolderName(rootPath)}
        </span>
      </div>

      {/* Tree rows */}
      {nodes.map((node, i) => (
        <TreeRow
          key={node.entry.path}
          node={node}
          index={i}
          selectedPath={selectedPath ?? null}
          onToggle={toggle}
        />
      ))}
    </div>
  )
}

// ── Tree row ──────────────────────────────────────────────────────────────────

interface TreeRowProps {
  node: TreeNode
  index: number
  selectedPath: string | null
  onToggle: (index: number, node: TreeNode) => void
}

function TreeRow({ node, index, selectedPath, onToggle }: TreeRowProps) {
  const [hovered, setHovered] = useState(false)
  const isSelected = node.entry.type === 'file' && node.entry.path === selectedPath

  const bg = isSelected
    ? 'var(--accent-subtle)'
    : hovered
    ? 'var(--bg-elevated)'
    : 'transparent'

  const textColor = isSelected ? 'var(--accent)' : 'var(--text-secondary)'

  return (
    <div
      style={{
        height: 28,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: node.depth * 16,
        gap: 6,
        cursor: 'pointer',
        background: bg,
        color: textColor,
        fontSize: 13,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        transition: 'background 80ms',
      }}
      onClick={() => onToggle(index, node)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={node.entry.path}
    >
      {node.entry.type === 'dir' ? (
        node.expanded ? (
          <FolderOpenIcon color={FOLDER_COLOR} />
        ) : (
          <FolderClosedIcon color={FOLDER_COLOR} />
        )
      ) : (
        <FileIcon ext={node.entry.ext} />
      )}
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {node.entry.name}
      </span>
    </div>
  )
}

// ── Flat-list helpers ─────────────────────────────────────────────────────────

/**
 * Expand a dir node: mark it expanded, store its children, insert them after it.
 */
function expandNode(
  nodes: TreeNode[],
  index: number,
  children: TreeNode[]
): TreeNode[] {
  const next = [...nodes]
  next[index] = { ...next[index], expanded: true, children }
  next.splice(index + 1, 0, ...children)
  return next
}

/**
 * Collapse a dir node: mark it collapsed, remove all descendant rows.
 */
function collapseNode(nodes: TreeNode[], index: number): TreeNode[] {
  const node = nodes[index]
  const depth = node.depth
  let end = index + 1
  while (end < nodes.length && nodes[end].depth > depth) end++
  const next = [...nodes]
  next[index] = { ...next[index], expanded: false }
  next.splice(index + 1, end - index - 1)
  return next
}
