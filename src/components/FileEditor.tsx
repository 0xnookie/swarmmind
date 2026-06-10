import React, { useMemo } from 'react'
import { useT } from '../i18n'
import ReactCodeMirror from '@uiw/react-codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import type { Extension } from '@codemirror/state'

export interface FileEditorProps {
  filePath: string | null
  fileName: string | null
  content: string
  isDirty: boolean
  onChange: (newContent: string) => void
  onSave: () => void
}

function getLanguageExtension(fileName: string | null): Extension[] {
  if (!fileName) return []
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    return [javascript({ typescript: true, jsx: true })]
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) {
    return [javascript({ jsx: true })]
  }
  if (lower.endsWith('.css')) return [css()]
  if (lower.endsWith('.html')) return [html()]
  if (lower.endsWith('.py')) return [python()]
  if (lower.endsWith('.json')) return [json()]
  return []
}

export function FileEditor({
  filePath,
  fileName,
  content,
  isDirty,
  onChange,
  onSave,
}: FileEditorProps) {
  const t = useT()
  const extensions = useMemo(() => getLanguageExtension(fileName), [fileName])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      if (isDirty) onSave()
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg-base)',
        overflow: 'hidden',
      }}
      onKeyDown={handleKeyDown}
    >
      {/* Header bar */}
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 12,
          paddingRight: 8,
          gap: 6,
          background: 'var(--bg-panel)',
          borderBottom: '1px solid var(--border-subtle)',
          userSelect: 'none',
        }}
      >
        {/* Filename */}
        <span
          style={{
            flex: 1,
            fontSize: 13,
            color: fileName ? 'var(--text-secondary)' : 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {fileName ?? t('file.noFileOpen')}
        </span>

        {/* Unsaved dot */}
        {isDirty && (
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#fb923c',
              flexShrink: 0,
            }}
            title={t('file.unsavedTitle')}
          />
        )}

        {/* Save button */}
        <button
          onClick={onSave}
          disabled={!isDirty}
          style={{
            height: 22,
            padding: '0 8px',
            fontSize: 11,
            fontWeight: 500,
            border: 'none',
            borderRadius: 4,
            cursor: isDirty ? 'pointer' : 'not-allowed',
            background: isDirty ? 'var(--accent)' : 'var(--bg-elevated)',
            color: isDirty ? '#0d0d0d' : 'var(--text-muted)',
            flexShrink: 0,
            transition: 'background 150ms, color 150ms',
          }}
        >
          {t('common.save')}
        </button>
      </div>

      {/* Editor area */}
      {filePath === null ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: 13,
          }}
        >
          {t('file.selectToEdit')}
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <style>{`
            .cm-editor {
              height: 100% !important;
              font-size: 13.5px !important;
              -webkit-font-smoothing: antialiased;
              text-rendering: optimizeLegibility;
            }
            .cm-editor .cm-scroller {
              overflow: auto !important;
              font-family: var(--font-editor) !important;
              font-feature-settings: 'liga' 1, 'calt' 1;
              font-variant-ligatures: contextual;
              line-height: 1.6 !important;
            }
          `}</style>
          <ReactCodeMirror
            value={content}
            theme={oneDark}
            extensions={extensions}
            onChange={onChange}
            height="100%"
            style={{ flex: 1, overflow: 'hidden' }}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              dropCursor: false,
              allowMultipleSelections: false,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              rectangularSelection: false,
              crosshairCursor: false,
              highlightActiveLine: true,
              highlightSelectionMatches: false,
              closeBracketsKeymap: true,
              searchKeymap: true,
            }}
          />
        </div>
      )}
    </div>
  )
}
