import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useWorkspaceStore } from '../store/workspace'
import ReactCodeMirror, { type ViewUpdate } from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { editorTheme } from '../editor/theme'
import { loadLanguage, languageName } from '../editor/languages'

export interface FileEditorProps {
  filePath: string | null
  fileName: string | null
  /** Path relative to the workspace root, for the status-bar breadcrumb. */
  relPath: string | null
  content: string
  isDirty: boolean
  onChange: (newContent: string) => void
  onSave: () => void
}

interface CursorInfo {
  line: number
  col: number
  selected: number
  cursors: number
}

// Static (per-mount) extensions: VS Code-style Alt+Click adds a cursor,
// indent guides match the theme's border colours.
const staticExtensions: Extension[] = [
  editorTheme,
  EditorView.clickAddsSelectionRange.of((e) => e.altKey),
  indentationMarkers({
    hideFirstIndent: true,
    highlightActiveBlock: true,
    thickness: 1,
    colors: {
      light: 'var(--border)',
      dark: 'var(--border)',
      activeLight: 'var(--border-active)',
      activeDark: 'var(--border-active)',
    },
  }),
]

export function FileEditor({
  filePath,
  fileName,
  relPath,
  content,
  isDirty,
  onChange,
  onSave,
}: FileEditorProps) {
  const t = useT()
  const [langExt, setLangExt] = useState<Extension | null>(null)
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, col: 1, selected: 0, cursors: 1 })
  const editorWrapRef = useRef<HTMLDivElement>(null)
  const setEditorFontSize = useWorkspaceStore((s) => s.setEditorFontSize)

  // Ctrl+scroll zooms the editor font, like VS Code. Needs a native non-passive
  // listener — React's onWheel is passive, so preventDefault would be ignored.
  useEffect(() => {
    const el = editorWrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const current = useWorkspaceStore.getState().editorFontSize
      setEditorFontSize(current + (e.deltaY < 0 ? 1 : -1))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setEditorFontSize])

  const langName = useMemo(() => (fileName ? languageName(fileName) : null), [fileName])

  // Lazily import the parser for the open file's language.
  useEffect(() => {
    let cancelled = false
    setLangExt(null)
    if (!fileName) return
    loadLanguage(fileName).then((ext) => {
      if (!cancelled) setLangExt(ext)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, fileName])

  const extensions = useMemo(
    () => [...staticExtensions, ...(langExt ? [langExt] : [])],
    [langExt]
  )

  const handleUpdate = (vu: ViewUpdate) => {
    if (!vu.selectionSet && !vu.docChanged) return
    const sel = vu.state.selection
    const main = sel.main
    const line = vu.state.doc.lineAt(main.head)
    let selected = 0
    for (const r of sel.ranges) selected += r.to - r.from
    setCursor({
      line: line.number,
      col: main.head - line.from + 1,
      selected,
      cursors: sel.ranges.length,
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      if (isDirty) onSave()
    }
  }

  if (filePath === null) {
    return (
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
        {t('file.selectToEdit')}
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--bg-base)',
        overflow: 'hidden',
      }}
      onKeyDown={handleKeyDown}
    >
      {/* Editor */}
      <div ref={editorWrapRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <ReactCodeMirror
          value={content}
          theme="none"
          extensions={extensions}
          onChange={onChange}
          onUpdate={handleUpdate}
          height="100%"
          style={{ height: '100%' }}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            dropCursor: true,
            allowMultipleSelections: true,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            rectangularSelection: true,
            crosshairCursor: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            highlightSelectionMatches: true,
            closeBracketsKeymap: true,
            searchKeymap: true,
          }}
        />
      </div>

      {/* Status bar */}
      <div
        style={{
          height: 24,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px',
          gap: 14,
          background: 'var(--bg-panel)',
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 11,
          color: 'var(--text-muted)',
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {/* Breadcrumb */}
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'var(--text-muted)',
          }}
          title={filePath}
        >
          {(relPath ?? fileName ?? '').split(/[\\/]/).join('  ›  ')}
        </span>

        {cursor.cursors > 1 ? (
          <span>{t('file.multiCursor', { n: String(cursor.cursors) })}</span>
        ) : (
          <span>
            {t('file.lnCol', { ln: String(cursor.line), col: String(cursor.col) })}
            {cursor.selected > 0 && ` (${t('file.selected', { n: String(cursor.selected) })})`}
          </span>
        )}

        <span>{langName ?? t('file.plainText')}</span>

        <button
          onClick={onSave}
          disabled={!isDirty}
          style={{
            height: 18,
            padding: '0 8px',
            fontSize: 10.5,
            fontWeight: 600,
            border: 'none',
            borderRadius: 3,
            cursor: isDirty ? 'pointer' : 'default',
            background: isDirty ? 'var(--accent)' : 'transparent',
            color: isDirty ? 'var(--accent-fg)' : 'var(--text-dim)',
            transition: 'background 150ms, color 150ms',
          }}
          title="Ctrl+S"
        >
          {isDirty ? t('common.save') : t('common.saved')}
        </button>
      </div>
    </div>
  )
}
