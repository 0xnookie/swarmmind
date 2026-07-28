import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useT, type TFunction } from '../i18n'
import { confirmDialog } from './ConfirmDialog'
import { ChevronDisclosure } from './Icons'
import {
  baseName, parentDir, rewritePath, selectRange, toggleSelection,
  canMoveInto, canCopyInto, topLevelPaths, relativeToRoot, isUnder,
} from '../lib/fileOps'

interface FileExplorerProps {
  rootPath: string
  onFileSelect: (filePath: string, fileName: string) => void
  selectedPath?: string | null
  /** A tree entry was renamed or moved on disk — open tabs pointing at it must follow. */
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

/** Cut/copy staging area. Lives in the component, not the OS clipboard, so the
 *  paths survive focus changes and can carry the copy-vs-move intent. */
interface FileClipboard {
  paths: string[]
  mode: 'copy' | 'cut'
}

/** One reversible file operation. `run` performs the inverse (including any
 *  editor-tab follow-up) and resolves to an error string, or null on success. */
interface UndoAction {
  label: string
  run: () => Promise<string | null>
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

// Drag payload marker. The concrete paths ride in a ref (dataTransfer contents
// are unreadable during dragover, and we need them to decide drop validity),
// but the type still has to be present for the browser to allow the drop.
const DRAG_MIME = 'application/x-swarmmind-paths'

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

/** A copy/move lands *in* a folder; dropping on a file means its parent. */
function containerOf(entry: FsEntry): string {
  return entry.type === 'dir' ? entry.path : parentDir(entry.path)
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
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Multi-selection (Ctrl/⌘-click toggles, Shift-click extends). `anchor` is the
  // last row touched — the origin of a shift-range and the cursor for keyboard
  // navigation.
  const [selection, setSelection] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const selectionSet = useMemo(() => new Set(selection), [selection])

  const [clipboard, setClipboard] = useState<FileClipboard | null>(null)
  const cutSet = useMemo(
    () => new Set(clipboard?.mode === 'cut' ? clipboard.paths : []),
    [clipboard]
  )

  // Inline "new file/folder" row: which directory it belongs to and what kind.
  const [creating, setCreating] = useState<{ dir: string; kind: 'file' | 'dir' } | null>(null)

  // Drag state. `dragPathsRef` carries the payload because dragover handlers may
  // not read dataTransfer data — we still need it to compute drop validity.
  const dragPathsRef = useRef<string[]>([])
  const [dropTarget, setDropTarget] = useState<{ dir: string; row: string } | null>(null)

  // Undo stack (Ctrl+Z) for the reversible mutating ops — rename, move, create,
  // duplicate, paste, import. Each entry knows how to invert itself and update
  // the open editor tabs; trashing is deliberately NOT here (it went to the OS
  // trash, which the user restores from there). Bounded so it can't grow forever.
  const undoRef = useRef<UndoAction[]>([])
  const [canUndo, setCanUndo] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)

  const showFlash = useCallback((msg: string) => setFlash(msg), [])

  const pushUndo = useCallback((action: UndoAction) => {
    undoRef.current.push(action)
    if (undoRef.current.length > 25) undoRef.current.shift()
    setCanUndo(true)
  }, [])

  // Rebuild the whole tree from disk, keeping the expanded set. Mutations
  // (rename/move/copy/delete) can change any level, so a full rebuild is
  // simpler — and cheap, since only expanded directories are ever read.
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

  // Auto-clear the transient banners so they don't linger over the tree.
  useEffect(() => {
    if (!opError) return
    const id = setTimeout(() => setOpError(null), 6000)
    return () => clearTimeout(id)
  }, [opError])

  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), 2200)
    return () => clearTimeout(id)
  }, [flash])

  // ── Expanded-set bookkeeping ────────────────────────────────────────────────

  /** Follow a rename/move: remembered-open paths under the old location move too. */
  const remapExpanded = useCallback((oldPath: string, newPath: string) => {
    const next = new Set<string>()
    for (const p of expandedRef.current) next.add(rewritePath(p, oldPath, newPath) ?? p)
    expandedRef.current = next
  }, [])

  /** Forget a deleted subtree so it isn't re-probed on the next rebuild. */
  const forgetExpanded = useCallback((path: string) => {
    for (const p of [...expandedRef.current]) {
      if (p === path || isUnder(path, p)) expandedRef.current.delete(p)
    }
  }, [])

  // ── Selection ───────────────────────────────────────────────────────────────

  const selectOnly = useCallback((path: string) => {
    setSelection([path])
    setAnchor(path)
  }, [])

  /**
   * Which entries an action applies to. Right-clicking inside the selection
   * keeps it (so "delete" hits all five files you highlighted); right-clicking
   * outside collapses to the row under the cursor, like every file manager.
   */
  const targetsFor = useCallback(
    (entry: FsEntry): string[] =>
      selectionSet.has(entry.path) ? topLevelPaths(selection) : [entry.path],
    [selection, selectionSet]
  )

  /** Where a paste / new-file lands: the selected folder, else its parent. */
  const activeDir = useCallback((): string => {
    const focus = anchor ?? selection[selection.length - 1]
    if (!focus) return rootPath
    const node = nodes.find((n) => n.entry.path === focus)
    if (!node) return rootPath
    return containerOf(node.entry)
  }, [anchor, selection, nodes, rootPath])

  // ── Mutations ───────────────────────────────────────────────────────────────

  const commitRename = useCallback(
    async (entry: FsEntry, newName: string) => {
      setRenaming(null)
      const trimmed = newName.trim()
      if (!trimmed || trimmed === entry.name) return
      const res = await window.swarmmind.fsRename(entry.path, trimmed)
      if (!res.ok) { setOpError(res.error); return }
      remapExpanded(entry.path, res.path)
      onFileRenamed?.(entry.path, res.path, trimmed)
      setSelection([res.path])
      setAnchor(res.path)
      pushUndo({
        label: t('file.undo.rename'),
        run: async () => {
          const back = await window.swarmmind.fsRename(res.path, entry.name)
          if (!back.ok) return back.error
          remapExpanded(res.path, back.path)
          onFileRenamed?.(res.path, back.path, entry.name)
          return null
        },
      })
      await reload()
    },
    [onFileRenamed, reload, remapExpanded, pushUndo, t]
  )

  const commitCreate = useCallback(
    async (name: string) => {
      const target = creating
      setCreating(null)
      const trimmed = name.trim()
      if (!target || !trimmed) return
      const res = await window.swarmmind.fsCreate(target.dir, trimmed, target.kind)
      if (!res.ok) { setOpError(res.error); return }
      pushUndo({
        label: t('file.undo.create'),
        run: async () => {
          const del = await window.swarmmind.fsTrash(res.path)
          if (!del.ok) return del.error
          forgetExpanded(res.path)
          onFileDeleted?.(res.path)
          return null
        },
      })
      await reload()
      setSelection([res.path])
      setAnchor(res.path)
      // A new file opens straight away — that's why you made it.
      if (target.kind === 'file') onFileSelect(res.path, baseName(res.path))
    },
    [creating, reload, onFileSelect, pushUndo, forgetExpanded, onFileDeleted, t]
  )

  /** Open the inline create row, expanding the destination folder first. */
  const startCreate = useCallback(
    async (dir: string, kind: 'file' | 'dir') => {
      setMenu(null)
      if (dir !== rootPath && !expandedRef.current.has(dir)) {
        expandedRef.current.add(dir)
        await reload()
      }
      setCreating({ dir, kind })
    },
    [rootPath, reload]
  )

  const doDelete = useCallback(
    async (paths: string[]) => {
      setMenu(null)
      if (!paths.length) return
      const single = paths.length === 1
      const node = single ? nodes.find((n) => n.entry.path === paths[0]) : null
      const ok = await confirmDialog({
        title: single ? baseName(paths[0]) : t('file.trashManyTitle', { n: paths.length }),
        body: !single
          ? t('file.trashManyConfirm', { n: paths.length })
          : node?.entry.type === 'dir'
          ? t('file.trashDirConfirm')
          : t('file.trashConfirm'),
        confirmLabel: t('file.moveToTrash'),
        danger: true,
      })
      if (!ok) return
      setBusy(true)
      let failure: string | null = null
      for (const p of paths) {
        const res = await window.swarmmind.fsTrash(p)
        if (!res.ok) { failure = res.error; break }
        forgetExpanded(p)
        onFileDeleted?.(p)
      }
      setSelection([])
      setAnchor(null)
      await reload()
      setBusy(false)
      if (failure) setOpError(failure)
    },
    [t, nodes, onFileDeleted, reload, forgetExpanded]
  )

  const doDuplicate = useCallback(
    async (paths: string[]) => {
      setMenu(null)
      if (!paths.length) return
      setBusy(true)
      const created: string[] = []
      let failure: string | null = null
      for (const p of paths) {
        const res = await window.swarmmind.fsDuplicate(p)
        if (!res.ok) { failure = res.error; break }
        created.push(res.path)
      }
      if (created.length) {
        pushUndo({
          label: t('file.undo.duplicate'),
          run: async () => {
            let err: string | null = null
            for (const p of created) {
              const del = await window.swarmmind.fsTrash(p)
              if (!del.ok) { err = del.error; continue }
              forgetExpanded(p)
              onFileDeleted?.(p)
            }
            return err
          },
        })
      }
      await reload()
      if (created.length) { setSelection(created); setAnchor(created[created.length - 1]) }
      setBusy(false)
      if (failure) setOpError(failure)
    },
    [reload, pushUndo, forgetExpanded, onFileDeleted, t]
  )

  /**
   * The one code path behind paste, drag-and-drop and cut/copy: relocate or
   * clone `sources` into `destDir`. Moves report through `onFileRenamed` so
   * open editor tabs follow the file instead of dangling at a dead path.
   */
  const transfer = useCallback(
    async (sources: string[], destDir: string, mode: 'copy' | 'cut') => {
      const tops = topLevelPaths(sources)
      const allowed = mode === 'cut' ? canMoveInto(tops, destDir) : canCopyInto(tops, destDir)
      if (!allowed) { setOpError(t('file.op.invalidTarget')); return }
      setBusy(true)
      const landed: string[] = []
      // For a move, remember where each entry came from so the undo can put it
      // back in its original folder.
      const moved: { from: string; to: string }[] = []
      let failure: string | null = null
      for (const src of tops) {
        const res = mode === 'cut'
          ? await window.swarmmind.fsMove(src, destDir)
          : await window.swarmmind.fsCopy(src, destDir)
        if (!res.ok) { failure = res.error; break }
        landed.push(res.path)
        if (mode === 'cut') {
          remapExpanded(src, res.path)
          onFileRenamed?.(src, res.path, baseName(res.path))
          moved.push({ from: src, to: res.path })
        }
      }
      // Register the inverse: a move goes back to each original parent; a copy
      // is undone by trashing what it created.
      if (mode === 'cut' && moved.length) {
        pushUndo({
          label: t('file.undo.move'),
          run: async () => {
            let err: string | null = null
            for (const m of moved) {
              const back = await window.swarmmind.fsMove(m.to, parentDir(m.from))
              if (!back.ok) { err = back.error; continue }
              remapExpanded(m.to, back.path)
              onFileRenamed?.(m.to, back.path, baseName(back.path))
            }
            return err
          },
        })
      } else if (mode === 'copy' && landed.length) {
        pushUndo({
          label: t('file.undo.copy'),
          run: async () => {
            let err: string | null = null
            for (const p of landed) {
              const del = await window.swarmmind.fsTrash(p)
              if (!del.ok) { err = del.error; continue }
              forgetExpanded(p)
              onFileDeleted?.(p)
            }
            return err
          },
        })
      }
      // Reveal where things landed.
      if (destDir !== rootPath) expandedRef.current.add(destDir)
      await reload()
      if (landed.length) { setSelection(landed); setAnchor(landed[landed.length - 1]) }
      setBusy(false)
      if (failure) setOpError(failure)
    },
    [t, rootPath, reload, remapExpanded, onFileRenamed, pushUndo, forgetExpanded, onFileDeleted]
  )

  const doPaste = useCallback(
    async (destDir: string) => {
      setMenu(null)
      const clip = clipboard
      if (!clip) return
      await transfer(clip.paths, destDir, clip.mode)
      // A cut is consumed by its paste; a copy stays on the clipboard so it can
      // be pasted into several places, as in every file manager.
      if (clip.mode === 'cut') setClipboard(null)
    },
    [clipboard, transfer]
  )

  /** OS file-manager drop: copy the dragged files into the workspace. */
  const doImport = useCallback(
    async (files: FileList, destDir: string) => {
      const sources = Array.from(files)
        .map((f) => window.swarmmind.fsPathForFile(f))
        .filter(Boolean)
      if (!sources.length) return
      setBusy(true)
      const res = await window.swarmmind.fsImport(sources, destDir)
      if (destDir !== rootPath) expandedRef.current.add(destDir)
      await reload()
      setBusy(false)
      if (!res.ok) { setOpError(res.error); return }
      if (res.paths.length) {
        setSelection(res.paths); setAnchor(res.paths[res.paths.length - 1])
        pushUndo({
          label: t('file.undo.import'),
          run: async () => {
            let err: string | null = null
            for (const p of res.paths) {
              const del = await window.swarmmind.fsTrash(p)
              if (!del.ok) { err = del.error; continue }
              forgetExpanded(p)
              onFileDeleted?.(p)
            }
            return err
          },
        })
      }
      showFlash(t('file.op.imported', { n: res.paths.length }))
    },
    [rootPath, reload, showFlash, t, pushUndo, forgetExpanded, onFileDeleted]
  )

  const doUndo = useCallback(async () => {
    const action = undoRef.current.pop()
    setCanUndo(undoRef.current.length > 0)
    if (!action) return
    setBusy(true)
    const err = await action.run()
    await reload()
    setBusy(false)
    if (err) setOpError(err)
    else showFlash(`${t('file.undo.done')}: ${action.label}`)
  }, [reload, showFlash, t])

  const copyText = useCallback(
    (text: string, msg: string) => {
      navigator.clipboard.writeText(text).then(() => showFlash(msg)).catch(() => {})
    },
    [showFlash]
  )

  // ── Expand / collapse ───────────────────────────────────────────────────────

  const setExpanded = useCallback(
    async (node: TreeNode, index: number, open: boolean) => {
      if (node.entry.type !== 'dir' || node.expanded === open) return
      if (!open) {
        expandedRef.current.delete(node.entry.path)
        saveExpanded(rootPath, expandedRef.current)
        setNodes((prev) => collapseNode(prev, index))
        return
      }
      expandedRef.current.add(node.entry.path)
      saveExpanded(rootPath, expandedRef.current)
      try {
        const children = sortEntries(await loadDir(node.entry.path)).map((e): TreeNode => ({
          entry: e,
          children: null,
          expanded: false,
          depth: node.depth + 1,
        }))
        setNodes((prev) => expandNode(prev, index, children))
      } catch {
        // Unreadable directory — leave it collapsed.
      }
    },
    [rootPath]
  )

  const collapseAll = useCallback(async () => {
    expandedRef.current = new Set()
    await reload()
  }, [reload])

  const toggle = useCallback(
    async (nodeIndex: number, node: TreeNode) => {
      if (node.entry.type === 'file') {
        onFileSelect(node.entry.path, node.entry.name)
        return
      }
      await setExpanded(node, nodeIndex, !node.expanded)
    },
    [onFileSelect, setExpanded]
  )

  // ── Row interaction ─────────────────────────────────────────────────────────

  const handleRowClick = useCallback(
    (e: React.MouseEvent, index: number, node: TreeNode) => {
      const path = node.entry.path
      if (e.shiftKey && anchor) {
        const from = nodes.findIndex((n) => n.entry.path === anchor)
        if (from >= 0) {
          setSelection(selectRange(nodes, from, index).map((n) => n.entry.path))
          return
        }
      }
      if (e.ctrlKey || e.metaKey) {
        setSelection((prev) => toggleSelection(prev, path))
        setAnchor(path)
        return
      }
      selectOnly(path)
      void toggle(index, node)
    },
    [anchor, nodes, selectOnly, toggle]
  )

  // ── Keyboard ────────────────────────────────────────────────────────────────
  // The whole IDE shortcut set, scoped to the tree (the container is focusable
  // and these only fire while focus is inside it, so Ctrl-C in the editor is
  // untouched).

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // An inline rename/create input owns its own keys.
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      // Claim a key for the tree: stop it here so a (possibly rebound) global
      // shortcut on window doesn't also fire for the same press.
      const take = () => { e.preventDefault(); e.stopPropagation() }
      const mod = e.ctrlKey || e.metaKey
      const focusIndex = anchor ? nodes.findIndex((n) => n.entry.path === anchor) : -1
      const node = focusIndex >= 0 ? nodes[focusIndex] : null
      const targets = topLevelPaths(selection)

      const move = (delta: number) => {
        if (!nodes.length) return
        const next = focusIndex < 0 ? 0 : Math.max(0, Math.min(nodes.length - 1, focusIndex + delta))
        const path = nodes[next].entry.path
        setAnchor(path)
        if (e.shiftKey && focusIndex >= 0) {
          setSelection(selectRange(nodes, focusIndex, next).map((n) => n.entry.path))
        } else {
          setSelection([path])
        }
        containerRef.current
          ?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      }

      switch (true) {
        case e.key === 'ArrowDown':
          take(); move(1); return
        case e.key === 'ArrowUp':
          take(); move(-1); return
        case e.key === 'ArrowRight':
          if (node?.entry.type === 'dir') { take(); void setExpanded(node, focusIndex, true) }
          return
        case e.key === 'ArrowLeft':
          if (node?.entry.type === 'dir' && node.expanded) { take(); void setExpanded(node, focusIndex, false) }
          return
        case e.key === 'Enter':
          if (node) { take(); void toggle(focusIndex, node) }
          return
        case e.key === 'F2':
          if (node) { take(); setRenaming(node.entry.path) }
          return
        case e.key === 'Delete':
          if (targets.length) { take(); void doDelete(targets) }
          return
        case e.key === 'Escape':
          setSelection([]); setAnchor(null); setClipboard(null); setCreating(null)
          return
        case mod && e.key.toLowerCase() === 'a':
          take(); setSelection(nodes.map((n) => n.entry.path)); return
        case mod && e.key.toLowerCase() === 'c':
          if (targets.length) { take(); setClipboard({ paths: targets, mode: 'copy' }); showFlash(t('file.op.copied', { n: targets.length })) }
          return
        case mod && e.key.toLowerCase() === 'x':
          if (targets.length) { take(); setClipboard({ paths: targets, mode: 'cut' }); showFlash(t('file.op.cut', { n: targets.length })) }
          return
        case mod && e.key.toLowerCase() === 'z':
          take(); void doUndo(); return
        case mod && e.key.toLowerCase() === 'v':
          if (clipboard) { take(); void doPaste(activeDir()) }
          return
        case mod && e.key.toLowerCase() === 'd':
          if (targets.length) { take(); void doDuplicate(targets) }
          return
        case mod && e.key.toLowerCase() === 'n':
          take(); void startCreate(activeDir(), e.shiftKey ? 'dir' : 'file'); return
        default:
          return
      }
    },
    [anchor, nodes, selection, clipboard, activeDir, setExpanded, toggle, doDelete, doDuplicate, doPaste, doUndo, startCreate, showFlash, t]
  )

  // ── Drag & drop ─────────────────────────────────────────────────────────────

  const onRowDragStart = useCallback(
    (e: React.DragEvent, entry: FsEntry) => {
      // Dragging an unselected row implicitly selects it, matching Explorer.
      const paths = selectionSet.has(entry.path) ? topLevelPaths(selection) : [entry.path]
      if (!selectionSet.has(entry.path)) selectOnly(entry.path)
      dragPathsRef.current = paths
      e.dataTransfer.effectAllowed = 'copyMove'
      e.dataTransfer.setData(DRAG_MIME, paths.join('\n'))
      e.dataTransfer.setData('text/plain', paths.join('\n'))
    },
    [selection, selectionSet, selectOnly]
  )

  const onRowDragEnd = useCallback(() => {
    dragPathsRef.current = []
    setDropTarget(null)
  }, [])

  /** Drops are external (OS files) unless our own drag is in flight. */
  const dragOverDir = useCallback((e: React.DragEvent, dir: string, row: string) => {
    const dragged = dragPathsRef.current
    if (dragged.length) {
      const copy = e.ctrlKey || e.altKey
      const ok = copy ? canCopyInto(dragged, dir) : canMoveInto(dragged, dir)
      if (!ok) { setDropTarget(null); return }
      e.preventDefault()
      e.dataTransfer.dropEffect = copy ? 'copy' : 'move'
    } else {
      // Files coming in from Explorer/Finder.
      if (!Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    // dragover fires continuously; only re-render when the target actually
    // changes, or the whole tree repaints dozens of times per second.
    setDropTarget((prev) => (prev?.row === row && prev.dir === dir ? prev : { dir, row }))
  }, [])

  const dropOnDir = useCallback(
    (e: React.DragEvent, dir: string) => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      const dragged = dragPathsRef.current
      dragPathsRef.current = []
      if (dragged.length) {
        void transfer(dragged, dir, e.ctrlKey || e.altKey ? 'copy' : 'cut')
        return
      }
      if (e.dataTransfer.files?.length) void doImport(e.dataTransfer.files, dir)
    },
    [transfer, doImport]
  )

  // ── Render ──────────────────────────────────────────────────────────────────

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

  // Where the inline create row goes: directly under its parent folder's row,
  // or at the very top when it belongs to the workspace root.
  const createParentIndex = creating && creating.dir !== rootPath
    ? nodes.findIndex((n) => n.entry.path === creating.dir)
    : -1
  const createAtRoot = !!creating && creating.dir === rootPath
  const createDepth = createParentIndex >= 0 ? nodes[createParentIndex].depth + 1 : 1

  const rootIsDropTarget = dropTarget?.row === rootPath

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        // Right-click on empty space acts on the workspace root.
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        setSelection([])
        setAnchor(null)
        setMenu({ x: e.clientX, y: e.clientY, entry: { name: rootFolderName(rootPath), path: rootPath, type: 'dir', ext: '' } })
      }}
      onDragOver={(e) => { if (e.target === e.currentTarget) dragOverDir(e, rootPath, rootPath) }}
      onDrop={(e) => { if (e.target === e.currentTarget) dropOnDir(e, rootPath) }}
      style={{
        height: '100%',
        overflowY: 'auto',
        overflowX: 'auto',
        background: 'var(--bg-panel)',
        userSelect: 'none',
        outline: 'none',
        position: 'relative',
      }}
    >
      {/* Root folder header — also the drop target for "move to the top level" */}
      <div
        onDragOver={(e) => dragOverDir(e, rootPath, rootPath)}
        onDragLeave={() => setDropTarget((d) => (d?.row === rootPath ? null : d))}
        onDrop={(e) => dropOnDir(e, rootPath)}
        style={{
          height: 28,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 8,
          paddingRight: 4,
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          borderBottom: '1px solid var(--border-subtle)',
          background: rootIsDropTarget ? 'var(--accent-subtle)' : undefined,
          boxShadow: rootIsDropTarget ? 'inset 0 0 0 1px var(--accent)' : undefined,
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          zIndex: 3,
        }}
      >
        <FolderOpenIcon color={FOLDER_COLOR} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={rootPath}
        >
          {rootFolderName(rootPath)}
        </span>

        {/* Toolbar: new file / new folder / collapse all / refresh */}
        <ToolbarButton title={t('file.newFile')} onClick={() => startCreate(activeDir(), 'file')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M12 12v6M9 15h6" />
          </svg>
        </ToolbarButton>
        <ToolbarButton title={t('file.newFolder')} onClick={() => startCreate(activeDir(), 'dir')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <path d="M12 11v6M9 14h6" />
          </svg>
        </ToolbarButton>
        {canUndo && (
          <ToolbarButton title={t('file.undo.done')} onClick={() => void doUndo()}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
            </svg>
          </ToolbarButton>
        )}
        <ToolbarButton title={t('file.collapseAll')} onClick={collapseAll}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 9 12 3 20 9" />
            <polyline points="4 21 12 15 20 21" />
          </svg>
        </ToolbarButton>
        <ToolbarButton title={t('file.refresh')} onClick={() => void reload()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </ToolbarButton>
      </div>

      {/* Inline create row for a new entry at the workspace root */}
      {createAtRoot && (
        <CreateRow
          depth={1}
          kind={creating.kind}
          onCommit={commitCreate}
          onCancel={() => setCreating(null)}
        />
      )}

      {/* Tree rows */}
      {nodes.map((node, i) => (
        <React.Fragment key={node.entry.path}>
          <TreeRow
            node={node}
            index={i}
            isOpenInEditor={node.entry.type === 'file' && node.entry.path === selectedPath}
            isSelected={selectionSet.has(node.entry.path)}
            isFocused={anchor === node.entry.path}
            isCut={cutSet.has(node.entry.path)}
            isDropTarget={dropTarget?.row === node.entry.path}
            renaming={renaming === node.entry.path}
            onRenameCommit={(name) => commitRename(node.entry, name)}
            onRenameCancel={() => setRenaming(null)}
            onClick={(e) => handleRowClick(e, i, node)}
            onDragStart={(e) => onRowDragStart(e, node.entry)}
            onDragEnd={onRowDragEnd}
            onDragOver={(e) => dragOverDir(e, containerOf(node.entry), node.entry.path)}
            onDragLeave={() => setDropTarget((d) => (d?.row === node.entry.path ? null : d))}
            onDrop={(e) => dropOnDir(e, containerOf(node.entry))}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!selectionSet.has(node.entry.path)) selectOnly(node.entry.path)
              else setAnchor(node.entry.path)
              setMenu({ x: e.clientX, y: e.clientY, entry: node.entry })
            }}
          />
          {createParentIndex === i && creating && (
            <CreateRow
              depth={createDepth}
              kind={creating.kind}
              onCommit={commitCreate}
              onCancel={() => setCreating(null)}
            />
          )}
        </React.Fragment>
      ))}

      {/* Selection / clipboard status strip — mirrors what the shortcuts act on */}
      {(selection.length > 1 || clipboard) && (
        <div
          style={{
            position: 'sticky', bottom: 0, zIndex: 2,
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 10px', fontSize: 10.5,
            background: 'var(--bg-elevated)',
            borderTop: '1px solid var(--border-subtle)',
            color: 'var(--text-dim)',
          }}
        >
          {selection.length > 1 && <span>{t('file.selectedCount', { n: selection.length })}</span>}
          {clipboard && (
            <span style={{ color: 'var(--accent)' }}>
              {clipboard.mode === 'cut'
                ? t('file.op.cut', { n: clipboard.paths.length })
                : t('file.op.copied', { n: clipboard.paths.length })}
            </span>
          )}
          {busy && <span style={{ marginLeft: 'auto' }}>{t('file.op.working')}</span>}
        </div>
      )}

      {/* Transient success toast (copied path, imported files) */}
      {flash && (
        <div
          style={{
            position: 'sticky', bottom: 0, margin: 8, padding: '6px 10px',
            background: 'var(--bg-elevated)', border: '1px solid var(--accent)',
            borderRadius: 7, color: 'var(--accent)', fontSize: 11.5,
          }}
        >
          {flash}
        </div>
      )}

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
        <ContextMenu
          menu={menu}
          rootPath={rootPath}
          targets={targetsFor(menu.entry)}
          clipboard={clipboard}
          t={t}
          onNew={(kind) => startCreate(containerOf(menu.entry), kind)}
          onCut={(paths) => { setClipboard({ paths, mode: 'cut' }); setMenu(null); showFlash(t('file.op.cut', { n: paths.length })) }}
          onCopy={(paths) => { setClipboard({ paths, mode: 'copy' }); setMenu(null); showFlash(t('file.op.copied', { n: paths.length })) }}
          onPaste={() => doPaste(containerOf(menu.entry))}
          onDuplicate={doDuplicate}
          onRename={() => { setRenaming(menu.entry.path); setMenu(null) }}
          onPermissions={() => { setPermsFor(menu.entry); setMenu(null) }}
          onCopyPath={(text, msg) => { copyText(text, msg); setMenu(null) }}
          onOpenExternal={() => { void window.swarmmind.fsOpenPath(menu.entry.path); setMenu(null) }}
          onReveal={() => { void window.swarmmind.fsReveal(menu.entry.path); setMenu(null) }}
          onDelete={doDelete}
        />
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

// ── Header toolbar button ─────────────────────────────────────────────────────

function ToolbarButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 22, height: 22, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', borderRadius: 4, cursor: 'pointer',
        background: hovered ? 'var(--overlay-hover)' : 'transparent',
        color: hovered ? 'var(--text-primary)' : 'var(--text-muted)',
        padding: 0,
      }}
    >
      {children}
    </button>
  )
}

// ── Context menu ──────────────────────────────────────────────────────────────

function ContextMenu({
  menu,
  rootPath,
  targets,
  clipboard,
  t,
  onNew,
  onCut,
  onCopy,
  onPaste,
  onDuplicate,
  onRename,
  onPermissions,
  onCopyPath,
  onOpenExternal,
  onReveal,
  onDelete,
}: {
  menu: { x: number; y: number; entry: FsEntry }
  rootPath: string
  targets: string[]
  clipboard: FileClipboard | null
  t: TFunction
  onNew: (kind: 'file' | 'dir') => void
  onCut: (paths: string[]) => void
  onCopy: (paths: string[]) => void
  onPaste: () => void
  onDuplicate: (paths: string[]) => void
  onRename: () => void
  onPermissions: () => void
  onCopyPath: (text: string, msg: string) => void
  onOpenExternal: () => void
  onReveal: () => void
  onDelete: (paths: string[]) => void
}) {
  const { entry } = menu
  const isRoot = entry.path === rootPath
  const multi = targets.length > 1
  const pasteDir = entry.type === 'dir' ? entry.path : parentDir(entry.path)
  const canPaste = !!clipboard && (
    clipboard.mode === 'cut' ? canMoveInto(clipboard.paths, pasteDir) : canCopyInto(clipboard.paths, pasteDir)
  )
  const sep = <div style={{ height: 1, background: 'var(--border)', margin: '3px 4px' }} />

  return (
    <div
      style={{
        position: 'fixed',
        left: Math.max(4, Math.min(menu.x, window.innerWidth - 230)),
        top: Math.max(4, Math.min(menu.y, window.innerHeight - 420)),
        minWidth: 210, padding: 4, zIndex: 300,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', gap: 1,
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      <MenuItem label={t('file.newFile')} onClick={() => onNew('file')} shortcut="Ctrl+N" />
      <MenuItem label={t('file.newFolder')} onClick={() => onNew('dir')} shortcut="Ctrl+⇧+N" />
      {sep}
      <MenuItem label={t('file.cut')} shortcut="Ctrl+X" disabled={isRoot} onClick={() => onCut(targets)} />
      <MenuItem label={t('file.copy')} shortcut="Ctrl+C" disabled={isRoot} onClick={() => onCopy(targets)} />
      <MenuItem label={t('file.paste')} shortcut="Ctrl+V" disabled={!canPaste} onClick={onPaste} />
      <MenuItem label={t('file.duplicate')} shortcut="Ctrl+D" disabled={isRoot} onClick={() => onDuplicate(targets)} />
      {sep}
      <MenuItem
        label={t('file.copyPath')}
        disabled={multi}
        onClick={() => onCopyPath(entry.path, t('file.op.pathCopied'))}
      />
      <MenuItem
        label={t('file.copyRelativePath')}
        disabled={multi}
        onClick={() => onCopyPath(relativeToRoot(rootPath, entry.path), t('file.op.pathCopied'))}
      />
      {sep}
      <MenuItem label={t('file.rename')} shortcut="F2" disabled={multi || isRoot} onClick={onRename} />
      <MenuItem label={t('file.permissions')} disabled={multi || isRoot} onClick={onPermissions} />
      {sep}
      {entry.type === 'file' && !multi && (
        <MenuItem label={t('file.openExternal')} onClick={onOpenExternal} />
      )}
      <MenuItem label={t('file.revealInFolder')} disabled={multi} onClick={onReveal} />
      {sep}
      <MenuItem
        label={multi ? t('file.moveManyToTrash', { n: targets.length }) : t('file.moveToTrash')}
        shortcut="Del"
        danger
        disabled={isRoot}
        onClick={() => onDelete(targets)}
      />
    </div>
  )
}

function MenuItem({
  label,
  shortcut,
  onClick,
  disabled,
  danger,
}: {
  label: string
  shortcut?: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      className="ctx-menu-item"
      data-variant={danger ? 'danger' : undefined}
      disabled={disabled}
      onClick={() => { if (!disabled) onClick() }}
      style={disabled ? { opacity: 0.4, cursor: 'default' } : undefined}
    >
      <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
      {shortcut && <span style={{ color: 'var(--text-dim)', fontSize: 10, marginLeft: 12 }}>{shortcut}</span>}
    </button>
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
  /** The file is the one showing in the editor (distinct from tree selection). */
  isOpenInEditor: boolean
  isSelected: boolean
  isFocused: boolean
  isCut: boolean
  isDropTarget: boolean
  renaming: boolean
  onRenameCommit: (name: string) => void
  onRenameCancel: () => void
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

function TreeRow({
  node,
  index,
  isOpenInEditor,
  isSelected,
  isFocused,
  isCut,
  isDropTarget,
  renaming,
  onRenameCommit,
  onRenameCancel,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: TreeRowProps) {
  const [hovered, setHovered] = useState(false)

  const bg = isDropTarget
    ? 'var(--accent-subtle)'
    : isSelected
    ? 'var(--accent-subtle)'
    : isOpenInEditor
    ? 'var(--bg-elevated)'
    : hovered
    ? 'var(--bg-elevated)'
    : 'transparent'

  const textColor = isSelected || isOpenInEditor ? 'var(--accent)' : 'var(--text-secondary)'

  return (
    <div
      data-row-index={index}
      draggable={!renaming}
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
        // Cut entries dim until the paste lands, exactly like Explorer.
        opacity: isCut ? 0.45 : 1,
        boxShadow: isDropTarget
          ? 'inset 0 0 0 1px var(--accent)'
          : isFocused
          ? 'inset 2px 0 0 var(--accent)'
          : 'none',
        transition: 'background 80ms',
      }}
      onClick={(e) => { if (!renaming) onClick(e) }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title={renaming ? undefined : node.entry.path}
    >
      {/* Disclosure chevron. Files render it invisible rather than omitting it,
          so a file and the folder above it start at the same x — a tree whose
          leaves are inset differently from its branches reads as misaligned.
          The row's own click handler does the toggling; this is the affordance
          that tells you the row *can* be toggled, which the folder icon alone
          (open vs closed) never made obvious. */}
      <ChevronDisclosure
        open={node.entry.type === 'dir' && node.expanded}
        invisible={node.entry.type !== 'dir'}
        size={11}
        strokeWidth={2.4}
        style={{ color: 'var(--text-dim)', marginRight: -2 }}
      />
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
        <NameInput
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

// ── Inline create row ─────────────────────────────────────────────────────────
// A ghost row that only exists while you're naming a new entry, shown at the
// position the entry will occupy so the creation reads as in-place.

function CreateRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: {
  depth: number
  kind: 'file' | 'dir'
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  return (
    <div
      style={{
        height: 28,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: BASE_PADDING + depth * INDENT_STEP,
        paddingRight: 10,
        gap: 6,
        background: 'var(--bg-elevated)',
        flexShrink: 0,
        width: 'max-content',
        minWidth: '100%',
        boxSizing: 'border-box',
      }}
    >
      {/* Matches TreeRow's chevron slot so the ghost row lines up with the
          real rows it will sit between. */}
      <ChevronDisclosure open={false} invisible size={11} style={{ marginRight: -2 }} />
      {kind === 'dir' ? <FolderClosedIcon color={FOLDER_COLOR} /> : <FileIcon ext="" />}
      <NameInput initial="" isDir={kind === 'dir'} onCommit={onCommit} onCancel={onCancel} />
    </div>
  )
}

// Inline name field, used for both rename and create. Mirrors VS Code: on
// rename the basename is preselected (so the extension survives a straight
// retype), Enter commits, Escape cancels, blur commits.
function NameInput({
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
