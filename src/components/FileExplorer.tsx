import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useT } from '../i18n'
import { confirmDialog } from './ConfirmDialog'

interface FileExplorerProps {
  rootPath: string
  onFileSelect: (filePath: string, fileName: string) => void
  selectedPath?: string | null
  /** A tree entry was renamed on disk — open tabs pointing at it must follow. */
  onFileRenamed?: (oldPath: string, newPath: string, newName: string) => void
  /** A tree entry was trashed — open tabs under it must close. */
  onFileDeleted?: (path: string) => void
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

// Tighter per-level indent than the usual 16px so deep trees keep more room
// for the actual file names before needing horizontal scroll.
const INDENT_STEP = 12
const BASE_PADDING = 8

// ── Helper ────────────────────────────────────────────────────────────────────

function rootFolderName(path: string): string {
  // Works for both Windows (backslash) and POSIX paths
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

async function loadDir(dirPath: string): Promise<FsEntry[]> {
  return window.swarmmind.fsListDir(dirPath)
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

// ── Expanded-folder persistence ───────────────────────────────────────────────
// The explorer unmounts whenever another center view replaces the FilePanel, so
// which folders are open is remembered per workspace root in localStorage and
// the tree is rebuilt (with fresh directory listings) on the next mount.

const EXPANDED_KEY_PREFIX = 'swarmmind.fileTreeExpanded:'
const MAX_REMEMBERED_DIRS = 500

function loadExpanded(rootPath: string): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY_PREFIX + rootPath)
    const arr: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr.filter((p): p is string => typeof p === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveExpanded(rootPath: string, expanded: Set<string>): void {
  try {
    localStorage.setItem(
      EXPANDED_KEY_PREFIX + rootPath,
      JSON.stringify([...expanded].slice(0, MAX_REMEMBERED_DIRS))
    )
  } catch {
    // localStorage full/unavailable — the tree still works, just isn't remembered
  }
}

/**
 * Load a directory and, depth-first, every remembered-expanded directory under
 * it, returning the flattened row list the explorer renders. Directories that
 * fail to load (deleted, permissions) are dropped from the remembered set.
 */
async function buildNodes(dirPath: string, depth: number, expanded: Set<string>): Promise<TreeNode[]> {
  const entries = sortEntries(await loadDir(dirPath))
  const out: TreeNode[] = []
  for (const e of entries) {
    const node: TreeNode = { entry: e, children: null, expanded: false, depth }
    out.push(node)
    if (e.type === 'dir' && expanded.has(e.path)) {
      try {
        const children = await buildNodes(e.path, depth + 1, expanded)
        node.expanded = true
        node.children = children
        out.push(...children)
      } catch {
        expanded.delete(e.path)
      }
    }
  }
  return out
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FileExplorer({
  rootPath,
  onFileSelect,
  selectedPath,
  onFileRenamed,
  onFileDeleted,
}: FileExplorerProps) {
  const t = useT()
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The remembered-expanded set for the current root; mutated by toggle() and
  // written through to localStorage so a remount restores the open folders.
  const expandedRef = useRef<Set<string>>(new Set())

  // File-operation UI: right-click menu, the row being inline-renamed, the
  // entry whose permissions are open, and the last failure to surface.
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [permsFor, setPermsFor] = useState<FsEntry | null>(null)
  const [opError, setOpError] = useState<string | null>(null)

  // Rebuild the whole tree from disk, keeping the expanded set. Mutations
  // (rename/delete) can change any level, so a full rebuild is simpler — and
  // cheap, since only expanded directories are ever read.
  const reload = useCallback(async () => {
    try {
      const built = await buildNodes(rootPath, 1, expandedRef.current)
      setNodes(built)
      saveExpanded(rootPath, expandedRef.current)
    } catch (err) {
      setError(String(err))
    }
  }, [rootPath])

  // Load root on mount / rootPath change, re-expanding remembered folders
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const expanded = loadExpanded(rootPath)
    expandedRef.current = expanded
    buildNodes(rootPath, 1, expanded)
      .then((built) => {
        if (cancelled) return
        setNodes(built)
        setLoading(false)
        // buildNodes pruned dirs that no longer load — persist the cleanup.
        saveExpanded(rootPath, expanded)
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

  // Dismiss the context menu on any outside click / Escape.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Auto-clear a transient op error so it doesn't linger over the tree.
  useEffect(() => {
    if (!opError) return
    const id = setTimeout(() => setOpError(null), 6000)
    return () => clearTimeout(id)
  }, [opError])

  const commitRename = useCallback(
    async (entry: FsEntry, newName: string) => {
      setRenaming(null)
      const trimmed = newName.trim()
      if (!trimmed || trimmed === entry.name) return
      const res = await window.swarmmind.fsRename(entry.path, trimmed)
      if (!res.ok) { setOpError(res.error); return }
      // A renamed directory invalidates every remembered path beneath it.
      if (entry.type === 'dir') {
        const oldPrefix = entry.path + (entry.path.includes('\\') ? '\\' : '/')
        for (const p of [...expandedRef.current]) {
          if (p === entry.path || p.startsWith(oldPrefix)) expandedRef.current.delete(p)
        }
      }
      onFileRenamed?.(entry.path, res.path, trimmed)
      await reload()
    },
    [onFileRenamed, reload]
  )

  const doDelete = useCallback(
    async (entry: FsEntry) => {
      setMenu(null)
      const ok = await confirmDialog({
        title: entry.name,
        body: entry.type === 'dir' ? t('file.trashDirConfirm') : t('file.trashConfirm'),
        confirmLabel: t('file.moveToTrash'),
        danger: true,
      })
      if (!ok) return
      const res = await window.swarmmind.fsTrash(entry.path)
      if (!res.ok) { setOpError(res.error); return }
      expandedRef.current.delete(entry.path)
      onFileDeleted?.(entry.path)
      await reload()
    },
    [t, onFileDeleted, reload]
  )

  const toggle = useCallback(
    async (nodeIndex: number, node: TreeNode) => {
      if (node.entry.type === 'file') {
        onFileSelect(node.entry.path, node.entry.name)
        return
      }

      // Toggle dir
      if (node.expanded) {
        // Collapse: remove children from flat list
        expandedRef.current.delete(node.entry.path)
        saveExpanded(rootPath, expandedRef.current)
        setNodes((prev) => collapseNode(prev, nodeIndex))
      } else {
        // Expand: lazy load if needed
        expandedRef.current.add(node.entry.path)
        saveExpanded(rootPath, expandedRef.current)
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
    [onFileSelect, rootPath]
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
        overflowY: 'auto',
        overflowX: 'auto',
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
          renaming={renaming === node.entry.path}
          onRenameCommit={(name) => commitRename(node.entry, name)}
          onRenameCancel={() => setRenaming(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, entry: node.entry })
          }}
        />
      ))}

      {/* Failure banner — permissions, name collisions, locked files */}
      {opError && (
        <div
          onClick={() => setOpError(null)}
          style={{
            position: 'sticky', bottom: 0, margin: 8, padding: '7px 10px',
            background: 'var(--bg-elevated)', border: '1px solid var(--error)',
            borderRadius: 7, color: 'var(--error)', fontSize: 11.5,
            cursor: 'pointer', whiteSpace: 'normal', wordBreak: 'break-word',
          }}
          title={t('common.close')}
        >
          {opError}
        </div>
      )}

      {/* Right-click file operations */}
      {menu && (
        <div
          style={{
            position: 'fixed',
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 180),
            minWidth: 180, padding: 4, zIndex: 300,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
            display: 'flex', flexDirection: 'column', gap: 1,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="ctx-menu-item"
            onClick={() => { setRenaming(menu.entry.path); setMenu(null) }}
          >
            {t('file.rename')}
          </button>
          <button
            className="ctx-menu-item"
            onClick={() => { setPermsFor(menu.entry); setMenu(null) }}
          >
            {t('file.permissions')}
          </button>
          <button
            className="ctx-menu-item"
            onClick={() => { void window.swarmmind.fsReveal(menu.entry.path); setMenu(null) }}
          >
            {t('file.revealInFolder')}
          </button>
          <div style={{ height: 1, background: 'var(--border)', margin: '3px 4px' }} />
          <button
            className="ctx-menu-item"
            data-variant="danger"
            onClick={() => doDelete(menu.entry)}
          >
            {t('file.moveToTrash')}
          </button>
        </div>
      )}

      {/* Permissions editor */}
      {permsFor && (
        <PermissionsDialog
          entry={permsFor}
          onClose={() => setPermsFor(null)}
          onError={setOpError}
        />
      )}
    </div>
  )
}

// ── Permissions dialog ────────────────────────────────────────────────────────
// POSIX shows the full owner/group/other grid. Windows only actually tracks the
// read-only flag (Node maps the owner-write bit onto it and drops the rest), so
// there we show a single honest toggle instead of a grid that would silently
// not apply.

const IS_WINDOWS = navigator.userAgent.includes('Windows')

const PERM_BITS: { label: string; bit: number }[] = [
  { label: 'r', bit: 4 },
  { label: 'w', bit: 2 },
  { label: 'x', bit: 1 },
]

function PermissionsDialog({
  entry,
  onClose,
  onError,
}: {
  entry: FsEntry
  onClose: () => void
  onError: (msg: string) => void
}) {
  const t = useT()
  const [stat, setStat] = useState<FsStat | null>(null)
  const [mode, setMode] = useState(0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.swarmmind.fsStat(entry.path).then((s) => {
      if (cancelled) return
      setStat(s)
      setMode(s ? s.mode & 0o777 : 0)
    })
    return () => { cancelled = true }
  }, [entry.path])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const apply = async () => {
    setSaving(true)
    const res = await window.swarmmind.fsChmod(entry.path, mode)
    setSaving(false)
    if (!res.ok) { onError(res.error); return }
    onClose()
  }

  const octal = (mode & 0o777).toString(8).padStart(3, '0')
  const toggleBit = (shift: number, bit: number) => setMode((m) => m ^ (bit << shift))
  // Windows: the read-only toggle is the owner-write bit, cleared across all
  // three classes so the resulting mode reads sensibly if the repo moves to a
  // POSIX box.
  const winReadonly = (mode & 0o200) === 0
  const setWinReadonly = (ro: boolean) => setMode((m) => (ro ? m & ~0o222 : m | 0o200))

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, maxWidth: 'calc(100vw - 48px)',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 10, padding: 20, boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('file.permissions')}
        </div>
        <div
          style={{
            fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-all',
            fontFamily: 'var(--font-mono, monospace)',
          }}
        >
          {entry.name}
        </div>

        {!stat ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{t('common.loading')}</div>
        ) : IS_WINDOWS ? (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={winReadonly}
                onChange={(e) => setWinReadonly(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              {t('file.perm.readonly')}
            </label>
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              {t('file.perm.windowsNote')}
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {([
                { label: t('file.perm.owner'), shift: 6 },
                { label: t('file.perm.group'), shift: 3 },
                { label: t('file.perm.others'), shift: 0 },
              ] as const).map((cls) => (
                <div key={cls.shift} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 62, fontSize: 12.5, color: 'var(--text-secondary)' }}>{cls.label}</span>
                  {PERM_BITS.map((p) => (
                    <label key={p.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={(mode & (p.bit << cls.shift)) !== 0}
                        onChange={() => toggleBit(cls.shift, p.bit)}
                        style={{ cursor: 'pointer' }}
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)' }}>
              {t('file.perm.mode')}: {octal}
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: '7px 14px', fontSize: 13, fontFamily: 'inherit', borderRadius: 6,
              cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)',
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={apply}
            disabled={!stat || saving}
            style={{
              padding: '7px 14px', fontSize: 13, fontFamily: 'inherit', fontWeight: 600,
              borderRadius: 6, cursor: !stat || saving ? 'default' : 'pointer',
              border: '1px solid var(--accent)', background: 'transparent',
              color: 'var(--accent)', opacity: !stat || saving ? 0.5 : 1,
            }}
          >
            {saving ? t('common.saving') : t('common.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Tree row ──────────────────────────────────────────────────────────────────

interface TreeRowProps {
  node: TreeNode
  index: number
  selectedPath: string | null
  onToggle: (index: number, node: TreeNode) => void
  renaming: boolean
  onRenameCommit: (name: string) => void
  onRenameCancel: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function TreeRow({
  node,
  index,
  selectedPath,
  onToggle,
  renaming,
  onRenameCommit,
  onRenameCancel,
  onContextMenu,
}: TreeRowProps) {
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
        paddingLeft: BASE_PADDING + node.depth * INDENT_STEP,
        paddingRight: 10,
        gap: 6,
        cursor: 'pointer',
        background: bg,
        color: textColor,
        fontSize: 13,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        // Grow to the full name width (enabling horizontal scroll) while still
        // filling the panel so hover/selection spans the visible width.
        width: 'max-content',
        minWidth: '100%',
        boxSizing: 'border-box',
        transition: 'background 80ms',
      }}
      onClick={() => { if (!renaming) onToggle(index, node) }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={onContextMenu}
      title={renaming ? undefined : node.entry.path}
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
      {renaming ? (
        <RenameInput
          initial={node.entry.name}
          isDir={node.entry.type === 'dir'}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
        />
      ) : (
        <span>{node.entry.name}</span>
      )}
    </div>
  )
}

// Inline rename field. Mirrors VS Code: the basename is preselected (so the
// extension survives a straight retype), Enter commits, Escape/blur cancels or
// commits respectively.
function RenameInput({
  initial,
  isDir,
  onCommit,
  onCancel,
}: {
  initial: string
  isDir: boolean
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initial)
  // Escape must not also fire the blur-commit — this latch makes cancel win.
  const cancelled = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf('.')
    // Select just the stem for files with an extension; whole name otherwise.
    if (!isDir && dot > 0) el.setSelectionRange(0, dot)
    else el.select()
  }, [initial, isDir])

  return (
    <input
      ref={ref}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); onCommit(value) }
        else if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; onCancel() }
      }}
      onBlur={() => { if (!cancelled.current) onCommit(value) }}
      style={{
        flex: 1, minWidth: 0, background: 'var(--bg-base)',
        border: '1px solid var(--accent)', borderRadius: 4,
        color: 'var(--text-primary)', fontSize: 12.5, fontFamily: 'inherit',
        padding: '1px 5px', outline: 'none',
      }}
    />
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
