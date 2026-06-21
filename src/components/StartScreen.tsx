import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { useT, type TFunction } from '../i18n'
import { THEMES } from '../appearance'
import logoUrl from '../assets/logo.png'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RemoteWorkspace {
  id: string
  name: string
  root_path: string
  updated_at: number
}

export interface StartScreenProps {
  onOpenWorkspace: () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKSPACE_COLOR_PALETTE = [
  '#f59e0b', '#10b981', '#3b82f6', '#a855f7',
  '#ef4444', '#f97316', '#14b8a6', '#ec4899',
]

function colorFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return WORKSPACE_COLOR_PALETTE[Math.abs(hash) % WORKSPACE_COLOR_PALETTE.length]
}

function relativeTime(ms: number, t: TFunction): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return t('start.justNow')
  if (min < 60) return t('start.minutesAgo', { n: min })
  const hrs = Math.round(min / 60)
  if (hrs < 24) return t('start.hoursAgo', { n: hrs })
  const days = Math.round(hrs / 24)
  if (days < 30) return t('start.daysAgo', { n: days })
  const months = Math.round(days / 30)
  if (months < 12) return t('start.monthsAgo', { n: months })
  return t('start.yearsAgo', { n: Math.round(months / 12) })
}

function basename(p: string): string {
  if (!p) return ''
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl'

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconFolderPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      <line x1="12" y1="11" x2="12" y2="17"/>
      <line x1="9" y1="14" x2="15" y2="14"/>
    </svg>
  )
}

function IconArrow() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12"/>
      <polyline points="12 5 19 12 12 19"/>
    </svg>
  )
}

// ── Colour helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  const d = max - min
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r: h = ((g - b) / d) % 6; break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4
    }
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: s * 100, l: l * 100 }
}

// Relative luminance (0..1) for light/dark background detection.
function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

// Read a CSS custom property off the document root as a hex colour.
function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// Resolve every colour the swarm draws with from the active theme: hue follows
// the accent, and brightness/blend flip for light backgrounds so the effect
// stays visible (and tasteful) under every appearance preset.
interface SwarmPalette {
  hue: number
  sat: number
  isLight: boolean
  blend: GlobalCompositeOperation
  coreL: number
  coreA: number
  glowL: number
  glowA: number
  linkL: number
  linkA: number
}

function resolvePalette(): SwarmPalette {
  const accent = hexToRgb(readCssVar('--accent', '#d4845a')) ?? { r: 212, g: 132, b: 90 }
  const bg = hexToRgb(readCssVar('--bg-base', '#161412')) ?? { r: 22, g: 20, b: 18 }
  const { h, s } = rgbToHsl(accent.r, accent.g, accent.b)
  const isLight = luminance(bg.r, bg.g, bg.b) > 0.5
  // Clamp saturation so very grey accents (mono/contrast) still read as a swarm,
  // and very neon ones don't vibrate.
  const sat = Math.max(0, Math.min(92, s))
  return isLight
    ? { hue: h, sat, isLight, blend: 'source-over', coreL: 46, coreA: 0.85, glowL: 52, glowA: 0.16, linkL: 40, linkA: 0.20 }
    : { hue: h, sat, isLight, blend: 'lighter', coreL: 76, coreA: 0.9, glowL: 64, glowA: 0.48, linkL: 62, linkA: 0.22 }
}

// ── Swarm background ──────────────────────────────────────────────────────────
// An on-theme particle swarm (echoing the logo): motes drift, gently orbit a
// slow-moving attractor, and link up into a faint constellation when near. All
// colours derive from the active theme's accent + background (see resolvePalette).

interface Mote {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  hueJitter: number
  seed: number
}

interface SwarmCanvasProps {
  themePreset: string
  accentColor: string | null
}

function SwarmCanvas({ themePreset, accentColor }: SwarmCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    // Re-read on each (re)run so a theme/accent change repaints in the new colours.
    let pal = resolvePalette()

    let w = 0
    let h = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    let motes: Mote[] = []
    let raf = 0
    let t = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      w = rect.width
      h = rect.height
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // Scale particle count to area, but keep it light.
      const count = Math.min(90, Math.max(36, Math.round((w * h) / 16000)))
      motes = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: 0.8 + Math.random() * 2.2,
        hueJitter: (Math.random() - 0.5) * 24, // small spread around the accent hue
        seed: Math.random() * Math.PI * 2, // per-mote field phase offset
      }))
    }

    const LINK_DIST = 116
    const LINK_DIST_SQ = LINK_DIST * LINK_DIST

    // Motion is driven by a divergence-free (curl) flow field rather than point
    // attractors. A curl field never has sinks, so motes flow along endless,
    // smoothly-turning lanes and the density stays even — they never collapse
    // into a central clump/mesh the way attractor-pulled particles do.
    const FIELD = 0.0014   // spatial scale of the flow (smaller = larger swells)
    const SPEED = 0.32     // steady cruise speed (px/frame), kept constant
    const TURN = 0.045     // how quickly a mote re-aligns to the field (smooth)

    const frame = () => {
      t += 0.0024
      ctx.clearRect(0, 0, w, h)

      for (const m of motes) {
        if (!reduced) {
          // Curl of a scalar potential P(x,y,t): velocity = (∂P/∂y, -∂P/∂x).
          // Each mote samples a slightly offset field (m.seed) so they don't
          // all march in lockstep.
          const a = m.x * FIELD + t + m.seed
          const b = m.y * FIELD - t * 0.8 + m.seed
          const fx = -Math.sin(a) * Math.cos(b)
          const fy = Math.cos(a) * Math.sin(b)
          const fmag = Math.hypot(fx, fy) || 1
          // Steer toward the field direction at a fixed speed (smooth turns,
          // no acceleration into a pile, no stalling into a clump).
          const tvx = (fx / fmag) * SPEED
          const tvy = (fy / fmag) * SPEED
          m.vx += (tvx - m.vx) * TURN
          m.vy += (tvy - m.vy) * TURN
          m.x += m.vx
          m.y += m.vy
        }

        // Wrap around edges to keep the field tiling seamlessly.
        if (m.x < -20) m.x = w + 20
        else if (m.x > w + 20) m.x = -20
        if (m.y < -20) m.y = h + 20
        else if (m.y > h + 20) m.y = -20
      }

      // Constellation links (drawn first, under the motes).
      ctx.lineWidth = 1
      for (let i = 0; i < motes.length; i++) {
        const a = motes[i]
        for (let j = i + 1; j < motes.length; j++) {
          const b = motes[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dsq = dx * dx + dy * dy
          if (dsq > LINK_DIST_SQ) continue
          const alpha = (1 - dsq / LINK_DIST_SQ) * pal.linkA
          ctx.strokeStyle = `hsla(${pal.hue}, ${pal.sat}%, ${pal.linkL}%, ${alpha})`
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }

      // Glowing motes — additive bloom on dark themes, plain alpha on light ones.
      ctx.globalCompositeOperation = pal.blend
      for (const m of motes) {
        const hue = pal.hue + m.hueJitter
        const glow = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 4)
        glow.addColorStop(0, `hsla(${hue}, ${pal.sat}%, ${pal.glowL}%, ${pal.glowA})`)
        glow.addColorStop(1, `hsla(${hue}, ${pal.sat}%, ${pal.glowL}%, 0)`)
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(m.x, m.y, m.r * 4, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = `hsla(${hue}, ${pal.sat}%, ${pal.coreL}%, ${pal.coreA})`
        ctx.beginPath()
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'

      raf = requestAnimationFrame(frame)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // Re-run when the theme or accent changes so colours/blend track the new
    // appearance (applyAppearance has already updated the CSS vars synchronously).
  }, [themePreset, accentColor])

  return <canvas ref={canvasRef} style={styles.swarmCanvas} aria-hidden="true" />
}

// ── Main component ────────────────────────────────────────────────────────────

export function StartScreen({ onOpenWorkspace }: StartScreenProps) {
  const t = useT()
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([])
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace)
  const loadFromJson = useWorkspaceStore(s => s.loadFromJson)
  const resetLayout = useWorkspaceStore(s => s.resetLayout)
  const toggleCommandPalette = useWorkspaceStore(s => s.toggleCommandPalette)
  const themePreset = useWorkspaceStore(s => s.themePreset)
  const accentColor = useWorkspaceStore(s => s.accentColor)

  // Contrast-aware text colour for the accent-filled CTA: dark text on a light
  // accent, light text on a dark one (so it stays legible on every theme).
  const onAccent = useMemo(() => {
    const hex = accentColor || THEMES[themePreset]?.vars['--accent'] || '#d4845a'
    const c = hexToRgb(hex)
    if (!c) return '#1a1410'
    return luminance(c.r, c.g, c.b) > 0.5 ? '#1a1410' : '#ffffff'
  }, [themePreset, accentColor])

  useEffect(() => {
    window.swarmmind.workspaceList()
      .then(list => { if (Array.isArray(list)) setWorkspaces(list as RemoteWorkspace[]) })
      .catch(() => {})
  }, [])

  const recent = useMemo(
    () => [...workspaces].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, 6),
    [workspaces],
  )

  const openWorkspace = async (id: string) => {
    try {
      const info = await window.swarmmind.workspaceOpenById(id)
      if (info && !info.error) {
        setWorkspace({ id: info.id, name: info.name, rootPath: info.rootPath })
        if (info.savedLayout) loadFromJson(info.savedLayout)
        else resetLayout()
      }
    } catch { /* ignore */ }
  }

  return (
    <main style={styles.root}>
      {/* Layered ambient background: drifting colour orbs, a particle swarm,
          and a soft vignette so the foreground content stays readable. */}
      <div style={{ ...styles.orb, ...styles.orbWarm }} aria-hidden="true" />
      <div style={{ ...styles.orb, ...styles.orbAmber }} aria-hidden="true" />
      <SwarmCanvas themePreset={themePreset} accentColor={accentColor} />
      <div style={styles.vignette} aria-hidden="true" />

      <div style={styles.content}>
        {/* Brand */}
        <div className="start-fade" style={{ ...styles.brand, animationDelay: '0ms' }}>
          <img src={logoUrl} alt="" width={104} height={104} draggable={false} style={styles.logo} />
          <h1 style={styles.wordmark}>SwarmMind</h1>
          <p style={styles.tagline}>{t('start.tagline')}</p>
        </div>

        {/* Primary action */}
        <div className="start-fade" style={{ ...styles.actions, animationDelay: '90ms' }}>
          <button className="start-cta" style={{ ...styles.cta, color: onAccent }} onClick={onOpenWorkspace}>
            <IconFolderPlus />
            <span>{t('start.openWorkspace')}</span>
          </button>
          <button style={styles.secondaryBtn} onClick={toggleCommandPalette}>
            {t('start.commandPalette')}
            <kbd style={styles.kbd}>{mod}</kbd>
            <kbd style={styles.kbd}>K</kbd>
          </button>
        </div>

        {/* First run — orient a brand-new user (no recent workspaces yet) */}
        {recent.length === 0 && (
          <div className="start-fade" style={{ ...styles.firstRunWrap, animationDelay: '180ms' }}>
            <div style={styles.recentLabel}>{t('start.firstRun.heading')}</div>
            <div style={styles.steps}>
              {[
                { title: t('start.firstRun.step1Title'), body: t('start.firstRun.step1Body') },
                { title: t('start.firstRun.step2Title'), body: t('start.firstRun.step2Body') },
                { title: t('start.firstRun.step3Title'), body: t('start.firstRun.step3Body') },
              ].map((s, i) => (
                <div key={i} style={styles.step}>
                  <span style={{ ...styles.stepNum, color: onAccent }}>{i + 1}</span>
                  <span style={styles.stepText}>
                    <span style={styles.stepTitle}>{s.title}</span>
                    <span style={styles.stepBody}>{s.body}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent workspaces */}
        {recent.length > 0 && (
          <div className="start-fade" style={{ ...styles.recentWrap, animationDelay: '180ms' }}>
            <div style={styles.recentLabel}>{t('start.recent')}</div>
            <div style={styles.recentGrid}>
              {recent.map(ws => (
                <button
                  key={ws.id}
                  className="start-recent-card"
                  style={styles.recentCard}
                  onClick={() => openWorkspace(ws.id)}
                  title={ws.root_path}
                >
                  <span style={{ ...styles.recentDot, background: colorFor(ws.id) }} />
                  <span style={styles.recentText}>
                    <span style={styles.recentName}>{ws.name}</span>
                    <span style={styles.recentPath}>{basename(ws.root_path)}</span>
                  </span>
                  <span style={styles.recentMeta}>{relativeTime(ws.updated_at, t)}</span>
                  <span style={styles.recentArrow}><IconArrow /></span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    flex: 1,
    minWidth: 0,
    position: 'relative',
    background: 'var(--bg-base)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 24,
  },
  swarmCanvas: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    opacity: 0.9,
  },
  orb: {
    position: 'absolute',
    borderRadius: '50%',
    pointerEvents: 'none',
    filter: 'blur(60px)',
    willChange: 'transform',
  },
  orbWarm: {
    width: 560,
    height: 560,
    top: '50%',
    left: '50%',
    marginTop: -380,
    marginLeft: -300,
    // Theme-driven: --accent-glow is rgba(accent, 0.28), recomputed per appearance.
    background: 'radial-gradient(circle at center, var(--accent-glow) 0%, transparent 70%)',
    animation: 'start-aurora 18s ease-in-out infinite',
  },
  orbAmber: {
    width: 460,
    height: 460,
    top: '50%',
    left: '50%',
    marginTop: -120,
    marginLeft: -60,
    background: 'radial-gradient(circle at center, var(--accent-subtle) 0%, transparent 70%)',
    animation: 'start-aurora 22s ease-in-out infinite reverse',
  },
  vignette: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    background: 'radial-gradient(ellipse at center, transparent 38%, var(--bg-base) 92%)',
  },
  content: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxWidth: 560,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  brand: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
  },
  logo: {
    borderRadius: 24,
    animation: 'start-logo-glow 4.5s ease-in-out infinite',
  },
  wordmark: {
    marginTop: 22,
    fontSize: 40,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    color: 'var(--text-primary)',
    background: 'linear-gradient(180deg, var(--text-primary) 0%, var(--text-secondary) 140%)',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
  },
  tagline: {
    marginTop: 10,
    fontSize: 14.5,
    lineHeight: 1.5,
    color: 'var(--text-muted)',
    maxWidth: 360,
  },
  actions: {
    marginTop: 34,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 14,
  },
  cta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    height: 46,
    padding: '0 26px',
    borderRadius: 23,
    border: 'none',
    background: 'var(--accent)',
    color: '#1a1410',
    fontSize: 15,
    fontWeight: 600,
    fontFamily: 'var(--font-ui)',
    cursor: 'pointer',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  secondaryBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: 12.5,
    fontFamily: 'var(--font-ui)',
    cursor: 'pointer',
    padding: 4,
  },
  kbd: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 18,
    height: 18,
    padding: '0 5px',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'var(--font-ui)',
  },
  recentWrap: {
    marginTop: 44,
    width: '100%',
  },
  firstRunWrap: {
    marginTop: 44,
    width: '100%',
  },
  steps: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  step: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '12px 14px',
    borderRadius: 10,
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-panel)',
    textAlign: 'left',
  },
  stepNum: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    borderRadius: 9999,
    background: 'var(--accent)',
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
    fontFamily: 'var(--font-ui)',
    marginTop: 1,
  },
  stepText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  },
  stepTitle: {
    fontSize: 13.5,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  stepBody: {
    fontSize: 12,
    lineHeight: 1.45,
    color: 'var(--text-muted)',
  },
  recentLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--text-muted)',
    fontWeight: 600,
    marginBottom: 12,
    paddingLeft: 2,
  },
  recentGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 8,
  },
  recentCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '11px 13px',
    borderRadius: 10,
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-panel)',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'var(--font-ui)',
    overflow: 'hidden',
  },
  recentDot: {
    width: 9,
    height: 9,
    borderRadius: 9999,
    flexShrink: 0,
  },
  recentText: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
    gap: 2,
  },
  recentName: {
    fontSize: 13.5,
    fontWeight: 500,
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  recentPath: {
    fontSize: 11,
    color: 'var(--text-dim)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  recentMeta: {
    fontSize: 10.5,
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  recentArrow: {
    display: 'flex',
    alignItems: 'center',
    color: 'var(--text-dim)',
    flexShrink: 0,
  },
}
