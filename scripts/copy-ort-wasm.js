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

const files = [
  'ort-wasm.wasm',
  'ort-wasm-simd.wasm',
  'ort-wasm-threaded.wasm',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-threaded.worker.js',
  'ort-wasm-threaded.js',  // JS glue for the threaded WASM backend
]

for (const f of files) {
  const s = join(src, f)
  const d = join(dest, f)
  if (existsSync(s)) {
    cpSync(s, d)
    console.log(`[copy-ort-wasm] copied ${f}`)
  }
}
