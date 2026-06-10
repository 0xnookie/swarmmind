import React, { useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { FileExplorer } from './FileExplorer'
import { FileEditor } from './FileEditor'
import { useT } from '../i18n'

export function FilePanel() {
  const t = useT()
  const workspace = useWorkspaceStore((s) => s.workspace)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')
  const [isDirty, setIsDirty] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleFileSelect = async (filePath: string, fileName: string) => {
    if (isDirty) {
      const ok = window.confirm(t('file.discardConfirm'))
      if (!ok) return
    }
    setLoading(true)
    try {
      const text = await window.swarmmind.fsReadFile(filePath)
      setContent(text)
      setSelectedPath(filePath)
      setSelectedName(fileName)
      setIsDirty(false)
    } catch (err) {
      console.error('Failed to read file:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleChange = (newContent: string) => {
    setContent(newContent)
    setIsDirty(true)
  }

  const handleSave = async () => {
    if (!selectedPath) return
    try {
      await window.swarmmind.fsWriteFile(selectedPath, content)
      setIsDirty(false)
    } catch (err) {
      console.error('Failed to save file:', err)
    }
  }

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
          selectedPath={selectedPath}
        />
      </div>

      {/* Right: editor */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
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
        ) : (
          <FileEditor
            filePath={selectedPath}
            fileName={selectedName}
            content={content}
            isDirty={isDirty}
            onChange={handleChange}
            onSave={handleSave}
          />
        )}
      </div>
    </div>
  )
}
