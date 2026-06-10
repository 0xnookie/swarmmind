import React, { useState } from 'react'
import { MemoryGraph } from './MemoryGraph'
import { MemoryPanel } from './MemoryPanel'
import { useT } from '../i18n'

type MemoryTab = 'graph' | 'list'

// Center overlay that hosts the two ways of viewing shared memory: the
// force-directed MemoryGraph and the editable MemoryPanel (list of entries +
// tasks). The graph is the default; the list surfaces inline edit/delete.
export function MemoryView() {
  const t = useT()
  const [tab, setTab] = useState<MemoryTab>('graph')

  return (
    <div style={styles.root}>
      <div style={styles.tabStrip}>
        <button
          style={{ ...styles.tab, ...(tab === 'graph' ? styles.tabActive : {}) }}
          onClick={() => setTab('graph')}
        >
          {t('memview.graph')}
        </button>
        <button
          style={{ ...styles.tab, ...(tab === 'list' ? styles.tabActive : {}) }}
          onClick={() => setTab('list')}
        >
          {t('memview.list')}
        </button>
      </div>
      <div style={styles.content}>
        {tab === 'graph' ? <MemoryGraph /> : <MemoryPanel />}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-base)' },
  tabStrip: {
    display: 'flex',
    gap: 4,
    padding: '6px 10px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-panel)',
    flexShrink: 0,
  },
  tab: {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-muted)',
    padding: '4px 14px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    transition: 'border-color 120ms, color 120ms, background 120ms',
  },
  tabActive: {
    background: 'var(--accent-subtle)',
    borderColor: 'var(--accent)',
    color: 'var(--accent)',
  },
  content: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
}
