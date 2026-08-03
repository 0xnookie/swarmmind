import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore, type PaneLeaf, type PaneNode } from '../store/workspace'
import { UnifiedDiff } from './UnifiedDiff'
import { confirmDialog } from './ConfirmDialog'
import { useT } from '../i18n'
import {
  attemptState, buildRacePrompt, canStartRace, churn, contestedFiles, planWinner,
  raceEligibility, type AttemptStat, type RacePane,
} from '../lib/race'

// ── Race mode ─────────────────────────────────────────────────────────────────
//
// Give the same task to several agents at once — each on its own worktree
// branch — then compare the attempts and keep one. Best-of-N sampling, but the
// unit being sampled is a whole agent, so Claude Code, Codex and a local model
// can all take a swing at the same change and you pick the result you like.
//
// Every piece this needs already existed: worktree isolation keeps the attempts
// from overwriting each other, `ptyInput` starts them, `gitWorktreeDiffStat`
// measures them, `UnifiedDiff` shows them and `gitMergeBranch`/`gitRemoveWorktree`
// resolve the race. What was missing was the framing, which is what this panel
// and the pure `src/lib/race.ts` add.

const POLL_MS = 4000
const MAX_DIFF_CHARS = 200_000

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

export function RacePanel() {
  const t = useT()
  const workspace = useWorkspaceStore(s => s.workspace)
  const rootPane = useWorkspaceStore(s => s.rootPane)
  const paneAttention = useWorkspaceStore(s => s.paneAttention)
  const goal = useWorkspaceStore(s => s.raceGoal)
  const setGoal = useWorkspaceStore(s => s.setRaceGoal)
  const racePaneIds = useWorkspaceStore(s => s.racePaneIds)
  const setRacePaneIds = useWorkspaceStore(s => s.setRacePaneIds)
  const root = workspace?.rootPath ?? null

  const [base, setBase] = useState('')
  const [stats, setStats] = useState<Record<string, AttemptStat>>({})
  const [diffFor, setDiffFor] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Every pane, described in the shape race.ts reasons about.
  const panes: RacePane[] = useMemo(() => collectLeaves(rootPane).map(leaf => ({
    paneId: leaf.id,
    agentId: leaf.agentId,
    title: leaf.title || leaf.agentId || leaf.id.slice(0, 6),
    branch: leaf.worktreeBranch ?? null,
    worktreePath: leaf.worktreePath ?? null,
    running: leaf.ptyStatus === 'running',
  })), [rootPane])

  const { eligible, ineligible } = useMemo(() => raceEligibility(panes), [panes])
  const racers = useMemo(
    () => eligible.filter(p => racePaneIds.includes(p.paneId)),
    [eligible, racePaneIds],
  )

  useEffect(() => {
    if (root) void window.swarmmind.gitBaseBranch(root).then(setBase)
  }, [root])

  // Poll each racer's diff stat. Attempts land asynchronously over minutes, so
  // the comparison has to keep itself current without the user refreshing.
  const refreshStats = useCallback(async () => {
    if (!root || racers.length === 0) return
    const entries = await Promise.all(racers.map(async r => {
      const st = await window.swarmmind.gitWorktreeDiffStat(root, r.worktreePath!, base || undefined)
      return [r.paneId, {
        files: st.files.map(f => f.path),
        additions: st.files.reduce((s, f) => s + f.additions, 0),
        deletions: st.files.reduce((s, f) => s + f.deletions, 0),
      }] as const
    }))
    setStats(Object.fromEntries(entries))
  }, [root, racers, base])

  useEffect(() => {
    void refreshStats()
    const timer = window.setInterval(() => { void refreshStats() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshStats])

  useEffect(() => {
    if (!root || !diffFor) { setDiff(''); return }
    const attempt = racers.find(r => r.paneId === diffFor)
    if (!attempt?.worktreePath) { setDiff(''); return }
    let cancelled = false
    window.swarmmind.gitWorktreeDiff(root, attempt.worktreePath, undefined, base || undefined).then(d => {
      if (!cancelled) setDiff(d.length > MAX_DIFF_CHARS ? d.slice(0, MAX_DIFF_CHARS) + t('worktree.diffTruncated') : d)
    })
    return () => { cancelled = true }
  }, [root, diffFor, racers, base, t])

  const toggleRacer = (paneId: string) => {
    setRacePaneIds(
      racePaneIds.includes(paneId) ? racePaneIds.filter(id => id !== paneId) : [...racePaneIds, paneId]
    )
  }

  const start = () => {
    if (!canStartRace(racePaneIds, goal)) return
    const total = racers.length
    racers.forEach((r, i) => {
      window.swarmmind.ptyInput(r.paneId, buildRacePrompt(goal, i + 1, total))
    })
    setNotice({ kind: 'ok', text: t('race.started', { n: String(total) }) })
  }

  const pickWinner = async (paneId: string) => {
    if (!root) return
    const plan = planWinner(racers, paneId)
    if (!plan) { setNotice({ kind: 'err', text: t('race.winnerGone') }); return }

    const ok = await confirmDialog({
      body: t('race.keepConfirm', { branch: plan.keep.branch, base, n: String(plan.discard.length) }),
      confirmLabel: t('race.keepConfirmAction'),
      danger: true,
    })
    if (!ok) return

    setBusy(true)
    setNotice(null)
    const merged = await window.swarmmind.gitMergeBranch(root, plan.keep.branch)
    if (!merged.ok) {
      setBusy(false)
      // Nothing is discarded when the winner doesn't land — losing the other
      // attempts *and* not having the winner would be the worst outcome here.
      setNotice({ kind: 'err', text: t('race.mergeFailed', { error: merged.error }) })
      return
    }
    let dropped = 0
    for (const loser of plan.discard) {
      const res = await window.swarmmind.gitRemoveWorktree(root, loser.worktreePath, loser.branch, true)
      if (!('error' in res)) dropped++
    }
    setBusy(false)
    setRacePaneIds([])
    setNotice({ kind: 'ok', text: t('race.kept', { branch: plan.keep.branch, n: String(dropped) }) })
    void refreshStats()
  }

  const contested = useMemo(
    () => contestedFiles(racers.map(r => ({ paneId: r.paneId, stat: stats[r.paneId] }))),
    [racers, stats],
  )

  if (!root) {
    return <div style={styles.root}><div style={styles.empty}>{t('worktree.noWorkspace')}</div></div>
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>{t('race.title')}</span>
        {base && <span style={styles.baseTag}>{t('worktree.base', { branch: base })}</span>}
      </div>

      {/* ── Setup ────────────────────────────────────────────────────────── */}
      <div style={styles.setup}>
        <textarea
          style={styles.goal}
          placeholder={t('race.goalPlaceholder')}
          value={goal}
          onChange={e => setGoal(e.target.value)}
          spellCheck={false}
        />
        <div style={styles.paneRow}>
          {eligible.map(p => (
            <label key={p.paneId} style={{ ...styles.paneChip, ...(racePaneIds.includes(p.paneId) ? styles.paneChipOn : {}) }}>
              <input
                type="checkbox"
                style={styles.check}
                checked={racePaneIds.includes(p.paneId)}
                onChange={() => toggleRacer(p.paneId)}
              />
              {p.title}
              {p.agentId && <span style={styles.agentTag}>{p.agentId}</span>}
            </label>
          ))}
          {eligible.length === 0 && <span style={styles.hint}>{t('race.noEligible')}</span>}
        </div>

        {/* Say *why* a pane can't race — "it isn't in the list" is otherwise
            unexplainable, and the worktree requirement is the whole reason the
            attempts stay comparable. */}
        {ineligible.length > 0 && (
          <div style={styles.hint}>
            {ineligible.map(({ pane, reason }) => (
              <span key={pane.paneId} style={styles.ineligible}>
                {pane.title}: {reason === 'no-worktree' ? t('race.needsWorktree') : t('race.needsRunning')}
              </span>
            ))}
          </div>
        )}

        <div style={styles.startRow}>
          <button
            style={{ ...styles.btn, ...(canStartRace(racePaneIds, goal) ? styles.primaryBtn : {}) }}
            disabled={!canStartRace(racePaneIds, goal) || busy}
            onClick={start}
          >
            {t('race.start', { n: String(racers.length) })}
          </button>
          <span style={styles.hint}>{t('race.startHint')}</span>
        </div>
      </div>

      {notice && (
        <div style={{ ...styles.notice, ...(notice.kind === 'err' ? styles.noticeErr : styles.noticeOk) }}>
          {notice.text}
        </div>
      )}

      {/* ── Attempts ─────────────────────────────────────────────────────── */}
      <div style={styles.attempts}>
        {racers.map(r => {
          const stat = stats[r.paneId]
          const state = attemptState({
            running: r.running,
            working: paneAttention[r.paneId] === 'working',
            stat,
          })
          return (
            <div key={r.paneId} style={{ ...styles.card, ...(diffFor === r.paneId ? styles.cardActive : {}) }}>
              <div style={styles.cardHead}>
                <span style={styles.cardTitle}>{r.title}</span>
                <span style={{ ...styles.state, color: STATE_COLOR[state] }}>{t(`race.state.${state}` as 'race.state.ready')}</span>
              </div>
              <div style={styles.cardStat}>
                {stat && stat.files.length > 0
                  ? t('race.stat', { files: String(stat.files.length), churn: String(churn(stat)) })
                  : t('race.noChanges')}
              </div>
              <div style={styles.cardActions}>
                <button style={styles.smallBtn} onClick={() => setDiffFor(diffFor === r.paneId ? null : r.paneId)}>
                  {diffFor === r.paneId ? t('race.hideDiff') : t('race.viewDiff')}
                </button>
                <button
                  style={{ ...styles.smallBtn, ...styles.keepBtn }}
                  disabled={busy || state !== 'ready'}
                  onClick={() => pickWinner(r.paneId)}
                >
                  {t('race.keep')}
                </button>
              </div>
            </div>
          )
        })}
        {racers.length === 0 && <div style={styles.empty}>{t('race.selectPrompt')}</div>}
      </div>

      {/* Where the attempts actually disagree — the first thing worth reading. */}
      {contested.length > 0 && (
        <div style={styles.contested}>
          <span style={styles.contestedLabel}>{t('race.contested')}</span>
          {contested.slice(0, 12).map(c => (
            <span key={c.path} style={styles.contestedFile} title={c.path}>
              {c.path.split('/').pop()} <span style={styles.contestedCount}>×{c.count}</span>
            </span>
          ))}
        </div>
      )}

      {diffFor && (
        <div style={styles.diffWrap}>
          {diff ? <UnifiedDiff text={diff} /> : <div style={styles.empty}>{t('race.noChanges')}</div>}
        </div>
      )}
    </div>
  )
}

const STATE_COLOR: Record<string, string> = {
  ready: '#7ee787',
  working: 'var(--accent)',
  waiting: 'var(--text-muted)',
  gone: '#ff7b72',
}

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-base)' },
  header: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
    borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0,
  },
  title: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  baseTag: { fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: 'var(--radius)' },
  setup: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderBottom: '1px solid var(--border)', flexShrink: 0 },
  goal: {
    minHeight: 58, resize: 'vertical', background: 'var(--bg-panel)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', color: 'var(--text-primary)', padding: '7px 10px',
    fontSize: 12, outline: 'none', fontFamily: 'inherit', lineHeight: 1.5,
  },
  paneRow: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  paneChip: {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'pointer',
    fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-panel)',
  },
  paneChipOn: { borderColor: 'var(--accent)', background: 'var(--accent-subtle)', color: 'var(--text-primary)' },
  check: { cursor: 'pointer', accentColor: 'var(--accent)', width: 12, height: 12 },
  agentTag: { fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, monospace)' },
  startRow: { display: 'flex', alignItems: 'center', gap: 10 },
  btn: {
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--text-secondary)', padding: '5px 12px', cursor: 'pointer', fontSize: 11,
  },
  primaryBtn: { borderColor: 'var(--accent)', color: 'var(--accent)' },
  hint: { fontSize: 10, color: 'var(--text-dim)', display: 'flex', flexWrap: 'wrap', gap: 8 },
  ineligible: { whiteSpace: 'nowrap' },
  notice: { fontSize: 11, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  noticeOk: { color: '#7ee787', background: 'rgba(46,160,67,0.08)' },
  noticeErr: { color: '#ff7b72', background: 'rgba(248,81,73,0.08)' },
  attempts: { display: 'flex', gap: 8, padding: 12, flexWrap: 'wrap', flexShrink: 0 },
  card: {
    flex: '1 1 200px', minWidth: 190, display: 'flex', flexDirection: 'column', gap: 6,
    padding: 10, borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg-panel)',
  },
  cardActive: { borderColor: 'var(--accent)' },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  state: { fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 },
  cardStat: { fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)' },
  cardActions: { display: 'flex', gap: 6 },
  smallBtn: {
    background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--text-muted)', padding: '2px 8px', cursor: 'pointer', fontSize: 10, whiteSpace: 'nowrap',
  },
  keepBtn: { borderColor: 'var(--accent)', color: 'var(--accent)' },
  contested: {
    display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
    padding: '6px 12px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  contestedLabel: { fontSize: 10, color: 'var(--text-muted)', marginRight: 4 },
  contestedFile: {
    fontSize: 10, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-secondary)',
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1px 6px',
  },
  contestedCount: { color: 'var(--accent)' },
  diffWrap: { flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--bg-base)' },
  empty: { padding: 24, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', width: '100%' },
}
