import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp } from './Icons'
import { useT } from '../i18n'
import {
  buildConflictTaskPrompt,
  landableBranches,
  moveInList,
  summarizeQueue,
  type QueueRow,
} from '../lib/mergeQueue'

// ── Merge queue ───────────────────────────────────────────────────────────────
//
// The payoff moment of a swarm run is also where it used to hurt: N agents
// finish on N branches, and merging them one at a time discovers the conflict on
// the merge that breaks — after the earlier ones already landed. This view
// answers the question before anything is committed to.
//
// Two things make it more than a list of branches:
//
//  1. **The simulation is cumulative.** Each row is merged onto the result of the
//     rows above it, not onto base, because two branches that each merge cleanly
//     into main can still collide with each other. A per-branch check would show
//     both green and then fail on the second merge.
//  2. **Order is the user's, and re-previewing is cheap.** `git merge-tree` never
//     touches a working tree, so reordering the queue and re-simulating is free —
//     which turns "this conflicts" into "try landing it first instead".
//
// A conflicting row can be handed to an agent as a task rather than resolved by
// hand: the branch, the base and the conflicting files are exactly the context a
// resolve prompt needs, and the swarm already has idle workers.

interface Props {
  root: string
  base: string
  /** SwarmMind-managed worktrees, as the review view already listed them. */
  worktrees: { path: string; branch: string }[]
  /** Per-worktree stat from the review view — only `hasUncommitted` is used. */
  stats: Record<string, { hasUncommitted: boolean } | undefined>
  /** branch → display metadata, so rows read as "Worker A" not "swarmmind/x". */
  paneMeta: Record<string, { title?: string; color?: string; agentId: string | null } | undefined>
  onMerged: () => void
}

const VERDICT_COLOR: Record<QueueRow['verdict'], string> = {
  clean: '#7ee787',
  conflict: '#ff7b72',
  empty: 'var(--text-dim)',
  error: '#e3b341',
}

export function MergeQueue({ root, base, worktrees, stats, paneMeta, onMerged }: Props) {
  const t = useT()

  // Queue order is state, not derived: reordering *is* the interaction.
  const [order, setOrder] = useState<string[]>(() => worktrees.map(w => w.branch))
  const [preview, setPreview] = useState<QueueRow[] | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [handedOff, setHandedOff] = useState<Set<string>>(new Set())

  // Absorb worktrees appearing/disappearing without discarding the user's order:
  // known branches keep their position, new ones land at the end.
  useEffect(() => {
    const live = worktrees.map(w => w.branch)
    setOrder(prev => {
      const kept = prev.filter(b => live.includes(b))
      const added = live.filter(b => !kept.includes(b))
      const next = [...kept, ...added]
      return next.length === prev.length && next.every((b, i) => b === prev[i]) ? prev : next
    })
  }, [worktrees])

  const runPreview = useCallback(async (branches: string[]) => {
    if (!root || branches.length === 0) { setPreview([]); return }
    setPreviewing(true)
    try {
      const res = await window.swarmmind.gitMergeQueuePreview(root, branches, base)
      setPreview(res.rows)
    } finally {
      setPreviewing(false)
    }
  }, [root, base])

  useEffect(() => { void runPreview(order) }, [order, runPreview])

  const rows = preview ?? []
  const summary = useMemo(() => summarizeQueue(rows), [rows])
  const landable = useMemo(() => landableBranches(rows), [rows])

  const pathFor = (branch: string) => worktrees.find(w => w.branch === branch)?.path
  const labelFor = (branch: string) => {
    const meta = paneMeta[branch]
    const short = branch.replace(/^swarmmind\//, '')
    return meta?.title ? `${meta.title} · ${short}` : short
  }

  const move = (branch: string, delta: number) => {
    setNotice(null)
    setOrder(prev => {
      const from = prev.indexOf(branch)
      return moveInList(prev, from, from + delta)
    })
  }

  const doRun = async () => {
    if (!root || landable.length === 0) return
    setBusy(true)
    setNotice(null)
    const results = await window.swarmmind.gitMergeQueueRun(root, landable)
    setBusy(false)
    const merged = results.filter(r => r.ok).length
    const failure = results.find(r => !r.ok)
    setNotice(
      failure
        ? { kind: 'err', text: t('mergeQueue.ranPartial', { merged: String(merged), branch: failure.branch, error: failure.message }) }
        : { kind: 'ok', text: t('mergeQueue.ranAll', { merged: String(merged) }) }
    )
    onMerged()
    void runPreview(order)
  }

  // Hand a conflict to the swarm instead of resolving it by hand. Assigned to the
  // agent that authored the branch — it has the most context on why the change
  // looks the way it does.
  const doHandOff = async (row: QueueRow) => {
    const { title, description } = buildConflictTaskPrompt(row, base)
    const agent = paneMeta[row.branch]?.agentId ?? undefined
    try {
      await window.swarmmind.taskCreate(title, description, agent)
      setHandedOff(prev => new Set(prev).add(row.branch))
      setNotice({ kind: 'ok', text: t('mergeQueue.handedOff', { branch: row.branch }) })
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div style={styles.root}>
      <div style={styles.bar}>
        <span style={styles.summary}>
          {previewing
            ? t('mergeQueue.simulating')
            : t('mergeQueue.summary', {
                clean: String(summary.clean),
                conflict: String(summary.conflict),
                base,
              })}
        </span>
        <div style={{ flex: 1 }} />
        <button style={styles.btn} disabled={previewing || busy} onClick={() => runPreview(order)}>
          {t('mergeQueue.resimulate')}
        </button>
        <button
          style={{ ...styles.btn, ...(landable.length ? styles.primaryBtn : {}) }}
          disabled={busy || previewing || landable.length === 0}
          onClick={doRun}
        >
          {t('mergeQueue.mergeClean', { n: String(landable.length) })}
        </button>
      </div>

      {notice && (
        <div style={{ ...styles.notice, ...(notice.kind === 'err' ? styles.noticeErr : styles.noticeOk) }}>
          {notice.text}
        </div>
      )}

      <div style={styles.list}>
        {rows.length === 0 && (
          <div style={styles.empty}>{previewing ? t('common.loading') : t('mergeQueue.empty')}</div>
        )}

        {rows.map((row, idx) => {
          const path = pathFor(row.branch)
          const dirty = path ? stats[path]?.hasUncommitted : false
          return (
            <div key={row.branch} style={styles.row}>
              <div style={styles.orderCol}>
                <button
                  style={styles.moveBtn}
                  disabled={idx === 0 || busy}
                  onClick={() => move(row.branch, -1)}
                  title={t('mergeQueue.moveUp')}
                  aria-label={t('mergeQueue.moveUp')}
                >
                  <ArrowUp size={11} />
                </button>
                <span style={styles.position}>{idx + 1}</span>
                <button
                  style={styles.moveBtn}
                  disabled={idx === rows.length - 1 || busy}
                  onClick={() => move(row.branch, 1)}
                  title={t('mergeQueue.moveDown')}
                  aria-label={t('mergeQueue.moveDown')}
                >
                  <ArrowDown size={11} />
                </button>
              </div>

              <div style={styles.rowMain}>
                <div style={styles.rowHead}>
                  <span style={{ ...styles.dot, background: paneMeta[row.branch]?.color || 'var(--accent)' }} />
                  <span style={styles.branchName}>{labelFor(row.branch)}</span>
                  <span style={{ ...styles.verdict, color: VERDICT_COLOR[row.verdict] }}>
                    {t(`mergeQueue.verdict.${row.verdict}` as 'mergeQueue.verdict.clean')}
                  </span>
                  {row.ahead > 0 && <span style={styles.ahead}>{t('mergeQueue.ahead', { n: String(row.ahead) })}</span>}
                </div>

                {/* An uncommitted worktree is the single most common reason a row
                    reads "empty": the work exists on disk but not in the branch,
                    and only committed work can be merged. Say so on the row. */}
                {dirty && <div style={styles.warn}>{t('mergeQueue.uncommittedHint')}</div>}

                {row.verdict === 'conflict' && (
                  <div style={styles.conflictBlock}>
                    <div style={styles.conflictFiles}>
                      {row.conflicts.map(f => (
                        <span key={f} style={styles.conflictFile} title={f}>{f}</span>
                      ))}
                    </div>
                    <button
                      style={styles.handOffBtn}
                      disabled={busy || handedOff.has(row.branch)}
                      onClick={() => doHandOff(row)}
                    >
                      {handedOff.has(row.branch) ? t('mergeQueue.handedOffShort') : t('mergeQueue.handOff')}
                    </button>
                  </div>
                )}

                {row.verdict === 'error' && row.error && <div style={styles.errorText}>{row.error}</div>}
              </div>
            </div>
          )
        })}
      </div>

      {summary.conflict > 0 && (
        <div style={styles.footer}>
          {t('mergeQueue.conflictHint', { files: String(summary.conflictedFiles.length) })}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  bar: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
    borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  summary: { fontSize: 11, color: 'var(--text-muted)' },
  btn: {
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--text-secondary)', padding: '4px 10px', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap',
  },
  primaryBtn: { borderColor: 'var(--accent)', color: 'var(--accent)' },
  notice: { fontSize: 11, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  noticeOk: { color: '#7ee787', background: 'rgba(46,160,67,0.08)' },
  noticeErr: { color: '#ff7b72', background: 'rgba(248,81,73,0.08)' },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  row: {
    display: 'flex', gap: 10, padding: '8px 10px', borderRadius: 'var(--radius)',
    border: '1px solid var(--border)', background: 'var(--bg-panel)',
  },
  orderCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 },
  moveBtn: {
    background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer',
    padding: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 3,
  },
  position: { fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, monospace)' },
  rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  rowHead: { display: 'flex', alignItems: 'center', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  branchName: { fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  verdict: { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 },
  ahead: { fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, monospace)' },
  warn: { fontSize: 10, color: 'var(--accent)' },
  conflictBlock: { display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' },
  conflictFiles: { display: 'flex', flexWrap: 'wrap', gap: 3, flex: 1, minWidth: 0 },
  conflictFile: {
    fontSize: 10, fontFamily: 'var(--font-mono, monospace)', color: '#ff7b72',
    background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.3)',
    borderRadius: 'var(--radius)', padding: '1px 6px', maxWidth: 260,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  handOffBtn: {
    background: 'transparent', border: '1px solid var(--accent)', borderRadius: 'var(--radius)',
    color: 'var(--accent)', padding: '2px 8px', cursor: 'pointer', fontSize: 10, whiteSpace: 'nowrap',
  },
  errorText: { fontSize: 10, color: '#e3b341', fontFamily: 'var(--font-mono, monospace)' },
  footer: {
    fontSize: 10, color: 'var(--text-muted)', padding: '6px 12px',
    borderTop: '1px solid var(--border)', flexShrink: 0,
  },
  empty: { padding: 24, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' },
}
