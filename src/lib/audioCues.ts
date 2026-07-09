// Ambient audio cues for swarm signals — a soft ping when an agent needs you, a
// tick when one finishes a turn, a low warble on file contention. Attached to
// existing signals in App.tsx; opt-in via Settings (soundCues). WebAudio
// oscillators only (no assets), quiet by design, and rate-limited per kind so a
// busy swarm never becomes a slot machine.

export type CueKind = 'attention' | 'done' | 'contention'

const MIN_GAP_MS: Record<CueKind, number> = {
  attention: 2_000,
  done: 4_000,
  contention: 3_000,
}

let ctx: AudioContext | null = null
const lastPlayed = new Map<CueKind, number>()

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    return ctx
  } catch {
    return null
  }
}

function tone(
  ac: AudioContext,
  freq: number,
  start: number,
  dur: number,
  peak = 0.06,
  type: OscillatorType = 'sine',
): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.linearRampToValueAtTime(peak, start + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(start)
  osc.stop(start + dur + 0.05)
}

/** Play one cue (best-effort, rate-limited per kind). */
export function playCue(kind: CueKind): void {
  const now = Date.now()
  if (now - (lastPlayed.get(kind) ?? 0) < MIN_GAP_MS[kind]) return
  lastPlayed.set(kind, now)
  const ac = ensureCtx()
  if (!ac) return
  const t0 = ac.currentTime + 0.01
  try {
    if (kind === 'attention') {
      // Two-note "needs you" ping, falling — friendly, not alarming.
      tone(ac, 880, t0, 0.18)
      tone(ac, 660, t0 + 0.15, 0.22)
    } else if (kind === 'done') {
      // Single soft tick for "finished a turn".
      tone(ac, 520, t0, 0.12, 0.04)
    } else {
      // Low two-tone warble for contention — noticeable, slightly tense.
      tone(ac, 330, t0, 0.16, 0.07, 'triangle')
      tone(ac, 311, t0 + 0.13, 0.2, 0.07, 'triangle')
    }
  } catch { /* audio is best-effort */ }
}
