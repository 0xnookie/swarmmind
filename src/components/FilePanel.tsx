import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore, type EditorTab } from '../store/workspace'
import { FileExplorer, fileColor } from './FileExplorer'
import { FileEditor } from './FileEditor'
import { ImageViewer } from './ImageViewer'
import { confirmDialog } from './ConfirmDialog'
import { useT } from '../i18n'

// Open editor tabs live in the store (see EditorTab) so unsaved edits survive
// toggling the editor away and back; this is just a local alias.
type OpenFile = EditorTab

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

// Raster image formats open in the viewer; SVG stays in the text editor (it's
// editable markup and gets syntax highlighting).
const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
])

function isImageName(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name))
}

function relativeTo(root: string, filePath: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const f = norm(filePath)
  return f.toLowerCase().startsWith(r.toLowerCase() + '/') ? f.slice(r.length + 1) : f
}

// File-tree sidebar width is user-resizable and remembered between sessions.
const TREE_WIDTH_KEY = 'swarmmind.fileTreeWidth'
const TREE_MIN_WIDTH = 180
const TREE_MAX_WIDTH = 600
const TREE_DEFAULT_WIDTH = 240

function clampTreeWidth(w: number): number {
  return Math.max(TREE_MIN_WIDTH, Math.min(TREE_MAX_WIDTH, w))
}

export function FilePanel() {
  const t = useT()
  const workspace = useWorkspaceStore((s) => s.workspace)

  // Editor tabs are held in the store so unsaved edits survive toggling the
  // editor away (this panel unmounts when another center view opens).
  const openFiles = useWorkspaceStore((s) => s.editorTabs)
  const activePath = useWorkspaceStore((s) => s.activeEditorPath)
  const setOpenFiles = useWorkspaceStore((s) => s.setEditorTabs)
  const setActivePath = useWorkspaceStore((s) => s.setActiveEditorPath)
  const [loading, setLoading] = useState(false)
  // Tab bulk-actions menu. `path: null` = opened from the ⋯ button (whole bar);
  // a path = right-clicked that specific tab, which unlocks "close others".
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string | null } | null>(null)

  // Resizable file-tree width (drag the divider; persisted to localStorage).
  const [treeWidth, setTreeWidth] = useState(() => {
    const stored = Number(localStorage.getItem(TREE_WIDTH_KEY))
    return stored ? clampTreeWidth(stored) : TREE_DEFAULT_WIDTH
  })
  const [resizing, setResizing] = useState(false)
  const resizeStart = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      if (!resizeStart.current) return
      const delta = e.clientX - resizeStart.current.x
      setTreeWidth(clampTreeWidth(resizeStart.current.width + delta))
    }
    const onUp = () => {
      setResizing(false)
      resizeStart.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing])

  useEffect(() => {
    localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth))
  }, [treeWidth])

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      resizeStart.current = { x: e.clientX, width: treeWidth }
      setResizing(true)
    },
    [treeWidth]
  )

  const active = openFiles.find((f) => f.path === activePath) ?? null

  const handleFileSelect = useCallback(
    async (filePath: string, fileName: string) => {
      // Already open → just focus its tab (keeps unsaved edits).
      if (useWorkspaceStore.getState().editorTabs.some((f) => f.path === filePath)) {
        setActivePath(filePath)
        return
      }
      setLoading(true)
      try {
        const tab: OpenFile = isImageName(fileName)
          ? { path: filePath, name: fileName, content: '', dirty: false, image: await window.swarmmind.fsReadImage(filePath) }
          : { path: filePath, name: fileName, content: await window.swarmmind.fsReadFile(filePath), dirty: false }
        setOpenFiles([...useWorkspaceStore.getState().editorTabs, tab])
        setActivePath(filePath)
      } catch (err) {
        console.error('Failed to read file:', err)
      } finally {
        setLoading(false)
      }
    },
    [setOpenFiles, setActivePath]
  )

  // Terminal→editor bridge: an openFileAtLine() request lands here as a one-shot
  // seed. Open (or focus) the tab; FileEditor scrolls to the line and clears the
  // seed. Images can't scroll to a line, so clear the seed for them here.
  const editorReveal = useWorkspaceStore((s) => s.editorReveal)
  useEffect(() => {
    if (!editorReveal) return
    const name = editorReveal.path.split(/[\\/]/).pop() ?? editorReveal.path
    handleFileSelect(editorReveal.path, name).then(() => {
      const opened = useWorkspaceStore.getState().editorTabs.some((f) => f.path === editorReveal.path)
      // Failed reads and images can't scroll to a line — drop the seed so it
      // doesn't fire against a later manually-opened file.
      if (!opened || isImageName(name)) useWorkspaceStore.getState().clearEditorReveal()
    })
  }, [editorReveal, handleFileSelect])

  const handleChange = useCallback(
    (newContent: string) => {
      const path = useWorkspaceStore.getState().activeEditorPath
      setOpenFiles(
        useWorkspaceStore.getState().editorTabs.map((f) =>
          f.path === path ? { ...f, content: newContent, dirty: true } : f
        )
      )
    },
    [setOpenFiles]
  )

  const handleSave = useCallback(async () => {
    const path = useWorkspaceStore.getState().activeEditorPath
    const file = useWorkspaceStore.getState().editorTabs.find((f) => f.path === path)
    if (!file || !file.dirty) return
    try {
      await window.swarmmind.fsWriteFile(file.path, file.content)
      setOpenFiles(
        useWorkspaceStore.getState().editorTabs.map((f) => (f.path === file.path ? { ...f, dirty: false } : f))
      )
    } catch (err) {
      console.error('Failed to save file:', err)
    }
  }, [setOpenFiles])

  const handleSaveAll = useCallback(async () => {
    // Snapshot the dirty files, write them, then clear `dirty` only for tabs whose
    // content still matches what we saved (so a concurrent edit during the awaits
    // isn't marked clean).
    const dirty = useWorkspaceStore.getState().editorTabs.filter((f) => f.dirty && !f.image)
    if (!dirty.length) return
    const saved = new Map<string, string>()
    for (const f of dirty) {
      try {
        await window.swarmmind.fsWriteFile(f.path, f.content)
        saved.set(f.path, f.content)
      } catch (err) {
        console.error('Failed to save file:', err)
      }
    }
    setOpenFiles(
      useWorkspaceStore.getState().editorTabs.map((f) =>
        saved.get(f.path) === f.content ? { ...f, dirty: false } : f
      )
    )
  }, [setOpenFiles])

  const closeTab = useCallback(
    async (path: string) => {
      const file = useWorkspaceStore.getState().editorTabs.find((f) => f.path === path)
      if (!file) return
      if (file.dirty) {
        const ok = await confirmDialog({
          title: file.name,
          body: t('file.discardConfirm'),
          confirmLabel: t('common.discard'),
          danger: true,
        })
        if (!ok) return
      }
      // Re-read: the tab list may have changed while the dialog was open.
      const tabs = useWorkspaceStore.getState().editorTabs
      const idx = tabs.findIndex((f) => f.path === path)
      if (idx < 0) return
      const next = tabs.filter((f) => f.path !== path)
      setOpenFiles(next)
      if (path === useWorkspaceStore.getState().activeEditorPath) {
        const neighbor = next[Math.min(idx, next.length - 1)] ?? null
        setActivePath(neighbor ? neighbor.path : null)
      }
      // The tab is truly gone — NOW the language service may drop its overlay
      // (and the file's program-root slot). This must not happen on a mere file
      // switch: every open tab has to stay in the program, or cross-file queries
      // (find-references, exact rename) go blind to files that import this one.
      void window.swarmmind.lspClose(path)
    },
    [t, setOpenFiles, setActivePath]
  )

  // Close a whole set of tabs in one action (close all / close others / close
  // saved). Dirty tabs are confirmed *once* for the batch rather than one
  // dialog per file — the whole point of a bulk close.
  const closeTabs = useCallback(
    async (victims: OpenFile[]) => {
      if (!victims.length) return
      const dirty = victims.filter((f) => f.dirty)
      if (dirty.length) {
        const ok = await confirmDialog({
          title: t('file.closeAllTitle'),
          body: t('file.discardManyConfirm', { n: dirty.length }) + '\n\n' +
            dirty.map((f) => `• ${f.name}`).join('\n'),
          confirmLabel: t('common.discard'),
          danger: true,
        })
        if (!ok) return
      }
      const doomed = new Set(victims.map((f) => f.path))
      // Re-read: the dialog was async, so the tab list may have moved on.
      const tabs = useWorkspaceStore.getState().editorTabs
      const next = tabs.filter((f) => !doomed.has(f.path))
      setOpenFiles(next)
      const activeNow = useWorkspaceStore.getState().activeEditorPath
      if (activeNow && doomed.has(activeNow)) {
        setActivePath(next.length ? next[next.length - 1].path : null)
      }
      // Same program-root rule as closeTab: only released once truly closed.
      for (const p of doomed) void window.swarmmind.lspClose(p)
    },
    [t, setOpenFiles, setActivePath]
  )

  // ── React to file-tree mutations ────────────────────────────────────────────
  // A rename/delete in the explorer must not leave a tab pointing at a path that
  // no longer exists — saving such a tab would recreate the old file.

  const handleFileRenamed = useCallback(
    (oldPath: string, newPath: string, newName: string) => {
      const sep = oldPath.includes('\\') ? '\\' : '/'
      const dirPrefix = oldPath + sep
      setOpenFiles(
        useWorkspaceStore.getState().editorTabs.map((f) => {
          if (f.path === oldPath) return { ...f, path: newPath, name: newName }
          // A renamed *directory* moves every tab beneath it.
          if (f.path.startsWith(dirPrefix)) {
            return { ...f, path: newPath + sep + f.path.slice(dirPrefix.length) }
          }
          return f
        })
      )
      const active = useWorkspaceStore.getState().activeEditorPath
      if (active === oldPath) setActivePath(newPath)
      else if (active?.startsWith(dirPrefix)) setActivePath(newPath + sep + active.slice(dirPrefix.length))
      // The old path is gone from disk — drop it as a program root.
      void window.swarmmind.lspClose(oldPath)
    },
    [setOpenFiles, setActivePath]
  )

  const handleFileDeleted = useCallback(
    (deletedPath: string) => {
      const sep = deletedPath.includes('\\') ? '\\' : '/'
      const dirPrefix = deletedPath + sep
      const tabs = useWorkspaceStore.getState().editorTabs
      const gone = tabs.filter((f) => f.path === deletedPath || f.path.startsWith(dirPrefix))
      if (!gone.length) return
      const goneSet = new Set(gone.map((f) => f.path))
      const next = tabs.filter((f) => !goneSet.has(f.path))
      // No discard prompt: the file is already in the trash, so there is nothing
      // left to save the buffer back to.
      setOpenFiles(next)
      const active = useWorkspaceStore.getState().activeEditorPath
      if (active && goneSet.has(active)) setActivePath(next.length ? next[next.length - 1].path : null)
      for (const p of goneSet) void window.swarmmind.lspClose(p)
    },
    [setOpenFiles, setActivePath]
  )

  if (!workspace?.rootPath) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: 14,
          background: 'var(--bg-base)',
        }}
      >
        {t('file.openFirst')}
      </div>
    )
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'row',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Left: file tree (resizable) */}
      <div
        style={{
          width: treeWidth,
          flexShrink: 0,
          background: 'var(--bg-panel)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        <FileExplorer
          rootPath={workspace.rootPath}
          onFileSelect={handleFileSelect}
          selectedPath={activePath}
          onFileRenamed={handleFileRenamed}
          onFileDeleted={handleFileDeleted}
        />
        {/* Drag handle: widen the tree so deep paths stay readable */}
        <div
          onMouseDown={startResize}
          title="Drag to resize"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 6,
            height: '100%',
            cursor: 'col-resize',
            background: resizing ? 'var(--accent)' : 'var(--border-subtle)',
            transition: resizing ? 'none' : 'background 120ms',
            zIndex: 2,
          }}
          onMouseEnter={(e) => {
            if (!resizing) e.currentTarget.style.background = 'var(--accent)'
          }}
          onMouseLeave={(e) => {
            if (!resizing) e.currentTarget.style.background = 'var(--border-subtle)'
          }}
        />
      </div>

      {/* Right: tabs + editor */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        {openFiles.length > 0 && (
          <div
            style={{
              height: 34,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'stretch',
              background: 'var(--bg-panel)',
              borderBottom: '1px solid var(--border-subtle)',
              userSelect: 'none',
            }}
          >
            <div
              className="editor-tabbar"
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'stretch',
                overflowX: 'auto',
                overflowY: 'hidden',
              }}
            >
              {openFiles.map((f) => (
                <EditorTab
                  key={f.path}
                  file={f}
                  isActive={f.path === activePath}
                  onActivate={() => setActivePath(f.path)}
                  onClose={() => closeTab(f.path)}
                  closeTitle={t('common.close')}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setTabMenu({ x: e.clientX, y: e.clientY, path: f.path })
                  }}
                />
              ))}
            </div>

            {/* Bulk-close control — pinned right so it stays reachable no
                matter how far the tab strip has scrolled. */}
            <button
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setTabMenu({ x: r.right, y: r.bottom, path: null })
              }}
              title={t('file.closeAll')}
              style={{
                flexShrink: 0,
                width: 34,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                borderLeft: '1px solid var(--border-subtle)',
                background: 'transparent',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: 13,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              ⋯
            </button>
          </div>
        )}

        {tabMenu && (
          <TabMenu
            x={tabMenu.x}
            y={tabMenu.y}
            path={tabMenu.path}
            tabs={openFiles}
            onClose={() => setTabMenu(null)}
            onCloseTabs={closeTabs}
            onCloseOne={closeTab}
            t={t}
          />
        )}

        {loading ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              fontSize: 13,
              background: 'var(--bg-base)',
            }}
          >
            {t('common.loading')}
          </div>
        ) : active?.image ? (
          <ImageViewer
            key={active.path}
            filePath={active.path}
            fileName={active.name}
            relPath={relativeTo(workspace.rootPath, active.path)}
            dataUrl={active.image.dataUrl}
            mime={active.image.mime}
            size={active.image.size}
            mtimeMs={active.image.mtimeMs}
          />
        ) : (
          <FileEditor
            key={active?.path ?? 'empty'}
            filePath={active?.path ?? null}
            fileName={active?.name ?? null}
            relPath={active ? relativeTo(workspace.rootPath, active.path) : null}
            content={active?.content ?? ''}
            isDirty={active?.dirty ?? false}
            onChange={handleChange}
            onSave={handleSave}
            dirtyCount={openFiles.filter((f) => f.dirty).length}
            onSaveAll={handleSaveAll}
          />
        )}
      </div>
    </div>
  )
}

// ── Tab bulk-actions menu ─────────────────────────────────────────────────────

function TabMenu({
  x,
  y,
  path,
  tabs,
  onClose,
  onCloseTabs,
  onCloseOne,
  t,
}: {
  x: number
  y: number
  path: string | null
  tabs: OpenFile[]
  onClose: () => void
  onCloseTabs: (victims: OpenFile[]) => void
  onCloseOne: (path: string) => void
  t: (k: any, p?: any) => string
}) {
  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // Deferred so the click that opened the menu doesn't immediately shut it.
    const id = setTimeout(() => window.addEventListener('click', close), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(id)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const others = path ? tabs.filter((f) => f.path !== path) : []
  const saved = tabs.filter((f) => !f.dirty)

  const run = (fn: () => void) => { fn(); onClose() }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: Math.min(x, window.innerWidth - 210),
        top: Math.min(y, window.innerHeight - 160),
        minWidth: 196, padding: 4, zIndex: 300,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', gap: 1,
      }}
    >
      {path && (
        <button className="ctx-menu-item" onClick={() => run(() => onCloseOne(path))}>
          {t('common.close')}
        </button>
      )}
      {path && (
        <button
          className="ctx-menu-item"
          disabled={!others.length}
          style={others.length ? undefined : { opacity: 0.45, cursor: 'default' }}
          onClick={() => others.length && run(() => onCloseTabs(others))}
        >
          {t('file.closeOthers')}
        </button>
      )}
      <button
        className="ctx-menu-item"
        disabled={!saved.length}
        style={saved.length ? undefined : { opacity: 0.45, cursor: 'default' }}
        onClick={() => saved.length && run(() => onCloseTabs(saved))}
      >
        {t('file.closeSaved')}
      </button>
      <div style={{ height: 1, background: 'var(--border)', margin: '3px 4px' }} />
      <button className="ctx-menu-item" onClick={() => run(() => onCloseTabs(tabs))}>
        <span style={{ flex: 1, textAlign: 'left' }}>{t('file.closeAll')}</span>
        <span style={{ color: 'var(--text-dim)', fontSize: 10.5 }}>{tabs.length}</span>
      </button>
    </div>
  )
}

// ── Tab ───────────────────────────────────────────────────────────────────────

interface EditorTabProps {
  file: OpenFile
  isActive: boolean
  onActivate: () => void
  onClose: () => void
  closeTitle: string
  onContextMenu: (e: React.MouseEvent) => void
}

function EditorTab({ file, isActive, onActivate, onClose, closeTitle, onContextMenu }: EditorTabProps) {
  const [hovered, setHovered] = useState(false)
  const [closeHovered, setCloseHovered] = useState(false)

  return (
    <div
      onClick={onActivate}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(e) => {
        // Middle-click closes, like VS Code.
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      title={file.path}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 8px 0 12px',
        maxWidth: 200,
        cursor: 'pointer',
        background: isActive ? 'var(--bg-base)' : hovered ? 'var(--bg-elevated)' : 'transparent',
        color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
        borderRight: '1px solid var(--border-subtle)',
        boxShadow: isActive ? 'inset 0 2px 0 var(--accent)' : 'none',
        fontSize: 12.5,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        transition: 'background 80ms, color 80ms',
      }}
    >
      {/* File-type dot */}
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 2,
          background: fileColor(extOf(file.name)),
          flexShrink: 0,
          opacity: isActive ? 1 : 0.6,
        }}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</span>

      {/* Close button / dirty dot (dirty dot turns into × on hover, like VS Code) */}
      <span
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        onMouseEnter={() => setCloseHovered(true)}
        onMouseLeave={() => setCloseHovered(false)}
        title={closeTitle}
        style={{
          width: 16,
          height: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 3,
          flexShrink: 0,
          fontSize: 13,
          lineHeight: 1,
          color: closeHovered ? 'var(--text-primary)' : 'var(--text-muted)',
          background: closeHovered ? 'var(--overlay-hover)' : 'transparent',
          visibility: file.dirty || isActive || hovered ? 'visible' : 'hidden',
        }}
      >
        {file.dirty && !closeHovered && !hovered ? (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--accent)',
              display: 'block',
            }}
          />
        ) : (
          '×'
        )}
      </span>
    </div>
  )
}
