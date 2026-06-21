import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore, type EditorTab } from '../store/workspace'
import { FileExplorer, fileColor } from './FileExplorer'
import { FileEditor } from './FileEditor'
import { ImageViewer } from './ImageViewer'
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
    (path: string) => {
      const tabs = useWorkspaceStore.getState().editorTabs
      const file = tabs.find((f) => f.path === path)
      if (!file) return
      if (file.dirty) {
        const ok = window.confirm(t('file.discardConfirm'))
        if (!ok) return
      }
      const idx = tabs.findIndex((f) => f.path === path)
      const next = tabs.filter((f) => f.path !== path)
      setOpenFiles(next)
      if (path === useWorkspaceStore.getState().activeEditorPath) {
        const neighbor = next[Math.min(idx, next.length - 1)] ?? null
        setActivePath(neighbor ? neighbor.path : null)
      }
    },
    [t, setOpenFiles, setActivePath]
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
            className="editor-tabbar"
            style={{
              height: 34,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'stretch',
              background: 'var(--bg-panel)',
              borderBottom: '1px solid var(--border-subtle)',
              overflowX: 'auto',
              overflowY: 'hidden',
              userSelect: 'none',
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
              />
            ))}
          </div>
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

// ── Tab ───────────────────────────────────────────────────────────────────────

interface EditorTabProps {
  file: OpenFile
  isActive: boolean
  onActivate: () => void
  onClose: () => void
  closeTitle: string
}

function EditorTab({ file, isActive, onActivate, onClose, closeTitle }: EditorTabProps) {
  const [hovered, setHovered] = useState(false)
  const [closeHovered, setCloseHovered] = useState(false)

  return (
    <div
      onClick={onActivate}
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
