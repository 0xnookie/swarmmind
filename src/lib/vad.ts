// Voice activity detection — the decision half.
//
// SwarmVoice used to require an explicit stop: press the shortcut, talk, press
// it again. That's one keystroke too many for dictation, and it delays the
// transcript by however long it takes the user to reach for the key.
//
// This tracks whether the mic is hearing speech and decides when a recording
// has ended, so dictation can stop itself. Pure and frame-driven: the caller
// feeds it a loudness reading per animation frame and gets back the next state.
// No timers, no audio APIs — so the tricky part (when *not* to stop) is
// unit-testable.

export interface VadState {
  // True once we've heard speech at all this recording. Auto-stop is armed only
  // after this, so a slow start (or a moment of thinking before speaking) never
  // ends the recording before it begins.
  speechStarted: boolean
  // Epoch ms of the last frame that was loud enough to count as speech.
  lastLoudAt: number
  // Epoch ms when the recording began.
  startedAt: number
}

export interface VadOptions {
  // Loudness (0..1 RMS-ish) above which a frame counts as speech. Above typical
  // room tone, below normal speaking volume.
  threshold: number
  // Silence after speech that ends the recording.
  hangoverMs: number
  // A recording never auto-stops before this, so a cough or a one-word answer
  // can't produce a clip too short to transcribe.
  minDurationMs: number
  // Hard ceiling: stop regardless, so a stuck-open mic can't record forever
  // (and can't hand Whisper a clip so long it takes minutes to process).
  maxDurationMs: number
}

export const DEFAULT_VAD: VadOptions = {
  threshold: 0.055,
  hangoverMs: 1800,
  minDurationMs: 900,
  maxDurationMs: 120_000,
}

// Wake-word listening is the same detector with a much shorter fuse. Every
// segment it captures gets a Whisper pass, so the tuning goal is the opposite of
// dictation's: end each utterance quickly and cap it hard, rather than wait
// patiently for someone composing a long sentence.
//
// `hangoverMs` is the one that matters — at dictation's 1.8s the wake phrase
// wouldn't reach the model until nearly two seconds after it was spoken, which
// reads as an unresponsive assistant. The ceiling still has to be generous
// enough to hold "hey swarm, run the test suite and show me what failed" in one
// breath, since that whole sentence is one segment.
export const WAKE_VAD: VadOptions = {
  threshold: 0.055,
  hangoverMs: 700,
  minDurationMs: 350,
  maxDurationMs: 10_000,
}

export function initVad(now: number): VadState {
  return { speechStarted: false, lastLoudAt: now, startedAt: now }
}

export type VadVerdict = 'listening' | 'speaking' | 'stop-silence' | 'stop-max'

export interface VadResult {
  state: VadState
  verdict: VadVerdict
}

// Advance the detector by one frame. `level` is the current loudness in 0..1.
export function stepVad(
  state: VadState,
  level: number,
  now: number,
  opts: VadOptions = DEFAULT_VAD,
): VadResult {
  const loud = level >= opts.threshold
  const next: VadState = {
    speechStarted: state.speechStarted || loud,
    lastLoudAt: loud ? now : state.lastLoudAt,
    startedAt: state.startedAt,
  }

  const elapsed = now - next.startedAt
  if (elapsed >= opts.maxDurationMs) return { state: next, verdict: 'stop-max' }

  // Everything below here is the silence path, and all three guards matter:
  // never stop before speech was heard, never stop a too-short clip, and only
  // stop once the silence has actually lasted the hangover.
  if (!next.speechStarted) return { state: next, verdict: 'listening' }
  if (loud) return { state: next, verdict: 'speaking' }
  if (elapsed < opts.minDurationMs) return { state: next, verdict: 'speaking' }
  const silentFor = now - next.lastLoudAt
  return silentFor >= opts.hangoverMs
    ? { state: next, verdict: 'stop-silence' }
    : { state: next, verdict: 'speaking' }
}

// Collapse a frequency-bin array into one loudness figure. Shared by the VAD
// and the waveform so "what the bars show" and "what auto-stop reacts to" can
// never drift apart.
export function frameLoudness(bins: Uint8Array | number[], usableFraction = 0.6): number {
  const n = Math.max(1, Math.floor(bins.length * usableFraction))
  let sum = 0
  for (let i = 0; i < n; i++) sum += bins[i]
  return Math.min(1, sum / n / 140)
}
