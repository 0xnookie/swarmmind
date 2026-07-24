/**
 * How many ONNX Runtime WASM threads to request for on-device models (Whisper
 * voice in `useVoice.ts`, MiniLM embeddings in `embed.ts`).
 *
 * Threaded WASM spawns pthread workers from blob URLs. Under the packaged
 * `file://` renderer origin those blob workers can't `importScripts` the ORT
 * loader — they fail with a `NetworkError`, spew console noise, and ORT silently
 * falls back to single-thread anyway. So the multi-threading never actually
 * worked in a packaged build; it just wasted a doomed worker spawn per model
 * load. Requesting a single thread under `file://` skips the spawn entirely.
 *
 * In dev (`http://localhost`, where `main.ts` force-enables SharedArrayBuffer
 * and same-origin blob workers load fine) a small pool is used — capped so the
 * terminal panes keep some cores.
 *
 * Pure so it can be unit-tested (`tests/lib-units.mts`) without a renderer.
 */
export function onnxThreadCount(protocol: string, hasSharedArrayBuffer: boolean, cores: number): number {
  // Doomed under file:// — never spawn the pthread workers there.
  if (protocol === 'file:') return 1
  // Threaded WASM needs SharedArrayBuffer; without it ORT is single-thread.
  if (!hasSharedArrayBuffer) return 1
  return Math.max(1, Math.min(4, (cores || 2) - 1))
}
