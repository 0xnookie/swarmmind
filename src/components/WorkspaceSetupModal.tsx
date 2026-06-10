import React, { useEffect, useState } from 'react'
import type { AgentId } from '../store/workspace'
import { useT, type TFunction, type TranslationKey } from '../i18n'

interface RemoteWorkspace {
  id: string
  name: string
  root_path: string
  updated_at: number
}

interface WorkspaceSetupModalProps {
  onComplete: (rootPath: string, terminalCount: number, name: string, agentId: AgentId | null) => void
  onClose: () => void
}

const TERMINAL_COUNTS = [1, 2, 4, 6, 8, 10, 12] as const

const STEP_KEYS: TranslationKey[] = ['setup.step.folder', 'setup.step.layout', 'setup.step.agents']

const AGENTS: { id: AgentId; label: string; color: string }[] = [
  { id: 'claude',   label: 'Claude Code', color: '#c084fc' },
  { id: 'codex',    label: 'Codex',       color: '#34d399' },
  { id: 'cursor',   label: 'Cursor',      color: '#60a5fa' },
  { id: 'windsurf', label: 'Windsurf',    color: '#fb923c' },
  { id: 'kilo',     label: 'Kilo Code',   color: '#fbbf24' },
  { id: 'opencode', label: 'OpenCode',    color: '#f472b6' },
  { id: 'cline',    label: 'Cline',       color: '#a78bfa' },
]

function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

// ── Small visual helpers ────────────────────────────────────────────────────────

function GridPreview({ count }: { count: number }) {
  const W = 44, H = 36, GAP = 2, R = 1
  if (count === 1) {
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <rect x={0} y={0} width={W} height={H} rx={R} fill="currentColor" opacity="0.5" />
      </svg>
    )
  }
  const cols = 2
  const rows = Math.ceil(count / cols)
  const colW = (W - GAP * (cols - 1)) / cols
  const rowH = (H - GAP * (rows - 1)) / rows
  const rects: React.ReactNode[] = []
  let placed = 0
  for (let c = 0; c < cols && placed < count; c++) {
    const thisRows = Math.min(rows, count - placed)
    for (let r = 0; r < thisRows; r++) {
      rects.push(
        <rect key={`${c}-${r}`} x={c * (colW + GAP)} y={r * (rowH + GAP)} width={colW} height={rowH} rx={R} fill="currentColor" opacity="0.5" />
      )
    }
    placed += thisRows
  }
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>{rects}</svg>
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}
function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}
function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  )
}
function CheckIcon({ stroke = '#fff' }: { stroke?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
  )
}

// ── Stepper ──────────────────────────────────────────────────────────────────────

function Stepper({ step, canGoTo, onGoTo, t }: { step: number; canGoTo: (i: number) => boolean; onGoTo: (i: number) => void; t: TFunction }) {
  return (
    <div style={styles.stepper}>
      {STEP_KEYS.map((labelKey, i) => {
        const label = t(labelKey)
        const state: 'done' | 'active' | 'future' = i < step ? 'done' : i === step ? 'active' : 'future'
        const clickable = canGoTo(i) && i !== step
        const bg = state === 'future' ? 'var(--bg-elevated)' : 'var(--accent)'
        const fg = state === 'future' ? 'var(--text-muted)' : 'var(--accent-fg)'
        return (
          <React.Fragment key={label}>
            {i > 0 && <div style={{ ...styles.stepLine, background: i <= step ? 'var(--accent)' : 'var(--border)' }} />}
            <button
              onClick={() => clickable && onGoTo(i)}
              style={{ ...styles.stepBtn, cursor: clickable ? 'pointer' : 'default' }}
              disabled={!clickable}
            >
              <div style={{ ...styles.stepCircle, background: bg }}>
                {state === 'done' ? <CheckIcon stroke={fg} /> : <span style={{ fontSize: 11, fontWeight: 700, color: fg, lineHeight: 1 }}>{i + 1}</span>}
              </div>
              <span style={{ ...styles.stepLabel, color: state === 'active' ? 'var(--accent)' : state === 'done' ? 'var(--text-secondary)' : 'var(--text-dim)' }}>{label}</span>
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}

// ── Modal ──────────────────────────────────────────────────────────────────────

export function WorkspaceSetupModal({ onComplete, onClose }: WorkspaceSetupModalProps) {
  const t = useT()
  const [step, setStep] = useState(0)
  const [selectedPath, setSelectedPath] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [terminalCount, setTerminalCount] = useState(1)
  const [agentId, setAgentId] = useState<AgentId | null>(null)
  const [recent, setRecent] = useState<RemoteWorkspace[]>([])

  useEffect(() => {
    window.swarmmind.workspaceList().then(list => {
      if (Array.isArray(list)) setRecent((list as RemoteWorkspace[]).slice(0, 5))
    }).catch(() => {})
  }, [])

  // When a folder is chosen, default the name to its basename unless the user has
  // already typed a custom name.
  const applyFolder = (path: string, suggestedName?: string) => {
    setSelectedPath(path)
    if (!nameEdited) setName(suggestedName ?? basenameOf(path))
  }

  const handleBrowse = async () => {
    const path = await window.swarmmind.folderPick()
    if (path) applyFolder(path)
  }

  const step0Valid = !!selectedPath && !!name.trim()
  const canGoTo = (i: number) => i === 0 || step0Valid
  const goToStep = (i: number) => { if (canGoTo(i)) setStep(i) }
  const next = () => { if (step === 0 && !step0Valid) return; setStep(s => Math.min(2, s + 1)) }
  const back = () => setStep(s => Math.max(0, s - 1))
  const finish = () => { if (step0Valid) onComplete(selectedPath, terminalCount, name.trim(), agentId) }

  const gridLabel = terminalCount === 1 ? t('setup.gridSingle') : t('setup.gridMulti', { n: terminalCount, rows: Math.ceil(terminalCount / 2) })

  return (
    <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={styles.card}>
        <Stepper step={step} canGoTo={canGoTo} onGoTo={goToStep} t={t} />

        {/* ── Step 0: Folder + Name ── */}
        {step === 0 && (
          <>
            <h2 style={styles.title}>{t('setup.folder.title')}</h2>
            <p style={styles.subtitle}>{t('setup.folder.subtitle')}</p>

            <div style={styles.section}>
              <div style={styles.sectionHeader}>
                <span style={styles.sectionLabel}>{t('setup.workingFolder')}</span>
                <span style={styles.sectionHint}>{t('setup.workingFolderHint')}</span>
              </div>
              <button style={styles.folderRow} onClick={handleBrowse}>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}><FolderIcon /></span>
                <span style={{ flex: 1, minWidth: 0, textAlign: 'left', fontSize: 13, color: selectedPath ? 'var(--text-primary)' : 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedPath || t('setup.selectFolder')}
                </span>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}><SearchIcon /></span>
              </button>
            </div>

            <div style={styles.section}>
              <div style={styles.sectionHeader}>
                <span style={styles.sectionLabel}>{t('setup.workspaceName')}</span>
                <span style={styles.sectionHint}>{t('setup.workspaceNameHint')}</span>
              </div>
              <input
                style={styles.nameInput}
                value={name}
                onChange={e => { setName(e.target.value); setNameEdited(true) }}
                onKeyDown={e => { if (e.key === 'Enter') next() }}
                placeholder={selectedPath ? basenameOf(selectedPath) : t('setup.namePlaceholder')}
                spellCheck={false}
                aria-label={t('setup.workspaceName')}
                autoFocus
              />
            </div>

            {recent.length > 0 && (
              <div style={styles.section}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                    <ClockIcon /> {t('setup.recent')} <span style={styles.countBadge}>{recent.length}</span>
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('setup.reopen')}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {recent.map(ws => (
                    <button
                      key={ws.id}
                      onClick={() => applyFolder(ws.root_path, ws.name)}
                      style={{ ...styles.recentRow, background: selectedPath === ws.root_path ? 'var(--bg-elevated)' : 'transparent', borderColor: selectedPath === ws.root_path ? 'var(--border)' : 'transparent' }}
                    >
                      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}><FolderIcon /></span>
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ws.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ws.root_path}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Step 1: Layout ── */}
        {step === 1 && (
          <>
            <h2 style={styles.title}>{t('setup.layout.title')}</h2>
            <p style={styles.subtitle}>{t('setup.layout.subtitle')}</p>
            <div style={styles.section}>
              <div style={styles.sectionHeader}>
                <span style={styles.sectionLabel}>{t('setup.terminals')}</span>
                <span style={styles.gridBadge}>{gridLabel}</span>
              </div>
              <div style={styles.tileRow}>
                {TERMINAL_COUNTS.map(n => {
                  const active = terminalCount === n
                  return (
                    <button
                      key={n}
                      onClick={() => setTerminalCount(n)}
                      style={{ ...styles.tile, borderColor: active ? 'var(--accent)' : 'var(--border)', background: active ? 'rgba(232,149,107,0.08)' : 'var(--bg-elevated)', color: active ? 'var(--accent)' : 'var(--text-muted)' }}
                    >
                      <GridPreview count={n} />
                      <span style={{ fontSize: 11, fontWeight: 600, marginTop: 4, lineHeight: 1 }}>{n}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}

        {/* ── Step 2: Agent ── */}
        {step === 2 && (
          <>
            <h2 style={styles.title}>{t('setup.agents.title')}</h2>
            <p style={styles.subtitle}>{t('setup.agents.subtitle')}</p>
            <div style={styles.section}>
              <div style={styles.agentGrid}>
                <button
                  onClick={() => setAgentId(null)}
                  style={{ ...styles.agentTile, borderColor: agentId === null ? 'var(--accent)' : 'var(--border)', background: agentId === null ? 'rgba(232,149,107,0.08)' : 'var(--bg-elevated)' }}
                >
                  <span style={{ width: 9, height: 9, borderRadius: '50%', border: '1.5px dashed var(--text-dim)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: agentId === null ? 'var(--accent)' : 'var(--text-secondary)' }}>{t('setup.noAgent')}</span>
                  {agentId === null && <span style={{ marginLeft: 'auto' }}><CheckIcon stroke="var(--accent)" /></span>}
                </button>
                {AGENTS.map(a => {
                  const active = agentId === a.id
                  return (
                    <button
                      key={a.id}
                      onClick={() => setAgentId(a.id)}
                      style={{ ...styles.agentTile, borderColor: active ? 'var(--accent)' : 'var(--border)', background: active ? 'rgba(232,149,107,0.08)' : 'var(--bg-elevated)' }}
                    >
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: a.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12.5, fontWeight: 500, color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>{a.label}</span>
                      {active && <span style={{ marginLeft: 'auto' }}><CheckIcon stroke="var(--accent)" /></span>}
                    </button>
                  )
                })}
              </div>
              <p style={styles.agentNote}>
                {agentId ? t('setup.agentNoteWith', { agent: AGENTS.find(a => a.id === agentId)?.label ?? '' }) : t('setup.agentNoteWithout')}
              </p>
            </div>
          </>
        )}

        {/* ── Footer ── */}
        <div style={styles.footer}>
          {step === 0
            ? <button style={styles.cancelBtn} onClick={onClose}>{t('common.cancel')}</button>
            : <button style={styles.cancelBtn} onClick={back}>{t('common.back')}</button>}
          {step < 2
            ? (
              <button
                style={{ ...styles.createBtn, opacity: (step === 0 && !step0Valid) ? 0.4 : 1, cursor: (step === 0 && !step0Valid) ? 'not-allowed' : 'pointer' }}
                onClick={next}
                disabled={step === 0 && !step0Valid}
              >
                {t('setup.next')}
              </button>
            ) : (
              <button style={styles.createBtn} onClick={finish}>{t('setup.createWorkspace')}</button>
            )}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500,
  },
  card: {
    background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 12,
    padding: '32px 32px 28px', width: 600, maxHeight: '82vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 0,
  },
  stepper: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 24 },
  stepBtn: {
    display: 'flex', alignItems: 'center', gap: 6, background: 'transparent',
    border: 'none', padding: 0,
  },
  stepCircle: {
    width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center',
    justifyContent: 'center', flexShrink: 0, transition: 'background 150ms',
  },
  stepLabel: { fontSize: 12, fontWeight: 500, transition: 'color 150ms' },
  stepLine: { width: 40, height: 1, flexShrink: 0, transition: 'background 150ms' },
  title: { margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center', marginBottom: 6 },
  subtitle: { margin: 0, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', marginBottom: 28 },
  section: { marginBottom: 24 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  sectionLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' },
  sectionHint: { fontSize: 12, color: 'var(--text-muted)' },
  gridBadge: { marginLeft: 'auto', fontSize: 11, fontWeight: 600, background: 'rgba(232,149,107,0.15)', color: 'var(--accent)', borderRadius: 999, padding: '2px 8px' },
  folderRow: {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'var(--bg-elevated)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 12px', cursor: 'pointer', textAlign: 'left',
  },
  nameInput: {
    width: '100%', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14,
    padding: '9px 12px', outline: 'none', boxSizing: 'border-box',
  },
  tileRow: { display: 'flex', gap: 8, flexWrap: 'wrap' as const },
  tile: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    width: 72, height: 72, borderRadius: 8, border: '1px solid', cursor: 'pointer', padding: 8, gap: 4,
    transition: 'border-color 120ms, background 120ms',
  },
  agentGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  agentTile: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 8,
    border: '1px solid', cursor: 'pointer', textAlign: 'left', width: '100%',
    transition: 'border-color 120ms, background 120ms',
  },
  agentNote: { fontSize: 12, color: 'var(--text-muted)', marginTop: 14, marginBottom: 0, lineHeight: 1.5 },
  recentRow: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 6,
    border: '1px solid', cursor: 'pointer', width: '100%', transition: 'background 120ms',
  },
  countBadge: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 16, height: 16,
    borderRadius: 9999, background: 'var(--bg-elevated)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', padding: '0 4px',
  },
  footer: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
    marginTop: 4, paddingTop: 20, borderTop: '1px solid var(--border)',
  },
  cancelBtn: {
    background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 13,
    cursor: 'pointer', padding: '6px 12px', borderRadius: 'var(--radius)',
  },
  createBtn: {
    background: 'linear-gradient(135deg, var(--accent-hover) 0%, var(--accent) 100%)', border: 'none', color: 'var(--accent-fg)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '8px 20px', borderRadius: 'var(--radius)',
    transition: 'opacity 120ms', boxShadow: '0 2px 8px var(--accent-glow)', letterSpacing: '0.01em',
  },
}
