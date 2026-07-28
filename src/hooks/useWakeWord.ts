import { useEffect, useRef, useState } from 'react'
import { ensureVoiceModel, transcribeAudio, isVoiceModelLoaded, WAKE_MODEL } from './useVoice'
import { initVad, stepVad, frameLoudness, WAKE_VAD } from '../lib/vad'
import { matchWakeWord, isValidWakePhrase } from '../lib/wakeWord'

// ── Wake-word listener ────────────────────────────────────────────────────────
//
// Keeps the mic open and, whenever it hears an utterance, asks Whisper what was
// said and `matchWakeWord` whether it began with the wake phrase. On a hit it
// hands the result to `onWake` — with any command spoken in the same breath, so
// "hey swarm, run the tests" is one utterance rather than two.
//
// **Why this is a separate hook rather than a mode inside `useVoice`.** The
// dictation path in `useVoice` is tuned and load-bearing (see the decode and
// `{language, task}` notes there), and threading a second lifecycle through its
// `start`/`stop` state machine would put every dictation at risk to add a
// feature that is off by default. This owns its own mic and recorder and shares
// the machinery that's actually subtle — the model registry and
// `transcribeAudio` (decode + normalise + the Whisper call). What is duplicated
// is the mechanical `getUserMedia` + `MediaRecorder` + rAF-VAD wiring, and only
// that.
//
// **Latency is the whole design constraint.** What the user feels is the gap
// between finishing the phrase and the app reacting, and it has exactly three
// terms: the VAD hangover (`WAKE_VAD.hangoverMs`, pure dead time), the Whisper
// pass, and — on a phrase-only wake — getting dictation recording. Each is
// attacked directly: the hangover is set as low as it can go given that an
// early cut degrades into the two-step flow, the pass runs on `WAKE_MODEL`
// rather than the dictation model with a bounded decoder, and the microphone is
// handed to dictation live instead of being released and re-acquired.
//
// **Cost.** A Whisper pass runs per *utterance*, not per second: the VAD gates
// it, so a silent room costs one analyser rAF and nothing else. Speech near the
// mic does get transcribed locally to be checked — it never leaves the machine
// (the model is on-device), but it is CPU, which is why this is opt-in.

export type WakeStatus = 'off' | 'loading' | 'armed' | 'checking' | 'error'

export interface UseWakeWordOptions {
  enabled: boolean
  phrase: string
  /**
   * Fired when the wake phrase is heard. `command` is anything said after it in
   * the same breath, or '' when the phrase was spoken alone — which the caller
   * should treat as "open dictation now".
   *
   * On that phrase-alone hand-off, `stream` is the listener's **still-live**
   * microphone: dictation should adopt it rather than call `getUserMedia`
   * again, which is a device round trip in the one moment the user is waiting.
   * The listener has already given up ownership, so whoever takes it must stop
   * it. `null` when a command came along and nothing else needs the mic.
   */
  onWake: (command: string, stream: MediaStream | null) => void
  /**
   * Suspends listening and releases the mic. Set while dictation (or anything
   * else) owns the microphone, so the two never record each other.
   */
  paused: boolean
}

export interface UseWakeWordReturn {
  wakeStatus: WakeStatus
  wakeError: string | null
}

/** Record one VAD-delimited utterance. Resolves null if aborted or silent. */
function recordUtterance(
  stream: MediaStream,
  analyser: AnalyserNode,
  isAborted: () => boolean
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType })
    const chunks: Blob[] = []
    // Was any speech heard at all? A segment that only ever hit the max-duration
    // ceiling on room tone is silence, and transcribing it wastes a Whisper pass.
    let heardSpeech = false
    let raf: number | null = null

    const finish = (blob: Blob | null) => {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null }
      resolve(blob)
    }

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => {
      finish(heardSpeech && !isAborted() ? new Blob(chunks, { type: 'audio/webm' }) : null)
    }

    const bins = new Uint8Array(analyser.frequencyBinCount)
    let vad = initVad(performance.now())

    const tick = () => {
      if (isAborted()) {
        raf = null
        if (recorder.state === 'recording') recorder.stop()
        else finish(null)
        return
      }
      analyser.getByteFrequencyData(bins)
      const res = stepVad(vad, frameLoudness(bins), performance.now(), WAKE_VAD)
      vad = res.state
      if (res.state.speechStarted) heardSpeech = true
      if (res.verdict === 'stop-silence' || res.verdict === 'stop-max') {
        // Cancel before stopping so the async onstop can't race another frame.
        raf = null
        if (recorder.state === 'recording') recorder.stop()
        return
      }
      raf = requestAnimationFrame(tick)
    }

    recorder.start()
    raf = requestAnimationFrame(tick)
  })
}

export function useWakeWord({
  enabled, phrase, onWake, paused,
}: UseWakeWordOptions): UseWakeWordReturn {
  const [wakeStatus, setWakeStatus] = useState<WakeStatus>('off')
  const [wakeError, setWakeError] = useState<string | null>(null)

  // Read live inside the long-running loop so editing the phrase in Settings
  // takes effect on the next utterance instead of needing a re-arm.
  const phraseRef = useRef(phrase)
  phraseRef.current = phrase
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake

  // Bumped after a wake that handed off to dictation, so the listener re-arms
  // even if the hand-off never actually started (no active pane, say) and
  // `paused` therefore never flipped.
  const [cycle, setCycle] = useState(0)

  const active = enabled && !paused && isValidWakePhrase(phrase)

  useEffect(() => {
    if (!active) {
      setWakeStatus('off')
      return
    }

    let aborted = false
    const isAborted = () => aborted
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null

    const run = async () => {
      try {
        if (!isVoiceModelLoaded(WAKE_MODEL)) setWakeStatus('loading')
        await ensureVoiceModel(WAKE_MODEL)
        if (aborted) return

        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        if (aborted) return

        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        // Barely smoothed, unlike dictation's analyser. Smoothing is a decaying
        // average, so it makes the reading *trail* the actual audio — which is
        // exactly what a silence detector must not do, since every frame of lag
        // is added to the wake latency. Dictation keeps 0.65 because its
        // analyser also drives the waveform bars, where the smoothing is the
        // point; nothing here is drawn, so there's nothing to trade away.
        analyser.smoothingTimeConstant = 0.2
        ctx.createMediaStreamSource(stream).connect(analyser)

        setWakeError(null)

        while (!aborted) {
          setWakeStatus('armed')
          const blob = await recordUtterance(stream, analyser, isAborted)
          if (aborted) return
          if (!blob) continue

          setWakeStatus('checking')
          // `WAKE_MODEL`, not the dictation selection: this runs on every
          // utterance and sits in the latency the user feels. `maxTokens` bounds
          // the decoder so a long background conversation can't make the model
          // narrate for seconds before we discard it.
          const text = await transcribeAudio(blob, { model: WAKE_MODEL, maxTokens: 48 })
          if (aborted) return

          const hit = matchWakeWord(text, phraseRef.current)
          if (!hit.matched) continue

          if (hit.rest) {
            // The command rode along with the phrase, so nothing else needs the
            // mic — handle it and stay armed.
            onWakeRef.current(hit.rest, null)
            continue
          }

          // The phrase was spoken alone: the caller is about to open dictation
          // and needs the microphone. Hand the *live* stream over rather than
          // stopping it and letting dictation re-acquire — `getUserMedia` is a
          // device round trip, and this is precisely the moment the user is
          // waiting. Ownership transfers with it: we drop the reference (so
          // neither this loop nor the effect cleanup stops it) and dictation
          // stops it when it's done.
          const handOff = stream
          stream = null
          try { ctx?.close() } catch { /* ignore */ }
          ctx = null
          setWakeStatus('off')
          onWakeRef.current('', handOff)

          // Re-arm. Normally `paused` going true→false does it once dictation
          // ends; the cycle bump is the fallback for when the hand-off never
          // happened at all (no active pane, say) and `paused` never moved.
          setTimeout(() => setCycle((c) => c + 1), 800)
          return
        }
      } catch (err) {
        if (aborted) return
        const msg = err instanceof Error ? err.message : 'Wake word listening failed'
        console.error('[SwarmVoice] wake-word listener failed:', err)
        setWakeError(msg)
        setWakeStatus('error')
      }
    }

    void run()

    return () => {
      aborted = true
      stream?.getTracks().forEach((tr) => tr.stop())
      try { ctx?.close() } catch { /* ignore */ }
      setWakeStatus('off')
    }
  }, [active, cycle])

  return { wakeStatus, wakeError }
}
