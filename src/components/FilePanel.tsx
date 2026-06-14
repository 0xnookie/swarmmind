import React, { useCallback, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { FileExplorer, fileColor } from './FileExplorer'
import { FileEditor } from './FileEditor'
import { ImageViewer } from './ImageViewer'
import { useT } from '../i18n'

interface OpenFile {
  path: string
  name: string
  content: string
  dirty: boolean
  // Image tabs carry their decoded data instead of editable text.
  image?: ImageData
}

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

export function FilePanel() {
  const t = useT()
  const workspace = useWorkspaceStore((s) => s.workspace)

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const active = openFiles.find((f) => f.path === activePath) ?? null

  const handleFileSelect = useCallback(
    async (filePath: string, fileName: string) => {
      // Already open → just focus its tab (keeps unsaved edits).
      if (openFiles.some((f) => f.path === filePath)) {
        setActivePath(filePath)
        return
      }
      setLoading(true)
      try {
        if (isImageName(fileName)) {
          const image = await window.swarmmind.fsReadImage(filePath)
          setOpenFiles((prev) => [...prev, { path: filePath, name: fileName, content: '', dirty: false, image }])
        } else {
          const text = await window.swarmmind.fsReadFile(filePath)
          setOpenFiles((prev) => [...prev, { path: filePath, name: fileName, content: text, dirty: false }])
        }
        setActivePath(filePath)
      } catch (err) {
        console.error('Failed to read file:', err)
      } finally {
        setLoading(false)
      }
    },
    [openFiles]
  )

  const handleChange = useCallback(
    (newContent: string) => {
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === activePath ? { ...f, content: newContent, dirty: true } : f))
      )
    },
    [activePath]
  )

  const handleSave = useCallback(async () => {
    const file = openFiles.find((f) => f.path === activePath)
    if (!file || !file.dirty) return
    try {
      await window.swarmmind.fsWriteFile(file.path, file.content)
      setOpenFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, dirty: false } : f)))
    } catch (err) {
      console.error('Failed to save file:', err)
    }
  }, [openFiles, activePath])

  const closeTab = useCallback(
    (path: string) => {
      const file = openFiles.find((f) => f.path === path)
      if (!file) return
      if (file.dirty) {
        const ok = window.confirm(t('file.discardConfirm'))
        if (!ok) return
      }
      setOpenFiles((prev) => {
        const idx = prev.findIndex((f) => f.path === path)
        const next = prev.filter((f) => f.path !== path)
        if (path === activePath) {
          const neighbor = next[Math.min(idx, next.length - 1)] ?? null
          setActivePath(neighbor ? neighbor.path : null)
        }
        return next
      })
    },
    [openFiles, activePath, t]
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
      {/* Left: file tree */}
      <div
        style={{
          width: 240,
          flexShrink: 0,
          background: 'var(--bg-panel)',
          borderRight: '1px solid var(--border-subtle)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <FileExplorer
          rootPath={workspace.rootPath}
          onFileSelect={handleFileSelect}
          selectedPath={activePath}
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
