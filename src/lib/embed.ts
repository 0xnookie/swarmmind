// Local text embeddings via @xenova/transformers (feature-extraction), used to
// add a *semantic* layer on top of the lexical BM25 retrieval in retrieval.ts —
// so context selection isn't limited to literal term matches. Key-free and
// on-device, mirroring SwarmVoice's Whisper setup (allowLocalModels=false, the
// same filesystem-backed model cache via IPC, locally served ONNX WASM).
//
// This is the IMPURE runtime (model load + inference); the pure vector math it
// feeds (cosineSim / rankByEmbedding / fuseRankings) lives in retrieval.ts and is
// unit-tested. All-MiniLM-L6-v2 → 384-dim, ~23 MB quantized, cached after first
// load. Everything here is best-effort: callers fall back to lexical ranking if
// embeddings are unavailable (offline, load failure, etc.).

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _extractor: any = null
let _loading: Promise<void> | null = null

// Same filesystem-backed transformers cache SwarmVoice uses, reached through the
// existing voiceCache* IPC (keyed by URL, so sharing it across models is safe).
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
      } catch { /* caching is best-effort */ }
    },
  }
}

async function load(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const T = await import('@xenova/transformers') as any
  const pipeline = T.pipeline ?? T.default?.pipeline
  const env = T.env ?? T.default?.env
  if (env) {
    env.allowLocalModels = false
    env.useBrowserCache = false
    env.useCustomCache = true
    env.customCache = makePersistentCache()
    if (env.backends?.onnx?.wasm) {
      const wasmBase = location.protocol === 'file:'
        ? new URL('./ort/', location.href).href
        : '/ort/'
      env.backends.onnx.wasm.wasmPaths = wasmBase
      env.backends.onnx.wasm.proxy = false
    }
  }
  _extractor = await pipeline('feature-extraction', EMBED_MODEL, { quantized: true })
}

/** True once the embedding model is loaded and ready (cheap synchronous check). */
export function embeddingsReady(): boolean {
  return _extractor !== null
}

/**
 * Kick off model download/init in the background (idempotent). Resolves when the
 * model is ready or the attempt fails — errors are swallowed so callers can keep
 * using lexical ranking. Lets the UI warm the model on first use so a later call
 * to embedTexts is instant.
 */
export function preloadEmbedder(): Promise<void> {
  if (_extractor) return Promise.resolve()
  if (!_loading) _loading = load().catch((err) => { _loading = null; throw err })
  return _loading.catch(() => {})
}

/**
 * Embed each text into a normalized vector (mean-pooled). Loads the model on
 * first use. Throws if the model can't be loaded — callers should try/catch and
 * fall back to lexical ranking.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  if (!_extractor) {
    if (!_loading) _loading = load().catch((err) => { _loading = null; throw err })
    await _loading
  }
  const out: number[][] = []
  for (const text of texts) {
    const t = text.slice(0, 2000) // bound per-text work
    const tensor = await _extractor(t, { pooling: 'mean', normalize: true })
    out.push(Array.from(tensor.data as Float32Array | number[]))
  }
  return out
}
