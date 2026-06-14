import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'

export type VoiceStatus = 'idle' | 'model-loading' | 'recording' | 'transcribing' | 'error'

const BAR_COUNT = 5

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

// ── Model singleton ────────────────────────────────────────────────────────────
// Lives at module scope so the loaded model survives component remounts.
// `_loadedModel` tracks which VoiceModel the live transcriber was built from, so
// changing the setting simply makes the next ensureModel() reload.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ASRFn = (audio: Float32Array, opts?: object) => Promise<any>
let _transcriber: ASRFn | null = null
let _loadedModel: VoiceModel | null = null
let _loadingModel: VoiceModel | null = null
let _loadPromise: Promise<void> | null = null

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

// Download-progress fan-out: the model is loaded once (module singleton), but
// both the background preload and a user click may be awaiting it. Every
// interested party registers a listener; the single pipeline progress_callback
// dispatches to all of them.
const _progressListeners = new Set<(pct: number) => void>()

// The model the user currently has selected in Settings.
function selectedModel(): VoiceModel {
  return useWorkspaceStore.getState().voiceModel
}

// True when the live transcriber matches the *currently selected* model — the
// hook uses this to decide whether starting voice input needs a loading phase.
export function voiceModelReady(): boolean {
  return _transcriber !== null && _loadedModel === selectedModel()
}

async function ensureModel(onProgress?: (pct: number) => void): Promise<void> {
  if (onProgress) _progressListeners.add(onProgress)
  try {
    // Loop: an in-flight load may be for a different (stale) model selection;
    // await it, then re-check against the selection and reload if needed.
    for (;;) {
      const want = selectedModel()
      if (_transcriber && _loadedModel === want) return
      if (_loadPromise) {
        if (_loadingModel === want) return await _loadPromise
        await _loadPromise.catch(() => { /* stale load's error is not ours */ })
        continue
      }
      _transcriber = null
      _loadedModel = null
      _loadingModel = want
      _loadPromise = loadModel(want)
        .then(() => { _loadedModel = want })
        .finally(() => { _loadPromise = null; _loadingModel = null })
      return await _loadPromise
    }
  } finally {
    if (onProgress) _progressListeners.delete(onProgress)
  }
}

async function loadModel(model: VoiceModel): Promise<void> {
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
          for (const fn of _progressListeners) fn(pct)
        }
      },
    }
  )

  // Multi-threaded WASM when SharedArrayBuffer is available (main.ts
  // force-enables it via the Chromium feature flag — neither dev's
  // http://localhost nor the packaged file:// origin is cross-origin isolated,
  // so it would otherwise be missing). Threading roughly halves-to-quarters
  // inference time. Capped at 4: diminishing returns beyond that, and leave
  // cores for the terminal panes. If threaded init fails for any reason
  // (worker creation blocked, missing .worker.js, …), fall back to the
  // single-threaded backend rather than breaking voice entirely.
  const threads = typeof SharedArrayBuffer !== 'undefined'
    ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
    : 1
  if (env?.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = threads
  console.debug(`[SwarmVoice] SAB=${typeof SharedArrayBuffer !== 'undefined'}, numThreads=${threads}`)

  try {
    _transcriber = await createPipeline()
  } catch (err) {
    if (threads <= 1) throw err
    console.warn('[SwarmVoice] threaded WASM init failed, retrying single-threaded:', err)
    env.backends.onnx.wasm.numThreads = 1
    _transcriber = await createPipeline()
  }

  // Warm-up: run a short silent clip through the model once so WASM
  // compilation/session setup happens now (in the background, after preload)
  // instead of adding seconds to the user's first real transcription.
  // Silence transcribes to "" almost immediately after the fixed encoder pass.
  try {
    const t0 = performance.now()
    await _transcriber!(new Float32Array(8000)) // 0.5 s @ 16 kHz
    console.debug(`[SwarmVoice] warm-up inference: ${Math.round(performance.now() - t0)} ms`)
  } catch (err) {
    console.warn('[SwarmVoice] warm-up inference failed (non-fatal):', err)
  }
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

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseVoiceReturn {
  status: VoiceStatus
  modelProgress: number
  audioLevels: number[]
  lastTranscript: string
  start: () => Promise<void>
  stop: () => void
  error: string | null
}

export function useVoice(onTranscript: (text: string) => void): UseVoiceReturn {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [modelProgress, setModelProgress] = useState(0)
  const [audioLevels, setAudioLevels] = useState<number[]>(Array(BAR_COUNT).fill(0))
  const [lastTranscript, setLastTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef         = useRef<Blob[]>([])
  const streamRef         = useRef<MediaStream | null>(null)
  const audioCtxRef       = useRef<AudioContext | null>(null)
  const analyserRef       = useRef<AnalyserNode | null>(null)
  const rafRef            = useRef<number | null>(null)
  const callbackRef       = useRef(onTranscript)
  useEffect(() => { callbackRef.current = onTranscript }, [onTranscript])

  const stopVisualization = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    try { analyserRef.current?.disconnect() } catch { /* ignore */ }
    try { audioCtxRef.current?.close() } catch { /* ignore */ }
    audioCtxRef.current = null
    analyserRef.current = null
    setAudioLevels(Array(BAR_COUNT).fill(0))
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

  const start = useCallback(async () => {
    // Allow start from idle OR from a previous error (retry)
    if (status !== 'idle' && status !== 'error') return
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
        return
      }
    }

    setStatus('recording')

    // Microphone + waveform visualiser
    let stream: MediaStream
    try {
      // Enable the browser's mic DSP — echo cancellation, noise suppression and
      // automatic gain — which noticeably cleans up the audio Whisper sees
      // (fewer dropped/garbled words on noisy or quiet mics). Mono is all
      // Whisper uses, so don't bother capturing stereo.
      stream = await navigator.mediaDevices.getUserMedia({
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
      const tick = () => {
        analyser.getByteFrequencyData(buf)
        setAudioLevels(Array.from({ length: BAR_COUNT }, (_, i) => {
          const lo = Math.floor((i / BAR_COUNT) * binCount * 0.6)
          const hi = Math.floor(((i + 1) / BAR_COUNT) * binCount * 0.6)
          let sum = 0
          for (let j = lo; j < hi; j++) sum += buf[j]
          return Math.min(1, (sum / Math.max(1, hi - lo)) / 140)
        }))
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Microphone access denied'
      console.error('[SwarmVoice] getUserMedia failed:', err)
      setError(msg)
      setStatus('error')
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
        // Decode WebM/Opus → 16 kHz mono Float32 (Whisper's expected format)
        const blob        = new Blob(chunksRef.current, { type: 'audio/webm' })
        const arrayBuffer = await blob.arrayBuffer()

        const nativeCtx = new AudioContext()
        const decoded   = await nativeCtx.decodeAudioData(arrayBuffer)
        await nativeCtx.close()

        if (decoded.duration < 0.1) { setStatus('idle'); return }

        const numSamples  = Math.round(decoded.duration * 16000)
        const offlineCtx  = new OfflineAudioContext(1, numSamples, 16000)
        const src         = offlineCtx.createBufferSource()
        src.buffer        = decoded
        src.connect(offlineCtx.destination)
        src.start(0)
        const resampled   = await offlineCtx.startRendering()
        const audio       = resampled.getChannelData(0).slice()

        // Boost quiet recordings toward full scale before transcription.
        normalizePeak(audio)

        // The transcriber may be mid-reload (user switched models while
        // recording, or background preload still warming). Instant when the
        // selected model is already live.
        await ensureModel()

        // NOTE: Do NOT pass { language, task } here. whisper-tiny.en is an
        // English-only model; forcing decoder prompt ids makes the WASM
        // (onnxruntime-web) backend emit empty output — even though the same
        // call works on the native onnxruntime-node backend. Verified in the
        // real renderer: with the options → "", without → correct transcript.
        // The .en model always transcribes English, so the options are redundant.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (_transcriber as any)(audio) as any
        const text   = ((Array.isArray(result) ? result[0]?.text : result?.text) ?? '').trim()
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

  return { status, modelProgress, audioLevels, lastTranscript, start, stop, error }
}
