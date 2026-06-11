// Copies ONNX Runtime WASM files from onnxruntime-web into public/ort/
// so Vite can serve them at a stable URL without CDN dependencies.
// Runs automatically after `npm install` via the postinstall hook.

const { cpSync, mkdirSync, existsSync } = require('fs')
const { join } = require('path')

const src  = join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist')
const dest = join(__dirname, '..', 'public', 'ort')

if (!existsSync(src)) {
  console.warn('[copy-ort-wasm] onnxruntime-web not found, skipping')
  process.exit(0)
}

mkdirSync(dest, { recursive: true })

// useVoice.ts uses the multi-threaded backend when SharedArrayBuffer is
// available (main.ts force-enables it via the SharedArrayBuffer feature flag),
// so ship the threaded WASM variants and their pthread worker alongside the
// single-threaded ones (the runtime falls back to those if SAB/threads are
// unavailable). onnxruntime-web picks the -simd variant when WASM-SIMD is
// available (all modern CPUs).
const files = [
  'ort-wasm.wasm',
  'ort-wasm-simd.wasm',
  'ort-wasm-threaded.wasm',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-threaded.worker.js',
]

for (const f of files) {
  const s = join(src, f)
  const d = join(dest, f)
  if (existsSync(s)) {
    cpSync(s, d)
    console.log(`[copy-ort-wasm] copied ${f}`)
  }
}
