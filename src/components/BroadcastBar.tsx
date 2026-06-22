import React, { useMemo, useRef, useState } from 'react'
import { useWorkspaceStore, type PaneNode, type PaneLeaf, type AgentId } from '../store/workspace'
import { AgentIcon } from '../data/agents'
import { useFileMentions } from '../hooks/useFileMentions'
import { useT } from '../i18n'

const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'Claude', codex: 'Codex', cursor: 'Cursor', windsurf: 'Windsurf',
  kilo: 'Kilo', opencode: 'OpenCode', cline: 'Cline',
}

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

// Compose a prompt and send it to many panes at once. Targets are chosen via the
// pane chips (click to toggle); with none chosen it goes to every pane.
export function BroadcastBar() {
  const t = useT()
  const open = useWorkspaceStore(s => s.broadcastBarOpen)
  const toggle = useWorkspaceStore(s => s.toggleBroadcastBar)
  const selectedPaneIds = useWorkspaceStore(s => s.selectedPaneIds)
  const togglePaneSelected = useWorkspaceStore(s => s.togglePaneSelected)
  const clearSelection = useWorkspaceStore(s => s.clearPaneSelection)
  const rootPane = useWorkspaceStore(s => s.rootPane)

  const [text, setText] = useState('')
  const [submit, setSubmit] = useState(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mentions = useFileMentions({ value: text, setValue: setText, textareaRef: inputRef })

  // Mixed-workspace panes belong to another workspace's swarm — exclude them
  // from broadcast targeting (and the chip list) so a host broadcast never
  // leaks into a foreign agent.
  const leaves = useMemo(() => collectLeaves(rootPane).filter(l => !l.workspaceId), [rootPane])

  if (!open) return null

  const allIds = leaves.map(l => l.id)
  const usingSelection = selectedPaneIds.length > 0
  const targets = usingSelection ? selectedPaneIds.filter(id => allIds.includes(id)) : allIds

  const labelFor = (leaf: PaneLeaf, i: number) =>
    leaf.title || (leaf.agentId ? AGENT_LABEL[leaf.agentId] : null) || t('broadcast.paneFallback', { n: i + 1 })

  const send = () => {
    if (!text.trim() || targets.length === 0) return
    for (const id of targets) {
      window.swarmmind.ptyInput(id, text)
      if (submit) window.swarmmind.ptyInput(id, '\r')
    }
    setText('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the @-mention menu claim navigation/selection keys first.
    if (mentions.onKeyDown(e)) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
    else if (e.key === 'Escape') toggle()
  }

  return (
    <div style={styles.bar}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.badge}>{t('broadcast.badge')}</span>
        <span style={styles.summary}>
          {targets.length === 0
            ? t('broadcast.noPanes')
            : usingSelection
              ? t('broadcast.selected', { n: targets.length })
              : t('broadcast.allPanes', { n: allIds.length })}
        </span>
        <div style={{ flex: 1 }} />
        <button style={styles.linkBtn} onClick={() => leaves.forEach(l => { if (!selectedPaneIds.includes(l.id)) togglePaneSelected(l.id) })}>{t('broadcast.all')}</button>
        <span style={styles.dot}>·</span>
        <button style={styles.linkBtn} onClick={clearSelection} disabled={!usingSelection}>{t('broadcast.none')}</button>
        <button style={styles.close} onClick={toggle} aria-label={t('common.close')}>✕</button>
      </div>

      {/* Pane target chips */}
      <div style={styles.chips}>
        {leaves.map((leaf, i) => {
          const on = usingSelection ? selectedPaneIds.includes(leaf.id) : true
          const accent = leaf.color || 'var(--accent)'
          return (
            <button
              key={leaf.id}
              onClick={() => togglePaneSelected(leaf.id)}
              style={{
                ...styles.chip,
                borderColor: on ? accent : 'var(--border)',
                background: on ? 'var(--bg-elevated-2)' : 'transparent',
                opacity: on ? 1 : 0.55,
              }}
              title={usingSelection ? t('broadcast.chipToggle') : t('broadcast.chipPick')}
            >
              {leaf.agentId
                ? <AgentIcon id={leaf.agentId} size={13} />
                : <span style={{ width: 7, height: 7, borderRadius: '50%', background: accent, flexShrink: 0 }} />}
              <span style={styles.chipLabel}>{labelFor(leaf, i)}</span>
            </button>
          )
        })}
      </div>

      {/* Composer */}
      <div style={styles.inputRow}>
        <div style={{ flex: 1, position: 'relative' }}>
          {mentions.active && (
            <div style={styles.mentionMenu}>
              {mentions.candidates.map((path, i) => (
                <button
                  key={path}
                  style={{ ...styles.mentionItem, ...(i === mentions.index ? styles.mentionItemActive : {}) }}
                  onMouseEnter={() => mentions.setIndex(i)}
                  onMouseDown={e => { e.preventDefault(); mentions.choose(path) }}
                >
                  <span style={styles.mentionName}>{path.split('/').pop()}</span>
                  <span style={styles.mentionDir}>{path}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }}
            value={text}
            onChange={e => { setText(e.target.value); requestAnimationFrame(mentions.refresh) }}
            onKeyUp={mentions.refresh}
            onClick={mentions.refresh}
            onKeyDown={onKeyDown}
            placeholder={t('broadcast.placeholder')}
            rows={2}
            spellCheck={false}
            autoFocus
          />
        </div>
        <div style={styles.controls}>
          <label style={styles.submitToggle} title={t('broadcast.submitTitle')}>
            <input type="checkbox" checked={submit} onChange={e => setSubmit(e.target.checked)} />
            {t('broadcast.submit')}
          </label>
          <button
            style={{ ...styles.sendBtn, opacity: text.trim() && targets.length ? 1 : 0.4, cursor: text.trim() && targets.length ? 'pointer' : 'not-allowed' }}
            onClick={send}
            disabled={!text.trim() || targets.length === 0}
          >
            {t('broadcast.sendTo', { n: targets.length })}
          </button>
        </div>
      </div>
      <div style={styles.hint}>{t('broadcast.hint')}</div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    flexShrink: 0,
    borderTop: '1px solid var(--border)',
    background: 'var(--bg-panel)',
    padding: '10px 12px 8px',
    boxShadow: '0 -4px 16px rgba(0,0,0,0.25)',
  },
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  badge: {
    fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--accent)',
    background: 'var(--accent-subtle)', border: '1px solid var(--accent-glow)',
    borderRadius: 5, padding: '2px 7px',
  },
  summary: { fontSize: 12, color: 'var(--text-secondary)' },
  linkBtn: { background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', padding: '2px 4px', borderRadius: 4 },
  dot: { color: 'var(--text-dim)', fontSize: 11 },
  close: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: '0 2px 0 6px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chip: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 9999,
    border: '1px solid', cursor: 'pointer', transition: 'opacity 120ms, border-color 120ms, background 120ms',
  },
  chipLabel: { fontSize: 11.5, color: 'var(--text-secondary)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  inputRow: { display: 'flex', gap: 8, alignItems: 'stretch' },
  mentionMenu: {
    position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
    maxHeight: 220, overflowY: 'auto', background: 'var(--bg-panel)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.4))', padding: 4,
  },
  mentionItem: {
    display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
    background: 'transparent', border: 'none', borderRadius: 5, padding: '5px 9px', cursor: 'pointer',
  },
  mentionItemActive: { background: 'var(--accent-subtle)' },
  mentionName: { fontSize: 12.5, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', ui-monospace, monospace", flexShrink: 0 },
  mentionDir: { fontSize: 10.5, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  input: {
    flex: 1, resize: 'none', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 11px',
    fontSize: 13, fontFamily: "'JetBrains Mono', ui-monospace, monospace", outline: 'none',
  },
  controls: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-end', gap: 6 },
  submitToggle: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' },
  sendBtn: {
    background: 'linear-gradient(135deg, var(--accent-hover) 0%, var(--accent) 100%)', border: 'none', color: 'var(--accent-fg)',
    fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 'var(--radius)', whiteSpace: 'nowrap',
    boxShadow: '0 2px 8px var(--accent-glow)',
  },
  hint: { fontSize: 10.5, color: 'var(--text-dim)', marginTop: 7, textAlign: 'center' },
}
