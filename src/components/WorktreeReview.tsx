import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore, type PaneNode } from '../store/workspace'
import { useT } from '../i18n'

// ── Worktree Review ─────────────────────────────────────────────────────────
//
// The payoff of per-pane git worktree isolation: review each agent's branch
// (committed work + uncommitted changes) against the main checkout, then commit,
// merge, or discard it. Center overlay, mirrors KanbanBoard/MemoryView.

interface WorktreeRow {
  path: string
  branch: string
}

interface PaneMeta {
  title?: string
  color?: string
  agentId: string | null
}

const MAX_DIFF_CHARS = 200_000

// SwarmMind-managed worktrees all live under .swarmmind/worktrees/.
function isManaged(path: string): boolean {
  return path.replace(/\\/g, '/').toLowerCase().includes('.swarmmind/worktrees/')
}

// Map branch → pane metadata (title/colour/agent) for friendlier labels.
function collectPaneMeta(node: PaneNode, out: Record<string, PaneMeta>): void {
  if (node.type === 'leaf') {
    if (node.worktreeBranch) {
      out[node.worktreeBranch] = { title: node.title, color: node.color, agentId: node.agentId }
    }
    return
  }
  node.children.forEach(c => collectPaneMeta(c, out))
}

export function WorktreeReview() {
  const t = useT()
  const workspace = useWorkspaceStore(s => s.workspace)
  const rootPane = useWorkspaceStore(s => s.rootPane)
  const root = workspace?.rootPath ?? null

  const [base, setBase] = useState('')
  const [rows, setRows] = useState<WorktreeRow[]>([])
  const [stats, setStats] = useState<Record<string, WorktreeDiffStat>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const paneMeta = useMemo(() => {
    const out: Record<string, PaneMeta> = {}
    collectPaneMeta(rootPane, out)
    return out
  }, [rootPane])

  const refresh = useCallback(async () => {
    if (!root) return
    setLoading(true)
    try {
      const [list, b] = await Promise.all([
        window.swarmmind.gitListWorktrees(root),
        window.swarmmind.gitBaseBranch(root),
      ])
      const managed = list.filter(w => isManaged(w.path))
      setBase(b)
      setRows(managed)
      const statEntries = await Promise.all(
        managed.map(async w => [w.path, await window.swarmmind.gitWorktreeDiffStat(root, w.path, b)] as const)
      )
      setStats(Object.fromEntries(statEntries))
      // Keep the selection if it still exists, else pick the first.
      setSelected(prev => (prev && managed.some(w => w.path === prev) ? prev : managed[0]?.path ?? null))
    } finally {
      setLoading(false)
    }
  }, [root])

  useEffect(() => { refresh() }, [refresh])

  // Load the diff whenever the selected worktree or file scope changes.
  useEffect(() => {
    if (!root || !selected) { setDiff(''); return }
    let cancelled = false
    window.swarmmind.gitWorktreeDiff(root, selected, selectedFile ?? undefined, base).then(d => {
      if (!cancelled) setDiff(d.length > MAX_DIFF_CHARS ? d.slice(0, MAX_DIFF_CHARS) + t('worktree.diffTruncated') : d)
    })
    return () => { cancelled = true }
  }, [root, selected, selectedFile, base, t])

  const selectedStat = selected ? stats[selected] : undefined
  const selectedRow = rows.find(r => r.path === selected)

  const label = (branch: string): string => {
    const meta = paneMeta[branch]
    const short = branch.replace(/^swarmmind\//, '')
    return meta?.title ? `${meta.title} · ${short}` : short
  }

  const doMerge = async () => {
    if (!root || !selectedRow) return
    if (selectedStat?.hasUncommitted &&
        !window.confirm(t('worktree.uncommittedConfirm'))) {
      return
    }
    setBusy(true)
    setNotice(null)
    const res = await window.swarmmind.gitMergeBranch(root, selectedRow.branch)
    setBusy(false)
    if (res.ok) {
      setNotice({ kind: 'ok', text: res.message })
      refresh()
    } else {
      setNotice({ kind: 'err', text: res.conflict ? t('worktree.mergeConflict', { error: res.error }) : t('worktree.mergeFailed', { error: res.error }) })
    }
  }

  const doCommit = async () => {
    if (!selectedRow) return
    setBusy(true)
    setNotice(null)
    const res = await window.swarmmind.gitWorktreeCommit(selectedRow.path, commitMsg.trim())
    setBusy(false)
    setCommitOpen(false)
    setCommitMsg('')
    if ('error' in res) setNotice({ kind: 'err', text: res.error })
    else if (res.hash === null) setNotice({ kind: 'ok', text: t('worktree.nothingToCommit') })
    else { setNotice({ kind: 'ok', text: t('worktree.committed', { hash: res.hash }) }); refresh() }
  }

  const doDiscard = async () => {
    if (!root || !selectedRow) return
    if (!window.confirm(t('worktree.discardConfirm', { branch: selectedRow.branch }))) return
    setBusy(true)
    setNotice(null)
    const res = await window.swarmmind.gitRemoveWorktree(root, selectedRow.path, selectedRow.branch, true)
    setBusy(false)
    if ('error' in res) setNotice({ kind: 'err', text: res.error })
    else { setNotice({ kind: 'ok', text: t('worktree.discarded') }); setSelected(null); refresh() }
  }

  if (!root) {
    return <div style={styles.root}><div style={styles.empty}>{t('worktree.noWorkspace')}</div></div>
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>{t('worktree.title')}</span>
        {base && <span style={styles.baseTag}>{t('worktree.base', { branch: base })}</span>}
        <button style={styles.iconBtn} onClick={refresh} disabled={loading}>{t('worktree.refresh')}</button>
      </div>

      <div style={styles.body}>
        {/* Branch list */}
        <div style={styles.sidebar}>
          {rows.length === 0 && (
            <div style={styles.empty}>
              {loading ? t('common.loading') : t('worktree.none')}
            </div>
          )}
          {rows.map(r => {
            const st = stats[r.path]
            const meta = paneMeta[r.branch]
            const isSel = r.path === selected
            return (
              <button
                key={r.path}
                style={{ ...styles.branchItem, ...(isSel ? styles.branchItemActive : {}) }}
                onClick={() => { setSelected(r.path); setSelectedFile(null); setNotice(null) }}
              >
                <span style={{ ...styles.branchDot, background: meta?.color || 'var(--accent)' }} />
                <span style={styles.branchName}>{label(r.branch)}</span>
                {st && (
                  <span style={styles.branchStat}>
                    <span style={styles.add}>+{st.files.reduce((s, f) => s + f.additions, 0)}</span>{' '}
                    <span style={styles.del}>−{st.files.reduce((s, f) => s + f.deletions, 0)}</span>
                    {st.hasUncommitted && <span title={t('worktree.uncommittedTitle')} style={styles.dirty}>●</span>}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Diff + actions */}
        <div style={styles.main}>
          {selectedRow ? (
            <>
              <div style={styles.actionBar}>
                <span style={styles.metaLine}>
                  {selectedStat && (
                    <>
                      {t('worktree.meta', { n: selectedStat.files.length, ahead: selectedStat.ahead, behind: selectedStat.behind })}
                      {selectedStat.hasUncommitted && <span style={styles.dirtyText}>{t('worktree.uncommitted')}</span>}
                    </>
                  )}
                </span>
                <div style={{ flex: 1 }} />
                <button style={styles.actBtn} disabled={busy} onClick={() => setCommitOpen(o => !o)}>{t('worktree.commitAll')}</button>
                <button style={{ ...styles.actBtn, ...styles.mergeBtn }} disabled={busy} onClick={doMerge}>{t('worktree.mergeInto', { base })}</button>
                <button style={{ ...styles.actBtn, ...styles.discardBtn }} disabled={busy} onClick={doDiscard}>{t('worktree.discard')}</button>
              </div>

              {commitOpen && (
                <div style={styles.commitRow}>
                  <input
                    style={styles.commitInput}
                    placeholder={t('worktree.commitPlaceholder')}
                    value={commitMsg}
                    onChange={e => setCommitMsg(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') doCommit() }}
                    autoFocus
                  />
                  <button style={styles.actBtn} disabled={busy} onClick={doCommit}>{t('worktree.commit')}</button>
                </div>
              )}

              {notice && (
                <div style={{ ...styles.notice, ...(notice.kind === 'err' ? styles.noticeErr : styles.noticeOk) }}>
                  {notice.text}
                </div>
              )}

              {/* File chips */}
              {selectedStat && selectedStat.files.length > 0 && (
                <div style={styles.fileChips}>
                  <button
                    style={{ ...styles.chip, ...(selectedFile === null ? styles.chipActive : {}) }}
                    onClick={() => setSelectedFile(null)}
                  >{t('worktree.all')}</button>
                  {selectedStat.files.map(f => (
                    <button
                      key={f.path}
                      style={{ ...styles.chip, ...(selectedFile === f.path ? styles.chipActive : {}) }}
                      onClick={() => setSelectedFile(f.path)}
                      title={f.path}
                    >
                      {f.path.split('/').pop()} <span style={styles.add}>+{f.additions}</span>/<span style={styles.del}>−{f.deletions}</span>
                    </button>
                  ))}
                </div>
              )}

              <div style={styles.diffWrap}>
                {diff ? <DiffView text={diff} /> : <div style={styles.empty}>{t('worktree.noChanges', { base })}</div>}
              </div>
            </>
          ) : (
            <div style={styles.empty}>{t('worktree.selectPrompt')}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// Render a unified diff with per-line colouring. Cheap and dependency-free.
function DiffView({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre style={styles.diff}>
      {lines.map((ln, i) => {
        let color = 'var(--text-secondary)'
        let bg = 'transparent'
        if (ln.startsWith('+') && !ln.startsWith('+++')) { color = '#7ee787'; bg = 'rgba(46,160,67,0.10)' }
        else if (ln.startsWith('-') && !ln.startsWith('---')) { color = '#ff7b72'; bg = 'rgba(248,81,73,0.10)' }
        else if (ln.startsWith('@@')) color = '#79c0ff'
        else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('+++') || ln.startsWith('---')) color = 'var(--text-muted)'
        return <div key={i} style={{ color, background: bg, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{ln || ' '}</div>
      })}
    </pre>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-base)' },
  header: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
    borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0,
  },
  title: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  baseTag: { fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: 'var(--radius)' },
  iconBtn: {
    marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--text-muted)', padding: '3px 10px', cursor: 'pointer', fontSize: 11,
  },
  body: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' },
  sidebar: {
    width: 260, flexShrink: 0, borderRight: '1px solid var(--border)', background: 'var(--bg-panel)',
    overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 3,
  },
  branchItem: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 'var(--radius)',
    border: '1px solid transparent', background: 'transparent', cursor: 'pointer', textAlign: 'left', width: '100%',
  },
  branchItemActive: { background: 'var(--accent-subtle)', borderColor: 'var(--accent)' },
  branchDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  branchName: { fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  branchStat: { fontSize: 10, fontFamily: 'var(--font-mono, monospace)', display: 'flex', alignItems: 'center', gap: 3 },
  add: { color: '#7ee787' },
  del: { color: '#ff7b72' },
  dirty: { color: 'var(--accent)', marginLeft: 2 },
  dirtyText: { color: 'var(--accent)' },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  actionBar: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  metaLine: { fontSize: 11, color: 'var(--text-muted)' },
  actBtn: {
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--text-secondary)', padding: '4px 10px', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap',
  },
  mergeBtn: { borderColor: 'var(--accent)', color: 'var(--accent)' },
  discardBtn: { color: '#ff7b72', borderColor: 'rgba(248,81,73,0.4)' },
  commitRow: { display: 'flex', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  commitInput: {
    flex: 1, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--text-primary)', padding: '5px 9px', fontSize: 12, outline: 'none',
  },
  notice: { fontSize: 11, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  noticeOk: { color: '#7ee787', background: 'rgba(46,160,67,0.08)' },
  noticeErr: { color: '#ff7b72', background: 'rgba(248,81,73,0.08)' },
  fileChips: { display: 'flex', flexWrap: 'wrap', gap: 4, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0, maxHeight: 110, overflowY: 'auto' },
  chip: {
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--text-muted)', padding: '2px 8px', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-mono, monospace)',
  },
  chipActive: { borderColor: 'var(--accent)', color: 'var(--text-primary)' },
  diffWrap: { flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--bg-base)' },
  diff: { margin: 0, padding: '8px 12px', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'var(--font-mono, monospace)' },
  empty: { padding: 24, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' },
}
