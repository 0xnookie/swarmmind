// ── Renderer `process` shim ─────────────────────────────────────────────────
//
// @xenova/transformers bundles a HuggingFace Hub client that reads `process.env`
// (e.g. HF_TOKEN, HF_ACCESS_TOKEN, TESTING_REMOTELY) and `process.version` while
// downloading a model. The access pattern is:
//
//     ((_b = process.env) == null ? void 0 : _b.HF_TOKEN)
//
// The optional chaining only guards against `process.env` being null — NOT against
// `process` itself being undefined. In the Electron renderer (nodeIntegration:false,
// contextIsolation:true) `process` is undefined, so evaluating `process.env` throws
// "ReferenceError: process is not defined" the moment SwarmVoice tries to load the
// Whisper model. That is why voice input silently failed.
//
// A build-time `define` for `process.env.NODE_ENV` only rewrites that one exact
// expression; it cannot cover every `process.*` the library touches. A minimal,
// browser-safe global shim covers them all, in both dev and production.
//
// IMPORTANT: this module must be imported before @xenova/transformers is ever
// loaded — main.tsx imports it first, and transformers is only pulled in lazily
// on first voice use, so the ordering is guaranteed.

const g = globalThis as unknown as { process?: Record<string, unknown> }

if (!g.process) {
  g.process = {
    env: { NODE_ENV: 'production' },
    platform: 'browser',
    version: '',
    // versions.node stays undefined so libraries' `typeof process.versions.node
    // === 'string'` Node-detection checks correctly resolve to false (browser).
    versions: {},
    nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]) =>
      setTimeout(() => cb(...args), 0),
    cwd: () => '/',
  }
}

export {}
