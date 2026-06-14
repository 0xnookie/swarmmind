import React, { useMemo, useEffect, useState } from 'react'
import {
  useWorkspaceStore,
  type PaneNode,
  type PaneLeaf,
  type AgentId,
  type OrchestrationMode,
} from '../store/workspace'
import { conductorControls } from '../hooks/useConductor'
import { AgentIcon } from '../data/agents'
import { useT, type TranslationKey } from '../i18n'

const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'Claude', codex: 'Codex', cursor: 'Cursor', windsurf: 'Windsurf',
  kilo: 'Kilo', opencode: 'OpenCode', cline: 'Cline',
}

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

const MODES: { id: OrchestrationMode; labelKey: TranslationKey; hintKey: TranslationKey }[] = [
  { id: 'off', labelKey: 'orch.mode.off', hintKey: 'orch.mode.off.hint' },
  { id: 'assisted', labelKey: 'orch.mode.assisted', hintKey: 'orch.mode.assisted.hint' },
  { id: 'auto', labelKey: 'orch.mode.auto', hintKey: 'orch.mode.auto.hint' },
]

const PHASE_KEY: Record<string, TranslationKey> = {
  idle: 'orch.phase.idle',
  running: 'orch.phase.running',
  synthesizing: 'orch.phase.synthesizing',
  done: 'orch.phase.done',
}

// Compose the orchestration control surface: pick a mode and (optionally) a lead
// pane + goal, then watch the conductor dispatch tasks across the worker panes.
export function OrchestratorBar() {
  const t = useT()
  const open = useWorkspaceStore(s => s.orchestratorBarOpen)
  const toggle = useWorkspaceStore(s => s.toggleOrchestratorBar)
  const mode = useWorkspaceStore(s => s.orchestrationMode)
  const setMode = useWorkspaceStore(s => s.setOrchestrationMode)
  const leadPaneId = useWorkspaceStore(s => s.leadPaneId)
  const setLeadPaneId = useWorkspaceStore(s => s.setLeadPaneId)
  const goal = useWorkspaceStore(s => s.orchestratorGoal)
  const setGoal = useWorkspaceStore(s => s.setOrchestratorGoal)
  const phase = useWorkspaceStore(s => s.orchestratorPhase)
  const start = useWorkspaceStore(s => s.startOrchestration)
  const stop = useWorkspaceStore(s => s.stopOrchestration)
  const paneTask = useWorkspaceStore(s => s.paneTask)
  const proposal = useWorkspaceStore(s => s.orchestratorProposal)
  const log = useWorkspaceStore(s => s.orchestratorLog)
  const clearLog = useWorkspaceStore(s => s.clearOrchestratorLog)
  const rootPane = useWorkspaceStore(s => s.rootPane)

  // Poll the task list so the worker-status rows can show task titles.
  const [taskTitles, setTaskTitles] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const tasks = (await window.swarmmind.taskList()) as { id: string; title: string }[]
      if (!cancelled) setTaskTitles(Object.fromEntries(tasks.map(t => [t.id, t.title])))
    }
    refresh()
    const h = setInterval(refresh, 2000)
    return () => { cancelled = true; clearInterval(h) }
  }, [])

  const leaves = useMemo(() => collectLeaves(rootPane), [rootPane])
  const agentPanes = useMemo(() => leaves.filter(l => l.agentId), [leaves])

  if (!open) return null

  const labelFor = (leaf: PaneLeaf, i: number) =>
    leaf.title || (leaf.agentId ? AGENT_LABEL[leaf.agentId] : null) || t('common.paneN', { n: i + 1 })

  const workerEntries = Object.entries(paneTask)
  const canStart = mode !== 'off' && !!leadPaneId && goal.trim().length > 0 && phase !== 'running'

  return (
    <div style={styles.bar}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.badge}>{t('orch.badge')}</span>
        <span style={styles.phasePill} data-phase={phase}>{t(PHASE_KEY[phase] ?? 'orch.phase.idle')}</span>
        <div style={{ flex: 1 }} />
        {/* Mode segmented control */}
        <div style={styles.segmented}>
          {MODES.map(m => (
            <button
              key={m.id}
              title={t(m.hintKey)}
              onClick={() => setMode(m.id)}
              style={{
                ...styles.segBtn,
                background: mode === m.id ? 'var(--accent)' : 'transparent',
                color: mode === m.id ? 'var(--accent-fg)' : 'var(--text-muted)',
              }}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>
        <button style={styles.close} onClick={toggle} aria-label={t('common.close')}>✕</button>
      </div>

      {/* Lead + goal row */}
      <div style={styles.controlRow}>
        <label style={styles.fieldLabel}>{t('orch.lead')}</label>
        <select
          style={styles.select}
          value={leadPaneId ?? ''}
          onChange={e => setLeadPaneId(e.target.value || null)}
        >
          <option value="">{t('orch.leadNone')}</option>
          {agentPanes.map((leaf, i) => (
            <option key={leaf.id} value={leaf.id}>{labelFor(leaf, i)}</option>
          ))}
        </select>
        <input
          style={styles.goalInput}
          value={goal}
          onChange={e => setGoal(e.target.value)}
          placeholder={t('orch.goalPlaceholder')}
          spellCheck={false}
        />
        {phase === 'running' ? (
          <button style={styles.stopBtn} onClick={stop}>{t('orch.stop')}</button>
        ) : (
          <button
            style={{ ...styles.startBtn, opacity: canStart ? 1 : 0.4, cursor: canStart ? 'pointer' : 'not-allowed' }}
            onClick={start}
            disabled={!canStart}
            title={mode === 'off' ? t('orch.startTitleMode') : !leadPaneId ? t('orch.startTitleLead') : t('orch.startTitleReady')}
          >
            {t('orch.start')}
          </button>
        )}
      </div>

      {/* Assisted-mode proposal */}
      {mode === 'assisted' && proposal && (
        <div style={styles.proposal}>
          <span style={styles.proposalText}>
            {t('orch.proposal', { title: proposal.title, agent: proposal.agentId ?? t('orch.proposalPane') })}
          </span>
          <div style={{ flex: 1 }} />
          <button style={styles.approveBtn} onClick={() => conductorControls.approve()}>{t('orch.approve')}</button>
          <button style={styles.skipBtn} onClick={() => conductorControls.skip()}>{t('orch.skip')}</button>
        </div>
      )}

      {/* Worker status + log */}
      <div style={styles.statusRow}>
        <div style={styles.statusCol}>
          <div style={styles.colLabel}>{t('orch.working', { n: workerEntries.length })}</div>
          {workerEntries.length === 0 ? (
            <div style={styles.empty}>{t('orch.noDispatches')}</div>
          ) : (
            workerEntries.map(([paneId, taskId]) => {
              const leaf = leaves.find(l => l.id === paneId)
              const idx = leaves.findIndex(l => l.id === paneId)
              return (
                <div key={paneId} style={styles.workerRow}>
                  {leaf?.agentId
                    ? <AgentIcon id={leaf.agentId} size={13} />
                    : <span style={styles.workerDot} />}
                  <span style={styles.workerName}>{leaf ? labelFor(leaf, idx) : t('orch.proposalPane')}</span>
                  <span style={styles.workerTask}>{taskTitles[taskId] ?? taskId.slice(0, 8)}</span>
                </div>
              )
            })
          )}
        </div>
        <div style={styles.statusCol}>
          <div style={styles.colLabel}>
            {t('orch.activity')}
            {log.length > 0 && <button style={styles.clearLink} onClick={clearLog}>{t('orch.clear')}</button>}
          </div>
          <div style={styles.logBox}>
            {log.length === 0 ? (
              <div style={styles.empty}>{t('orch.noActivity')}</div>
            ) : (
              log.map(e => (
                <div key={e.id} style={styles.logLine}>
                  <span style={styles.logTime}>{new Date(e.ts).toLocaleTimeString()}</span> {e.text}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      <div style={styles.hint}>
        {t('orch.hintPrefix')} <code>task_update</code> / <code>memory_write("result:&lt;id&gt;")</code> {t('orch.hintSuffix')}
      </div>
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
  phasePill: {
    fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)',
    background: 'var(--bg-elevated-2)', border: '1px solid var(--border)',
    borderRadius: 9999, padding: '1px 9px', textTransform: 'capitalize',
  },
  segmented: { display: 'flex', gap: 2, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 7, padding: 2 },
  segBtn: { border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 600, padding: '3px 11px', cursor: 'pointer', transition: 'background 120ms, color 120ms' },
  close: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: '0 2px 0 6px' },
  controlRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  fieldLabel: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 },
  select: {
    background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', padding: '5px 8px', fontSize: 12, outline: 'none', maxWidth: 200,
  },
  goalInput: {
    flex: 1, background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', padding: '6px 11px', fontSize: 13, outline: 'none',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  startBtn: {
    background: 'linear-gradient(135deg, var(--accent-hover) 0%, var(--accent) 100%)', border: 'none', color: 'var(--accent-fg)',
    fontSize: 13, fontWeight: 600, padding: '7px 18px', borderRadius: 'var(--radius)', whiteSpace: 'nowrap',
    boxShadow: '0 2px 8px var(--accent-glow)',
  },
  stopBtn: {
    background: 'var(--bg-elevated-2)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
    fontSize: 13, fontWeight: 600, padding: '7px 18px', borderRadius: 'var(--radius)', whiteSpace: 'nowrap', cursor: 'pointer',
  },
  proposal: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', marginBottom: 8,
    background: 'var(--accent-subtle)', border: '1px solid var(--accent-glow)', borderRadius: 'var(--radius)',
  },
  proposalText: { fontSize: 12, color: 'var(--text-secondary)' },
  approveBtn: { background: 'var(--accent)', border: 'none', color: 'var(--accent-fg)', fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 'var(--radius)', cursor: 'pointer' },
  skipBtn: { background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11, padding: '4px 10px', borderRadius: 'var(--radius)', cursor: 'pointer' },
  statusRow: { display: 'flex', gap: 10 },
  statusCol: { flex: 1, minWidth: 0 },
  colLabel: { fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 },
  clearLink: { background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer', padding: 0 },
  workerRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 11.5 },
  workerDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 },
  workerName: { color: 'var(--text-secondary)', fontWeight: 500, flexShrink: 0 },
  workerTask: { color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  logBox: { maxHeight: 84, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 },
  logLine: { fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
  logTime: { color: 'var(--text-dim)', fontSize: 10 },
  empty: { fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' },
  hint: { fontSize: 10, color: 'var(--text-dim)', marginTop: 7, textAlign: 'center' },
}
