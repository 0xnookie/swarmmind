// Wire types shared by the LSP worker, the main-process client, and (via
// src/types/swarmmind.d.ts) the renderer. Types only — no runtime import, so the
// worker bundle stays lean.

export type LspDiagnostic = {
  /** Character offsets into the file the editor synced. The renderer converts to
   *  lines itself (CodeMirror already knows the doc), which keeps the two sides
   *  from disagreeing about line endings. */
  from: number
  to: number
  message: string
  severity: 'error' | 'warning' | 'info'
  /** TS error code, e.g. 2322. */
  code?: number
}

export type LspHover = {
  /** Markdown: fenced signature, then the doc comment. */
  markdown: string
  from: number
  to: number
}

export type LspDefinition = {
  /** Absolute path of the file holding the definition (may be another file). */
  path: string
  /** 1-based, ready for `openFileAtLine`. */
  line: number
  col: number
}

// Every query carries the editor's live buffer, so a request is self-contained:
// the worker can be restarted at any moment without a resync handshake, and
// there is no window in which it answers against a stale document.
export type LspRequest =
  | { id: number; type: 'close'; path: string }
  | { id: number; type: 'diagnostics'; path: string; content: string }
  | { id: number; type: 'hover'; path: string; content: string; offset: number }
  | { id: number; type: 'definition'; path: string; content: string; offset: number }

export type LspResponse = {
  id: number
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * A request minus the id the client stamps on. Distributive on purpose: a plain
 * `Omit<LspRequest, 'id'>` over a union collapses it to the keys the members
 * share (only `type`), silently making `path`/`offset` unassignable.
 */
export type LspRequestBody = LspRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, 'id'>
    : never
  : never
