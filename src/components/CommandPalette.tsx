import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { useT } from '../i18n'
import { getEffectiveKeys, formatKeys } from '../shortcuts'

interface Command {
  id: string
  title: string
  section: string
  run: () => void
}

interface RemoteWorkspace { id: string; name: string; root_path: string }

export function CommandPalette() {
  const t = useT()
  const open = useWorkspaceStore(s => s.commandPaletteOpen)
  const setOpen = useWorkspaceStore(s => s.setCommandPaletteOpen)
  const keybindings = useWorkspaceStore(s => s.keybindings)
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
      { id: 'new-pane', title: t('cmd.newPane'), section: t('cmd.section.panes'), run: () => { s.addPane(); close() } },
      // Broadcast renders inside the terminal grid, so surface the panes first
      // (close any overlay), then ensure the bar is open.
      { id: 'broadcast', title: t('cmd.broadcast'), section: t('cmd.section.view'), run: () => { s.showTerminals(); if (!s.broadcastBarOpen) s.toggleBroadcastBar(); close() } },
      { id: 'preview', title: t('cmd.preview'), section: t('cmd.section.view'), run: () => { s.togglePreviewPanel(); close() } },
      { id: 'memory', title: t('cmd.memory'), section: t('cmd.section.view'), run: () => { s.toggleMemoryPanel(); close() } },
      { id: 'code', title: t('cmd.code'), section: t('cmd.section.view'), run: () => { s.toggleFilePanel(); close() } },
      { id: 'board', title: t('cmd.board'), section: t('cmd.section.view'), run: () => { s.toggleBoard(); close() } },
      { id: 'graph', title: t('cmd.graph'), section: t('cmd.section.view'), run: () => { s.toggleGraph(); close() } },
      { id: 'swarm-agent', title: t('cmd.swarmAgent'), section: t('cmd.section.view'), run: () => { s.toggleSwarmAgent(); close() } },
      { id: 'timeline', title: t('cmd.timeline'), section: t('cmd.section.view'), run: () => { s.toggleTimeline(); close() } },
      { id: 'changes', title: t('cmd.changes'), section: t('cmd.section.view'), run: () => { s.toggleChanges(); close() } },
      { id: 'checkpoints', title: t('cmd.checkpoints'), section: t('cmd.section.view'), run: () => { s.toggleCheckpoints(); close() } },
      { id: 'review', title: t('cmd.review'), section: t('cmd.section.view'), run: () => { s.toggleReview(); close() } },
      { id: 'loops', title: t('cmd.loops'), section: t('cmd.section.view'), run: () => { s.toggleLoops(); close() } },
      { id: 'benchmarks', title: t('cmd.benchmarks'), section: t('cmd.section.view'), run: () => { s.toggleBenchmarks(); close() } },
      // The orchestrator bar renders inside the terminal grid (like broadcast),
      // so surface the panes first, then ensure the bar is open.
      { id: 'orchestrator', title: t('cmd.orchestrator'), section: t('cmd.section.view'), run: () => { s.showTerminals(); if (!s.orchestratorBarOpen) s.toggleOrchestratorBar(); close() } },
      { id: 'sidebar', title: t('cmd.sidebar'), section: t('cmd.section.view'), run: () => { s.toggleKanban(); close() } },
      { id: 'new-workspace', title: t('cmd.newWorkspace'), section: t('cmd.section.workspace'), run: () => { s.openSetupModal(); close() } },
      { id: 'settings', title: t('cmd.settings'), section: t('cmd.section.workspace'), run: () => { s.openSettings(); close() } },
    ]
    // Focus pane N
    s.getLeafIds().forEach((id, i) => {
      list.push({ id: `focus-${id}`, title: t('cmd.focusPane', { n: i + 1 }), section: t('cmd.section.panes'), run: () => { s.setActivePaneId(id); close() } })
    })
    // Switch workspace
    for (const ws of workspaces) {
      if (ws.id === s.workspace?.id) continue
      list.push({
        id: `ws-${ws.id}`,
        title: t('cmd.switchTo', { name: ws.name }),
        section: t('cmd.section.workspace'),
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
  }, [open, workspaces, setOpen, t])

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
          placeholder={t('cmd.placeholder')}
          spellCheck={false}
        />
        <div style={styles.list}>
          {filtered.length === 0 && <div style={styles.empty}>{t('cmd.empty')}</div>}
          {filtered.map((c, i) => {
            // A command's id matches its shortcut registry id where one exists,
            // so surface the (possibly rebound) combo as a hint.
            const keys = getEffectiveKeys(c.id, keybindings)
            return (
              <button
                key={c.id}
                style={{ ...styles.row, ...(i === index ? styles.rowActive : {}) }}
                onMouseEnter={() => setIndex(i)}
                onClick={() => c.run()}
              >
                <span style={styles.rowTitle}>{c.title}</span>
                {keys && <span style={styles.rowKeys}>{formatKeys(keys)}</span>}
                <span style={styles.rowSection}>{c.section}</span>
              </button>
            )
          })}
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
  row: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'transparent', border: 'none', borderRadius: 8, padding: '9px 12px', cursor: 'pointer', textAlign: 'left' },
  rowActive: { background: 'var(--accent-subtle)' },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 13.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowKeys: { fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 5, padding: '1px 6px', whiteSpace: 'nowrap', flexShrink: 0 },
  rowSection: { fontSize: 10.5, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 },
}
