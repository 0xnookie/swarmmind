import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'

interface Command {
  id: string
  title: string
  section: string
  run: () => void
}

interface RemoteWorkspace { id: string; name: string; root_path: string }

export function CommandPalette() {
  const open = useWorkspaceStore(s => s.commandPaletteOpen)
  const setOpen = useWorkspaceStore(s => s.setCommandPaletteOpen)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery(''); setIndex(0)
    window.swarmmind.workspaceList().then(l => { if (Array.isArray(l)) setWorkspaces(l as RemoteWorkspace[]) }).catch(() => {})
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  const commands = useMemo<Command[]>(() => {
    if (!open) return []
    const s = useWorkspaceStore.getState()
    const close = () => setOpen(false)
    const list: Command[] = [
      { id: 'new-pane', title: 'New pane', section: 'Panes', run: () => { s.addPane(); close() } },
      { id: 'broadcast', title: 'Toggle broadcast bar', section: 'View', run: () => { s.toggleBroadcastBar(); close() } },
      { id: 'preview', title: 'Toggle preview browser', section: 'View', run: () => { s.togglePreviewPanel(); close() } },
      { id: 'memory', title: 'Toggle memory / skills panel', section: 'View', run: () => { s.toggleMemoryPanel(); close() } },
      { id: 'code', title: 'Toggle code / file view', section: 'View', run: () => { s.toggleFilePanel(); close() } },
      { id: 'board', title: 'Toggle Kanban board', section: 'View', run: () => { s.toggleBoard(); close() } },
      { id: 'graph', title: 'Toggle memory graph', section: 'View', run: () => { s.toggleGraph(); close() } },
      { id: 'sidebar', title: 'Toggle workspace sidebar', section: 'View', run: () => { s.toggleKanban(); close() } },
      { id: 'new-workspace', title: 'New workspace…', section: 'Workspace', run: () => { s.openSetupModal(); close() } },
      { id: 'settings', title: 'Open settings', section: 'Workspace', run: () => { s.openSettings(); close() } },
    ]
    // Focus pane N
    s.getLeafIds().forEach((id, i) => {
      list.push({ id: `focus-${id}`, title: `Focus pane ${i + 1}`, section: 'Panes', run: () => { s.setActivePaneId(id); close() } })
    })
    // Switch workspace
    for (const ws of workspaces) {
      if (ws.id === s.workspace?.id) continue
      list.push({
        id: `ws-${ws.id}`,
        title: `Switch to: ${ws.name}`,
        section: 'Workspace',
        run: async () => {
          close()
          const info = await window.swarmmind.workspaceOpenById(ws.id)
          if (info && !info.error) {
            useWorkspaceStore.getState().setWorkspace({ id: info.id, name: info.name, rootPath: info.rootPath })
            if (info.savedLayout) useWorkspaceStore.getState().loadFromJson(info.savedLayout)
            else useWorkspaceStore.getState().resetLayout()
          }
        },
      })
    }
    return list
  }, [open, workspaces, setOpen])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter(c => c.title.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => { setIndex(0) }, [query])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(filtered.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[index]?.run() }
  }

  return (
    <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div style={styles.card} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          style={styles.input}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Type a command…"
          spellCheck={false}
        />
        <div style={styles.list}>
          {filtered.length === 0 && <div style={styles.empty}>No commands</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              style={{ ...styles.row, ...(i === index ? styles.rowActive : {}) }}
              onMouseEnter={() => setIndex(i)}
              onClick={() => c.run()}
            >
              <span style={styles.rowTitle}>{c.title}</span>
              <span style={styles.rowSection}>{c.section}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh', zIndex: 700 },
  card: { width: 540, maxWidth: '90vw', background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow-lg)', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  input: { border: 'none', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 15, padding: '14px 16px', outline: 'none' },
  list: { maxHeight: '50vh', overflowY: 'auto', padding: 6 },
  empty: { padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'transparent', border: 'none', borderRadius: 8, padding: '9px 12px', cursor: 'pointer', textAlign: 'left' },
  rowActive: { background: 'var(--accent-subtle)' },
  rowTitle: { fontSize: 13.5, color: 'var(--text-primary)' },
  rowSection: { fontSize: 10.5, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' },
}
