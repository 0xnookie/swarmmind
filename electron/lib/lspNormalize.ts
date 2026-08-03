// Turning LSP's response shapes into the flat types SwarmMind's editor already
// speaks (electron/lsp/protocol.ts).
//
// The spec is generous about shapes for backwards compatibility, and real
// servers use different ones: `hover.contents` is a string, a `{language,value}`
// pair, an array of either, or a `MarkupContent`; `definition` is a Location, an
// array of Locations, or an array of LocationLinks; a rename comes back as
// `changes` on some servers and `documentChanges` on others. None of that is
// negotiable at runtime, so it's all normalised here — pure, and asserted
// against the actual shapes rather than discovered when a user installs gopls.
//
// Position conversion lives here too: LSP speaks line/character, the editor
// speaks character offsets, and the round trip has to survive CRLF files.

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

// ── Offsets ↔ positions ──────────────────────────────────────────────────────

/**
 * Character offset → {line, character}.
 *
 * `character` is a UTF-16 code-unit index within the line, which is exactly a
 * JS string index — so no conversion is needed, but only because both sides
 * happen to be UTF-16. (A UTF-8 offset would need real work here.)
 */
export function offsetToPosition(text: string, offset: number): LspPosition {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const before = text.slice(0, clamped)
  const lastNl = before.lastIndexOf('\n')
  let line = 0
  for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) line++
  return { line, character: clamped - (lastNl + 1) }
}

/**
 * {line, character} → character offset.
 *
 * Out-of-range input is clamped rather than rejected: servers occasionally
 * report a position one past the end of a file they read from disk while the
 * editor holds a shorter unsaved buffer, and throwing there would take down a
 * whole diagnostics batch over one stale range.
 */
export function positionToOffset(text: string, pos: LspPosition): number {
  if (pos.line <= 0 && pos.character <= 0) return 0
  let offset = 0
  let line = 0
  while (line < pos.line) {
    const nl = text.indexOf('\n', offset)
    if (nl === -1) return text.length // fewer lines than asked for
    offset = nl + 1
    line++
  }
  const lineEnd = text.indexOf('\n', offset)
  const hardEnd = lineEnd === -1 ? text.length : lineEnd
  return Math.min(offset + Math.max(0, pos.character), hardEnd)
}

export function rangeToOffsets(text: string, range: LspRange): { from: number; to: number } {
  const from = positionToOffset(text, range.start)
  const to = positionToOffset(text, range.end)
  // A zero-width range would render as an invisible diagnostic; widen it by one
  // so there is something to underline and hover.
  return { from, to: Math.max(to, Math.min(from + 1, text.length)) }
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

export type NormalizedSeverity = 'error' | 'warning' | 'info'

/** LSP severity is 1..4; anything missing means "the server didn't say", and
 *  the spec's guidance there is to treat it as an error. */
export function normalizeSeverity(severity: unknown): NormalizedSeverity {
  switch (severity) {
    case 2: return 'warning'
    case 3:
    case 4: return 'info'
    default: return 'error'
  }
}

export interface NormalizedDiagnostic {
  from: number
  to: number
  message: string
  severity: NormalizedSeverity
  code?: number
}

export function normalizeDiagnostics(raw: unknown, text: string): NormalizedDiagnostic[] {
  if (!Array.isArray(raw)) return []
  const out: NormalizedDiagnostic[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const d = item as Record<string, unknown>
    const range = d.range as LspRange | undefined
    if (!range?.start || !range?.end) continue
    const { from, to } = rangeToOffsets(text, range)
    const code = typeof d.code === 'number' ? d.code : undefined
    out.push({
      from,
      to,
      message: typeof d.message === 'string' ? d.message : '',
      severity: normalizeSeverity(d.severity),
      ...(code === undefined ? {} : { code }),
    })
  }
  return out
}

// ── Hover ────────────────────────────────────────────────────────────────────

function markedStringToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.value === 'string') {
      // `{language, value}` is a code block; keep the fence so the editor's
      // hover renderer shows it as a signature rather than prose.
      return typeof v.language === 'string' && v.language
        ? '```' + v.language + '\n' + v.value + '\n```'
        : v.value
    }
  }
  return ''
}

/** Every hover shape in the spec, flattened to markdown. */
export function normalizeHoverContents(contents: unknown): string {
  if (Array.isArray(contents)) {
    return contents.map(markedStringToText).filter(Boolean).join('\n\n').trim()
  }
  return markedStringToText(contents).trim()
}

// ── Locations ────────────────────────────────────────────────────────────────

export interface NormalizedLocation {
  uri: string
  range: LspRange
}

/**
 * Location | Location[] | LocationLink[] → a flat list.
 *
 * LocationLink names the fields differently (`targetUri`/`targetSelectionRange`)
 * and servers pick between the two based on a client capability we don't claim —
 * but several send links anyway, so both are handled.
 */
export function normalizeLocations(raw: unknown): NormalizedLocation[] {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: NormalizedLocation[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const uri = typeof o.uri === 'string' ? o.uri : typeof o.targetUri === 'string' ? o.targetUri : null
    const range = (o.range ?? o.targetSelectionRange ?? o.targetRange) as LspRange | undefined
    if (!uri || !range?.start || !range?.end) continue
    out.push({ uri, range })
  }
  return out
}

// ── Workspace edits (rename) ─────────────────────────────────────────────────

export interface UriEdits {
  uri: string
  edits: { range: LspRange; newText: string }[]
}

/**
 * WorkspaceEdit → per-URI edits, from either representation.
 *
 * `documentChanges` entries that aren't plain text edits (create/rename/delete
 * file operations) are dropped: this powers a symbol rename that lands in the
 * Composer's diff preview, and a file-system operation smuggled into that list
 * would be applied by a pipeline whose whole promise is "you see it first".
 */
export function normalizeWorkspaceEdit(raw: unknown): UriEdits[] {
  if (!raw || typeof raw !== 'object') return []
  const we = raw as Record<string, unknown>
  const out: UriEdits[] = []

  const pushEdits = (uri: string, edits: unknown) => {
    if (!Array.isArray(edits)) return
    const clean = edits
      .filter((e): e is { range: LspRange; newText: string } =>
        !!e && typeof e === 'object'
        && !!(e as { range?: LspRange }).range?.start
        && typeof (e as { newText?: unknown }).newText === 'string')
      .map(e => ({ range: e.range, newText: e.newText }))
    if (clean.length) out.push({ uri, edits: clean })
  }

  if (we.changes && typeof we.changes === 'object') {
    for (const [uri, edits] of Object.entries(we.changes as Record<string, unknown>)) pushEdits(uri, edits)
  }
  if (Array.isArray(we.documentChanges)) {
    for (const change of we.documentChanges) {
      if (!change || typeof change !== 'object') continue
      const c = change as Record<string, unknown>
      const doc = c.textDocument as Record<string, unknown> | undefined
      // A create/rename/delete operation has `kind` and no textDocument.
      if (!doc || typeof doc.uri !== 'string') continue
      pushEdits(doc.uri, c.edits)
    }
  }
  return out
}

/**
 * Apply per-URI ranges to a file's text, right-to-left.
 *
 * Right-to-left is the point: applying left-to-right shifts every later range
 * by the length delta of the ones already applied, which silently corrupts the
 * file rather than failing. Returns null on overlapping edits — the same refusal
 * `applyTextEdits` makes for the TypeScript path, for the same reason.
 */
export function applyRangeEdits(text: string, edits: readonly { range: LspRange; newText: string }[]): string | null {
  const resolved = edits
    .map(e => ({ ...rangeToOffsetsExact(text, e.range), newText: e.newText }))
    .sort((a, b) => b.from - a.from || b.to - a.to)

  let out = text
  let prevFrom = Infinity
  for (const e of resolved) {
    if (e.to > prevFrom) return null // overlaps the edit applied after it
    if (e.from > e.to) return null
    out = out.slice(0, e.from) + e.newText + out.slice(e.to)
    prevFrom = e.from
  }
  return out
}

/** Like rangeToOffsets but without the zero-width widening, which would make an
 *  insertion edit swallow the character after it. */
function rangeToOffsetsExact(text: string, range: LspRange): { from: number; to: number } {
  return { from: positionToOffset(text, range.start), to: positionToOffset(text, range.end) }
}
