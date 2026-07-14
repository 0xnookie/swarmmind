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

export type LspReference = {
  /** Absolute path of the file holding the reference. */
  path: string
  /** 1-based, ready for `openFileAtLine`. */
  line: number
  col: number
  /** Trimmed text of the containing line, for the references list preview. */
  lineText: string
  isDefinition: boolean
  isWrite: boolean
}

/**
 * Result of a compiler-exact rename. The worker applies the span edits itself —
 * against the very snapshots it computed them on (overlay for open files, disk
 * for the rest) — and returns full new file contents. Shipping offsets to the
 * renderer instead would invite the classic desync: the renderer would apply
 * them to text the service never saw.
 */
export type LspRenameResult =
  | { ok: true; displayName: string; files: { path: string; newContent: string; edits: number }[] }
  | { ok: false; error: string }

// Every query carries the editor's live buffer, so a request is self-contained:
// the worker can be restarted at any moment without a resync handshake, and
// there is no window in which it answers against a stale document.
export type LspRequest =
  | { id: number; type: 'close'; path: string }
  | { id: number; type: 'diagnostics'; path: string; content: string }
  | { id: number; type: 'hover'; path: string; content: string; offset: number }
  | { id: number; type: 'definition'; path: string; content: string; offset: number }
  | { id: number; type: 'references'; path: string; content: string; offset: number }
  | { id: number; type: 'rename'; path: string; content: string; offset: number; newName: string }

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
