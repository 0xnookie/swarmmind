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

// useVoice.ts forces the single-threaded backend (env.backends.onnx.wasm
// .numThreads = 1, proxy = false), so the threaded WASM variants + their JS
// glue/worker are never loaded — shipping them only bloated the build by ~18 MB.
// onnxruntime-web picks ort-wasm-simd.wasm when WASM-SIMD is available (all
// modern CPUs) and falls back to ort-wasm.wasm otherwise; we ship both.
const files = [
  'ort-wasm.wasm',
  'ort-wasm-simd.wasm',
]

for (const f of files) {
  const s = join(src, f)
  const d = join(dest, f)
  if (existsSync(s)) {
    cpSync(s, d)
    console.log(`[copy-ort-wasm] copied ${f}`)
  }
}
