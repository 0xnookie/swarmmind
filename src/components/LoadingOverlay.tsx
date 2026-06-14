import React from 'react'
import { useLoadingStore, type LoadingTask } from '../store/loading'
import { useT } from '../i18n'

// ── Loading overlay ─────────────────────────────────────────────────────────────
// Renders the active loading tasks from the loading store (see store/loading.ts).
// At most one 'overlay' task is shown as a centred, backdrop-blurred card the user
// is actively waiting on; 'ambient' tasks stack as small bottom-left pills for
// background work. While an overlay is up, ambient pills are hidden to avoid
// doubling up on the same load.

const RING_SIZE = 84
const RING_STROKE = 5
const RING_R = (RING_SIZE - RING_STROKE) / 2
const RING_C = 2 * Math.PI * RING_R

// Spinning arc + (determinate) progress fill, with a soft pulsing halo behind it.
// `showLabel` (default true) draws the % / dots in the centre — turned off for the
// tiny ambient ring, which would otherwise overflow and shows its % beside it.
function ProgressRing({ progress, size = RING_SIZE, stroke = RING_STROKE, showLabel = true }: {
  progress: number | null
  size?: number
  stroke?: number
  showLabel?: boolean
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const determinate = progress != null
  const pct = Math.max(0, Math.min(100, progress ?? 0))
  // Scale the centre label to the ring so it never spills out (84px → ~20px).
  const labelSize = Math.round(size * 0.24)

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {/* Pulsing accent halo */}
      <div
        className="loading-halo"
        style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)',
        }}
      />
      {/* Indeterminate spins the whole <svg> (a plain CSS box → reliable
          transform-origin: center, unlike a nested <g> with transform-box).
          Determinate stays still and grows the arc via stroke-dashoffset. */}
      <svg
        width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        className={determinate ? undefined : 'loading-ring'}
        style={{ position: 'relative', transformOrigin: 'center' }}
      >
        {/* Track */}
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="var(--border-strong)" strokeWidth={stroke}
        />
        {/* Arc: full progress when determinate, a fixed ~28% sweep when spinning. */}
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="var(--accent)" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={determinate ? c * (1 - pct / 100) : c * 0.72}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: determinate ? 'stroke-dashoffset 350ms ease-out' : 'none' }}
        />
      </svg>
      {/* Centre label: % when known, animated dots while preparing */}
      {showLabel && (
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: labelSize, fontWeight: 600, color: 'var(--text-primary)',
        letterSpacing: '-0.02em',
      }}>
        {determinate ? `${Math.round(pct)}%` : (
          <span style={{ display: 'inline-flex', gap: 3 }}>
            {[0, 1, 2].map(i => (
              <span key={i} className="loading-dot" style={{
                width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)',
                animationDelay: `${i * 0.18}s`,
              }} />
            ))}
          </span>
        )}
      </div>
      )}
    </div>
  )
}

function OverlayCard({ task }: { task: LoadingTask }) {
  const t = useT()
  const dismissLoading = useLoadingStore(s => s.dismissLoading)
  const determinate = task.progress != null
  const pct = Math.max(0, Math.min(100, task.progress ?? 0))

  return (
    <div className="loading-backdrop" style={styles.backdrop}>
      <div className="loading-card" style={styles.card} role="status" aria-live="polite">
        <ProgressRing progress={task.progress} />

        <div style={{ textAlign: 'center' }}>
          <div style={styles.title}>{task.title}</div>
          {task.detail && <div style={styles.detail}>{task.detail}</div>}
        </div>

        {/* Slim reinforcing bar — determinate fill with a travelling shine, or a
            sweeping indeterminate bar while preparing. */}
        <div style={styles.barTrack}>
          {determinate ? (
            <div style={{ ...styles.barFill, width: `${pct}%` }}>
              <div className="loading-bar-shine" style={styles.barShine} />
            </div>
          ) : (
            <div className="loading-bar-indeterminate" style={styles.barIndeterminate} />
          )}
        </div>

        {task.hint && <div style={styles.hint}>{task.hint}</div>}

        {task.dismissible && (
          <button
            type="button"
            onClick={() => dismissLoading(task.id)}
            className="pane-action-btn"
            style={styles.dismiss}
          >
            {t('loading.continueBackground')}
          </button>
        )}
      </div>
    </div>
  )
}

function AmbientPill({ task }: { task: LoadingTask }) {
  return (
    <div className="loading-ambient" style={styles.pill} role="status" aria-live="polite">
      <ProgressRing progress={task.progress} size={18} stroke={2.5} showLabel={false} />
      <span style={styles.pillTitle}>{task.title}</span>
      {task.progress != null && (
        <span style={styles.pillPct}>{Math.round(task.progress)}%</span>
      )}
    </div>
  )
}

export function LoadingOverlay() {
  const tasks = useLoadingStore(s => s.tasks)
  const list = Object.values(tasks)
  if (list.length === 0) return null

  // Most recently-started overlay wins the centre slot.
  const overlay = list.filter(t => t.variant === 'overlay').at(-1)
  // Hide ambient pills while a blocking overlay is up (they're usually the same load).
  const ambient = overlay ? [] : list.filter(t => t.variant === 'ambient')

  return (
    <>
      {overlay && <OverlayCard task={overlay} />}
      {ambient.length > 0 && (
        <div style={styles.ambientStack}>
          {ambient.map(t => <AmbientPill key={t.id} task={t} />)}
        </div>
      )}
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 6000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'color-mix(in srgb, var(--bg-base) 70%, transparent)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  },
  card: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
    width: 360, maxWidth: '86vw', padding: '32px 28px 26px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-strong)',
    borderRadius: 18,
    boxShadow: '0 24px 64px rgba(0,0,0,0.45), 0 0 0 1px var(--border-subtle)',
  },
  title: {
    fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em',
  },
  detail: {
    marginTop: 4, fontSize: 12.5, color: 'var(--text-secondary)',
  },
  barTrack: {
    position: 'relative', width: '100%', height: 5, borderRadius: 3,
    background: 'var(--border-subtle)', overflow: 'hidden',
  },
  barFill: {
    position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3,
    background: 'linear-gradient(90deg, var(--accent-hover), var(--accent))',
    overflow: 'hidden', transition: 'width 350ms ease-out',
    boxShadow: '0 0 8px var(--accent-glow)',
  },
  barShine: {
    position: 'absolute', top: 0, bottom: 0, width: '40%',
    background: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent-fg) 55%, transparent), transparent)',
  },
  barIndeterminate: {
    position: 'absolute', top: 0, bottom: 0, left: '-40%', width: '40%', borderRadius: 3,
    background: 'linear-gradient(90deg, var(--accent-hover), var(--accent))',
    boxShadow: '0 0 8px var(--accent-glow)',
  },
  hint: {
    fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 280, lineHeight: 1.45,
  },
  dismiss: {
    marginTop: 2, fontSize: 12, padding: '5px 12px',
  },
  ambientStack: {
    position: 'fixed', left: 16, bottom: 16, zIndex: 5500,
    display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none',
  },
  pill: {
    display: 'inline-flex', alignItems: 'center', gap: 9,
    padding: '7px 13px 7px 9px', borderRadius: 999,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
    boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
  },
  pillTitle: {
    fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap',
  },
  pillPct: {
    fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
  },
}
