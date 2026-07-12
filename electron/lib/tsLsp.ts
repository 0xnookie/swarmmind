// Pure mapping helpers for the TypeScript language service (electron/lsp/*).
//
// Dependency-free ON PURPOSE: the worker that uses these imports `typescript`,
// but nothing here does, so the whole decision layer strips-and-runs under
// `node --experimental-strip-types` in tests/lib-units.mts with no build step.
// TS values cross this boundary as plain data (numbers/strings), never as
// `ts.*` types.

/** `ts.DiagnosticCategory`, inlined so this module stays import-free. */
export const TS_CATEGORY = { Warning: 0, Error: 1, Suggestion: 2, Message: 3 } as const

export type DiagSeverity = 'error' | 'warning' | 'info'

/** Map a `ts.DiagnosticCategory` to a CodeMirror lint severity. */
export function severityOf(category: number): DiagSeverity {
  if (category === TS_CATEGORY.Error) return 'error'
  if (category === TS_CATEGORY.Warning) return 'warning'
  return 'info'
}

/**
 * TS reports nested errors as a linked `DiagnosticMessageChain`. Flatten it into
 * one indented string (same shape `tsc` prints), so the whole explanation — not
 * just the headline — reaches the lint tooltip and the AI's "fix this" prompt.
 */
export type MessageChain = { messageText: string; next?: MessageChain[] }

export function flattenMessage(text: string | MessageChain, depth = 0): string {
  if (typeof text === 'string') return text
  const indent = '  '.repeat(depth)
  let out = indent + text.messageText
  for (const child of text.next ?? []) out += '\n' + flattenMessage(child, depth + 1)
  return out
}

/** `ts.SymbolDisplayPart[]` → plain text (used for hover signature + docs). */
export function displayPartsToText(parts: ReadonlyArray<{ text: string }> | undefined): string {
  if (!parts || parts.length === 0) return ''
  let out = ''
  for (const p of parts) out += p.text
  return out
}

/**
 * Hover body: the signature as a fenced code block, then the doc comment.
 * Returns '' when there's nothing worth showing, so the caller can skip the
 * tooltip entirely rather than flashing an empty box.
 */
export function formatHover(signature: string, docs: string): string {
  const sig = signature.trim()
  const doc = docs.trim()
  if (!sig && !doc) return ''
  const parts: string[] = []
  if (sig) parts.push('```ts\n' + sig + '\n```')
  if (doc) parts.push(doc)
  return parts.join('\n\n')
}

/** Files the TS language service can meaningfully analyze. */
const TS_LIKE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
export function isTsLike(path: string): boolean {
  return TS_LIKE.test(path)
}

/**
 * Compare two filesystem paths for identity. Windows is the reason this exists:
 * TS hands back `D:/a/b.ts` while Electron hands us `D:\a\b.ts`, and drive-letter
 * case varies between the two. Normalize separators + case before comparing.
 */
export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b)
}

export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * Pick the tsconfig that actually OWNS a file.
 *
 * Naively taking the nearest tsconfig.json breaks on the solution-style root
 * config this very repo uses (`{"files": [], "references": [...]}`): it declares
 * no files and no `jsx`, so every .tsx in the project would be reported as
 * broken. The rule: prefer whichever candidate lists the file in its `fileNames`
 * — checking the referenced projects before falling back to the nearest config.
 *
 * Returns the winning config path, or null when nothing claims the file (the
 * caller then uses default compiler options, which still gives a useful
 * single-file service for a repo with no tsconfig at all).
 */
export type ProjectCandidate = { configPath: string; fileNames: string[] }

export function chooseProject(
  file: string,
  nearest: ProjectCandidate | null,
  referenced: ProjectCandidate[] = [],
): string | null {
  const target = normPath(file)
  const claims = (c: ProjectCandidate) => c.fileNames.some((f) => normPath(f) === target)

  // A referenced project that lists the file beats the (possibly file-less)
  // solution root that merely sits closer on disk.
  if (nearest && claims(nearest)) return nearest.configPath
  for (const ref of referenced) {
    if (claims(ref)) return ref.configPath
  }
  // Nothing claims it (new/untracked file). The nearest config with real
  // compilerOptions is still a better guess than nothing.
  return nearest ? nearest.configPath : null
}
