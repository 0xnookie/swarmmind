import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { onnxThreadCount } from '../lib/onnxThreads'
import { initVad, stepVad, frameLoudness, DEFAULT_VAD, type VadState } from '../lib/vad'

export type VoiceStatus = 'idle' | 'model-loading' | 'recording' | 'transcribing' | 'error'

export const BAR_COUNT = 5

// Whisper's input rate. Decoding straight to this avoids a second resampling
// pass over the whole clip — see the decode note in `onstop`.
const WHISPER_SAMPLE_RATE = 16000

// ── Live audio levels ────────────────────────────────────────────────────────
//
// The waveform used to be React state written on every animation frame, so
// recording re-rendered the component (and its parents) ~60×/s just to move
// five bars. The levels now live in a module-scope buffer that the analyser
// loop mutates in place; the bars read it from their own rAF and write straight
// to the DOM. Recording is a zero-render operation, and any number of surfaces
// (the TopBar button, the floating widget) can show the same live levels
// without multiplying the cost.

const _levels: number[] = Array(BAR_COUNT).fill(0)

export function readAudioLevels(): readonly number[] {
  return _levels
}

// Whisper models the user can pick in Settings → General → SwarmVoice
// (persisted as the `voiceModel` app setting; store field `voiceModel`).
// All are English-only `.en` models, so the transcribe call passes NO
// language/task options (see the onstop note). The model downloads once and is
// cached on the filesystem (see the custom cache below). Default is `base`:
// markedly more accurate than `tiny` and still fast on the threaded WASM
// backend; `small` is the accuracy-over-speed option.
export type VoiceModel = 'tiny' | 'base' | 'small'
export const VOICE_MODELS: Record<VoiceModel, { repo: string; sizeMB: number }> = {
  tiny:  { repo: 'Xenova/whisper-tiny.en',  sizeMB: 40 },
  base:  { repo: 'Xenova/whisper-base.en',  sizeMB: 75 },
  small: { repo: 'Xenova/whisper-small.en', sizeMB: 250 },
}

// ── Model registry ─────────────────────────────────────────────────────────────
// Loaded pipelines live at module scope so they survive component remounts.
//
// Keyed **per model** rather than a single slot, because two are wanted at once:
// dictation uses whatever the user picked for accuracy, while wake-word
// detection uses `WAKE_MODEL` (below) for speed. A single slot would make the
// two evict each other on every utterance — the worst of both. When the user has
// already selected the wake model for dictation, both simply share one entry.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ASRFn = (audio: Float32Array, opts?: object) => Promise<any>
const _pipelines = new Map<VoiceModel, ASRFn>()
const _loads = new Map<VoiceModel, Promise<ASRFn>>()

/**
 * The model wake-word detection runs on, independent of the dictation setting.
 *
 * Wake detection is a fuzzy match against a two-word phrase, not transcription
 * anyone reads — `tiny.en` is entirely good enough for it and roughly halves the
 * inference cost of `base.en`. That cost is paid on *every* utterance near the
 * mic while armed, and it sits directly in the latency the user feels between
 * saying the phrase and the app reacting, so it's the one place where the
 * smallest model is unambiguously the right call.
 */
export const WAKE_MODEL: VoiceModel = 'tiny'

// Filesystem-backed cache for @xenova/transformers, implementing the Web Cache
// `match`/`put` interface it expects from `env.customCache`. The browser Cache
// API does NOT persist on the packaged app's `file://` origin, so the model used
// to re-download on every launch; routing the cache through IPC to a real
// directory under userData makes it survive restarts. `match` reconstructs a
// Response from the stored bytes + headers (transformers reads it via
// `.arrayBuffer()` / a progress stream); a miss returns undefined so the file is
// fetched from HuggingFace and handed to `put`.
function makePersistentCache() {
  return {
    async match(key: string): Promise<Response | undefined> {
      try {
        const hit = await window.swarmmind.voiceCacheMatch(key)
        if (!hit) return undefined
        return new Response(hit.data, { status: 200, headers: hit.headers })
      } catch {
        return undefined
      }
    },
    async put(key: string, response: Response): Promise<void> {
      try {
        const buf = await response.arrayBuffer()
        const headers: Record<string, string> = {}
        response.headers.forEach((v, k) => { headers[k] = v })
        await window.swarmmind.voiceCachePut(key, buf, headers)
      } catch { /* caching is best-effort; ignore failures */ }
    },
  }
}

// One-time purge of a poisoned transformers cache.
// Older builds (before allowLocalModels=false / the CSP fixes) could fetch the
// dev server's SPA-fallback HTML for a model file and cache that 200-status HTML
// response in the browser Cache API ('transformers-cache'). Once poisoned, every
// later load reads the cached HTML and dies with "Unexpected token '<' … is not
// valid JSON" — with no network request, so it never self-heals. Purge once so
// existing users get unstuck; good responses are re-cached normally afterwards.
async function purgeStaleModelCacheOnce(): Promise<void> {
  try {
    const FLAG = 'swarmvoice.cachePurged.v1'
    if (localStorage.getItem(FLAG)) return
    if (typeof caches !== 'undefined') await caches.delete('transformers-cache')
    localStorage.setItem(FLAG, '1')
    console.debug('[SwarmVoice] purged stale transformers-cache (one-time)')
  } catch { /* ignore */ }
}

// Download-progress fan-out, per model: a model is loaded once, but the
// background preload and a user click may both be awaiting it. Every interested
// party registers a listener; that model's progress_callback dispatches to all
// of them. Keyed by model so a background wake-model load can't drive the
// dictation download's progress bar.
const _progress = new Map<VoiceModel, Set<(pct: number) => void>>()

// The model the user currently has selected in Settings.
function selectedModel(): VoiceModel {
  return useWorkspaceStore.getState().voiceModel
}

// True when the *currently selected* model is live — the hook uses this to
// decide whether starting voice input needs a loading phase.
export function voiceModelReady(): boolean {
  return _pipelines.has(selectedModel())
}

/** Is this specific model resident? (Wake-word arming checks its own model.) */
export function isVoiceModelLoaded(model: VoiceModel): boolean {
  return _pipelines.has(model)
}

/**
 * Resolve a live pipeline for `model`, loading it if needed and joining an
 * in-flight load for the same model rather than starting a second one.
 */
async function ensureModelFor(
  model: VoiceModel,
  onProgress?: (pct: number) => void
): Promise<ASRFn> {
  const live = _pipelines.get(model)
  if (live) return live

  if (onProgress) {
    const set = _progress.get(model) ?? new Set()
    set.add(onProgress)
    _progress.set(model, set)
  }
  try {
    let load = _loads.get(model)
    if (!load) {
      load = loadModel(model)
        .then((fn) => { _pipelines.set(model, fn); return fn })
        .finally(() => { _loads.delete(model) })
      _loads.set(model, load)
    }
    return await load
  } finally {
    if (onProgress) _progress.get(model)?.delete(onProgress)
  }
}

async function ensureModel(onProgress?: (pct: number) => void): Promise<void> {
  await ensureModelFor(selectedModel(), onProgress)
}

async function loadModel(model: VoiceModel): Promise<ASRFn> {
  await purgeStaleModelCacheOnce()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const T = await import('@xenova/transformers') as any
  const pipeline = T.pipeline ?? T.default?.pipeline
  const env = T.env ?? T.default?.env
  console.debug('[SwarmVoice] @xenova/transformers loaded, pipeline:', typeof pipeline)

  // Never try loading from the local /models/ path — in dev mode Vite
  // would return index.html for that path (SPA fallback), causing a JSON
  // parse error. Always fetch from HuggingFace directly.
  if (env) env.allowLocalModels = false

  // Cache the downloaded model on the filesystem (via IPC) instead of the
  // browser Cache API, which doesn't persist on the packaged `file://`
  // origin and made the model re-download on every launch. See
  // makePersistentCache() above.
  if (env) {
    env.useBrowserCache = false
    env.useCustomCache  = true
    env.customCache     = makePersistentCache()
  }

  // Point ONNX Runtime at the locally served WASM files (public/ort/).
  // Works in dev (Vite serves /ort/*) and in production (file:// renderer).
  if (env?.backends?.onnx?.wasm) {
    const wasmBase = location.protocol === 'file:'
      ? new URL('./ort/', location.href).href
      : '/ort/'
    console.debug('[SwarmVoice] WASM base:', wasmBase)
    env.backends.onnx.wasm.wasmPaths = wasmBase
    env.backends.onnx.wasm.proxy     = false
  } else {
    console.warn('[SwarmVoice] Could not access env.backends.onnx.wasm — using default CDN WASM path')
  }

  const createPipeline = () => pipeline(
    'automatic-speech-recognition',
    VOICE_MODELS[model].repo,
    {
      quantized: true,
      progress_callback: (p: unknown) => {
        const prog = p as { status?: string; progress?: number }
        if (prog?.status === 'progress' && typeof prog.progress === 'number') {
          const pct = Math.round(prog.progress)
          for (const fn of _progress.get(model) ?? []) fn(pct)
        }
      },
    }
  )

  // Multi-threaded WASM only where the pthread workers can actually load: dev's
  // http://localhost (main.ts force-enables SharedArrayBuffer). Under the
  // packaged file:// origin the blob pthread workers can't importScripts the ORT
  // loader — they fail noisily and ORT falls back to single-thread anyway — so
  // onnxThreadCount returns 1 there and we skip the doomed spawn. Threading
  // roughly halves-to-quarters inference time; capped so terminal panes keep
  // cores. A threaded init that still fails falls back to single-threaded below.
  const threads = onnxThreadCount(location.protocol, typeof SharedArrayBuffer !== 'undefined', navigator.hardwareConcurrency)
  if (env?.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = threads
  console.debug(`[SwarmVoice] SAB=${typeof SharedArrayBuffer !== 'undefined'}, numThreads=${threads}`)

  let transcriber: ASRFn
  try {
    transcriber = await createPipeline()
  } catch (err) {
    if (threads <= 1) throw err
    console.warn('[SwarmVoice] threaded WASM init failed, retrying single-threaded:', err)
    env.backends.onnx.wasm.numThreads = 1
    transcriber = await createPipeline()
  }

  // Warm-up: run a short silent clip through the model once so WASM
  // compilation/session setup happens now (in the background, after preload)
  // instead of adding seconds to the user's first real transcription.
  // Silence transcribes to "" almost immediately after the fixed encoder pass.
  try {
    const t0 = performance.now()
    await transcriber(new Float32Array(8000)) // 0.5 s @ 16 kHz
    console.debug(`[SwarmVoice] ${model} warm-up inference: ${Math.round(performance.now() - t0)} ms`)
  } catch (err) {
    console.warn('[SwarmVoice] warm-up inference failed (non-fatal):', err)
  }
  return transcriber
}

/**
 * Load the given Whisper model (default: the user's dictation selection),
 * joining any in-flight load rather than racing a second one into existence.
 * Exported so the wake-word listener can warm `WAKE_MODEL` in the background.
 */
export async function ensureVoiceModel(model?: VoiceModel): Promise<void> {
  await ensureModelFor(model ?? selectedModel())
}

// Kick off model download + init + warm-up in the background. Called shortly
// after app start so the first real use of SwarmVoice is instant instead of
// waiting for a download and WASM warm-up. Errors are swallowed — a normal
// user-triggered load will retry and surface them. Resolves when the model is
// ready (or the attempt failed); `onProgress` lets a caller reflect download %
// in an ambient loading indicator.
export function preloadVoiceModel(onProgress?: (pct: number) => void): Promise<void> {
  return ensureModel(onProgress).catch(err => {
    console.debug('[SwarmVoice] background preload failed (will retry on first use):', err)
  })
}

// Decode recorded WebM/Opus straight to 16 kHz mono, the only format Whisper
// accepts. `decodeAudioData` resamples to the sample rate of the context it's
// called on, so decoding on a 16 kHz OfflineAudioContext does the conversion as
// part of the decode — one pass over the audio.
//
// The old path did three: decode on a device-rate AudioContext (which also
// opens a real output device just to throw it away), then render the whole clip
// through a second OfflineAudioContext purely to resample, then copy. That was
// pure overhead on every dictation, and it scaled with clip length — the reason
// a long clip had a visible pause between "stopped" and "transcribing".
//
// Returns null for a clip too short to be speech. Falls back to the original
// two-pass route if a browser rejects the 16 kHz context, so an unusual audio
// stack degrades in speed rather than breaking dictation.
async function decodeTo16kMono(arrayBuffer: ArrayBuffer): Promise<Float32Array | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE)
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    if (decoded.duration < 0.1) return null
    if (decoded.sampleRate === WHISPER_SAMPLE_RATE) return decoded.getChannelData(0).slice()
    return await resampleTo16k(decoded)
  } catch (err) {
    console.debug('[SwarmVoice] 16 kHz decode unavailable, falling back:', err)
    const native = new AudioContext()
    try {
      const decoded = await native.decodeAudioData(arrayBuffer)
      if (decoded.duration < 0.1) return null
      return await resampleTo16k(decoded)
    } finally {
      await native.close().catch(() => {})
    }
  }
}

// Render an already-decoded buffer down to 16 kHz mono. Only reached when the
// decode couldn't produce 16 kHz directly.
async function resampleTo16k(decoded: AudioBuffer): Promise<Float32Array> {
  const numSamples = Math.round(decoded.duration * WHISPER_SAMPLE_RATE)
  const offline = new OfflineAudioContext(1, numSamples, WHISPER_SAMPLE_RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

// Peak-normalise audio in place: scale a quiet recording up so its loudest
// sample sits near full scale. Whisper recognises normal-volume speech more
// reliably than faint speech, and laptop mics + conservative gain often produce
// quiet clips. Guarded so we don't amplify a near-silent buffer (which would
// just blow up the noise floor) or touch audio that's already loud enough.
function normalizePeak(audio: Float32Array, target = 0.97): void {
  let peak = 0
  for (let i = 0; i < audio.length; i++) {
    const a = Math.abs(audio[i])
    if (a > peak) peak = a
  }
  if (peak < 0.02 || peak >= target) return
  const gain = target / peak
  for (let i = 0; i < audio.length; i++) audio[i] *= gain
}

/**
 * Recorded clip → text. The whole decode/normalise/transcribe path in one call,
 * shared by dictation and the wake-word listener.
 *
 * Everything subtle about talking to Whisper lives here, which is exactly why it
 * is shared rather than reimplemented: the single-pass 16 kHz decode, the peak
 * normalisation quiet laptop mics need, awaiting a model that may be mid-reload,
 * and above all the `{ language, task }` trap below. Returns '' for a clip too
 * short to be speech.
 */
export async function transcribeAudio(
  blob: Blob,
  opts: { model?: VoiceModel; maxTokens?: number } = {}
): Promise<string> {
  const audio = await decodeTo16kMono(await blob.arrayBuffer())
  if (!audio) return ''

  // Boost quiet recordings toward full scale before transcription.
  normalizePeak(audio)

  // The model may still be loading (the user switched models mid-recording, or
  // the background preload is still warming). Instant once it's live.
  const transcriber = await ensureModelFor(opts.model ?? selectedModel())

  // NOTE: Do NOT pass { language, task } here. The `.en` models are
  // English-only; forcing decoder prompt ids makes the WASM (onnxruntime-web)
  // backend emit empty output — even though the same call works on the native
  // onnxruntime-node backend. Verified in the real renderer: with the options →
  // "", without → correct transcript. The options are redundant anyway.
  //
  // `max_new_tokens` is safe to pass (unlike language/task, it's a generation
  // limit rather than a forced decoder prompt) and bounds the *decoder*, which
  // is the only part of the cost that scales with utterance length — Whisper's
  // encoder always runs over a padded 30-second window no matter how short the
  // clip is. Wake detection uses it to stop the model narrating a long
  // background conversation it was never going to match anyway.
  const genOpts = opts.maxTokens ? { max_new_tokens: opts.maxTokens } : undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (transcriber as any)(audio, genOpts) as any
  return ((Array.isArray(result) ? result[0]?.text : result?.text) ?? '').trim()
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseVoiceReturn {
  status: VoiceStatus
  modelProgress: number
  lastTranscript: string
  /**
   * Begin dictation. `existingStream` lets a caller that already holds a live
   * microphone (the wake-word listener) hand it straight over, which removes a
   * `getUserMedia` round trip from the moment the user is actually waiting.
   */
  start: (existingStream?: MediaStream) => Promise<void>
  stop: () => void
  error: string | null
}

export function useVoice(onTranscript: (text: string) => void): UseVoiceReturn {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [modelProgress, setModelProgress] = useState(0)
  const [lastTranscript, setLastTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef         = useRef<Blob[]>([])
  const streamRef         = useRef<MediaStream | null>(null)
  const audioCtxRef       = useRef<AudioContext | null>(null)
  const analyserRef       = useRef<AnalyserNode | null>(null)
  const rafRef            = useRef<number | null>(null)
  const vadRef            = useRef<VadState | null>(null)
  const callbackRef       = useRef(onTranscript)
  useEffect(() => { callbackRef.current = onTranscript }, [onTranscript])

  const stopVisualization = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    try { analyserRef.current?.disconnect() } catch { /* ignore */ }
    try { audioCtxRef.current?.close() } catch { /* ignore */ }
    audioCtxRef.current = null
    analyserRef.current = null
    _levels.fill(0)
  }, [])

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    stopVisualization()
  }, [stopVisualization])

  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }, [])

  const start = useCallback(async (existingStream?: MediaStream) => {
    // A handed-over microphone has already been disowned by whoever gave it to
    // us, so every path that declines to take it must close it — otherwise
    // bailing out here leaves a live mic belonging to nobody.
    const dropHandOff = () => existingStream?.getTracks().forEach(t => t.stop())

    // Allow start from idle OR from a previous error (retry)
    if (status !== 'idle' && status !== 'error') { dropHandOff(); return }
    setError(null)

    // Load Whisper on first click, after an error (retry), or after the user
    // picked a different model in Settings (voiceModelReady goes false).
    if (!voiceModelReady()) {
      setStatus('model-loading')
      setModelProgress(0)
      try {
        await ensureModel(pct => setModelProgress(pct))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[SwarmVoice] model load failed:', err)
        setError(msg)
        setStatus('error')
        dropHandOff()
        return
      }
    }

    setStatus('recording')

    // Microphone + waveform visualiser
    let stream: MediaStream
    try {
      // A handed-over stream is already open and configured — reusing it skips
      // the device negotiation entirely. Only fall back to acquiring one when
      // nobody handed us a live mic (or the one we were given has since ended).
      const handedOver =
        existingStream && existingStream.getAudioTracks().some((t) => t.readyState === 'live')
          ? existingStream
          : null
      // Enable the browser's mic DSP — echo cancellation, noise suppression and
      // automatic gain — which noticeably cleans up the audio Whisper sees
      // (fewer dropped/garbled words on noisy or quiet mics). Mono is all
      // Whisper uses, so don't bother capturing stereo.
      stream = handedOver ?? await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
      streamRef.current = stream

      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.65
      analyserRef.current = analyser
      ctx.createMediaStreamSource(stream).connect(analyser)

      const buf      = new Uint8Array(analyser.frequencyBinCount)
      const binCount = analyser.frequencyBinCount
      // Auto-stop bookkeeping. Read the setting once per recording so toggling
      // it mid-sentence can't end the clip the user is in the middle of.
      const autoStop = useWorkspaceStore.getState().voiceAutoStop
      vadRef.current = initVad(performance.now())

      const tick = () => {
        analyser.getByteFrequencyData(buf)
        // Mutate the shared buffer in place — no React state, no re-render.
        for (let i = 0; i < BAR_COUNT; i++) {
          const lo = Math.floor((i / BAR_COUNT) * binCount * 0.6)
          const hi = Math.floor(((i + 1) / BAR_COUNT) * binCount * 0.6)
          let sum = 0
          for (let j = lo; j < hi; j++) sum += buf[j]
          _levels[i] = Math.min(1, (sum / Math.max(1, hi - lo)) / 140)
        }

        if (autoStop && vadRef.current) {
          const { state, verdict } = stepVad(vadRef.current, frameLoudness(buf), performance.now())
          vadRef.current = state
          if (verdict === 'stop-silence' || verdict === 'stop-max') {
            // End the clip from inside the frame loop: cancel first so the
            // recorder's async onstop can't race another tick.
            rafRef.current = null
            if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
            return
          }
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Microphone access denied'
      console.error('[SwarmVoice] getUserMedia failed:', err)
      setError(msg)
      setStatus('error')
      // Covers the handed-over stream too: by this point it's in streamRef, and
      // failing *after* the mic was open (e.g. the AudioContext threw) would
      // otherwise strand it live.
      cleanup()
      dropHandOff()
      return
    }

    // MediaRecorder capture
    chunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType })
    mediaRecorderRef.current = recorder

    recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }

    recorder.onstop = async () => {
      cleanup()
      setStatus('transcribing')
      try {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const text = await transcribeAudio(blob)
        if (text) {
          setLastTranscript(text)
          callbackRef.current(text)
        }
        setStatus('idle')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Transcription failed'
        console.error('[SwarmVoice] transcription failed:', err)
        setError(msg)
        setStatus('error')
      }
    }

    recorder.start()
  }, [status, cleanup])

  // Stop and clean up on unmount
  useEffect(() => () => {
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
    cleanup()
  }, [cleanup])

  return { status, modelProgress, lastTranscript, start, stop, error }
}
