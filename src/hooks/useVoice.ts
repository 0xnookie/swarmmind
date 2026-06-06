import { useCallback, useEffect, useRef, useState } from 'react'

export type VoiceStatus = 'idle' | 'model-loading' | 'recording' | 'transcribing' | 'error'

const BAR_COUNT = 5

// ── Model singleton ────────────────────────────────────────────────────────────
// Lives at module scope so the loaded model survives component remounts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ASRFn = (audio: Float32Array, opts: object) => Promise<any>
let _transcriber: ASRFn | null = null
let _loadPromise: Promise<void> | null = null

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

async function ensureModel(onProgress: (pct: number) => void): Promise<void> {
  if (_transcriber) return
  if (!_loadPromise) {
    _loadPromise = (async () => {
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

      // Point ONNX Runtime at the locally served WASM files (public/ort/).
      // Works in dev (Vite serves /ort/*) and in production (file:// renderer).
      if (env?.backends?.onnx?.wasm) {
        const wasmBase = location.protocol === 'file:'
          ? new URL('./ort/', location.href).href
          : '/ort/'
        console.debug('[SwarmVoice] WASM base:', wasmBase)
        env.backends.onnx.wasm.wasmPaths  = wasmBase
        env.backends.onnx.wasm.numThreads = 1     // no SharedArrayBuffer needed
        env.backends.onnx.wasm.proxy      = false
      } else {
        console.warn('[SwarmVoice] Could not access env.backends.onnx.wasm — using default CDN WASM path')
      }

      _transcriber = await pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny.en',
        {
          quantized: true,
          progress_callback: (p: unknown) => {
            const prog = p as { status?: string; progress?: number }
            if (prog?.status === 'progress' && typeof prog.progress === 'number') {
              onProgress(Math.round(prog.progress))
            }
          },
        }
      )
    })().catch((err: unknown) => {
      _loadPromise = null  // allow retry
      throw err
    })
  }
  return _loadPromise
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

    // Load Whisper on first click (or retry after error)
    if (!_transcriber) {
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
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
