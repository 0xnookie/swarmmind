// Extract file-targeted fenced code blocks from a Markdown reply, so a chat
// answer that contains "here's the new src/foo.ts" can be turned into a
// one-click, previewable apply (Cursor's chat → diff → apply). Pure and
// dependency-free so it strips-and-runs in the unit layer (tests/lib-units.mts).
//
// A block counts as "file-targeted" when a path is discoverable either from the
// fence info string (```ts src/foo.ts, ```ts:src/foo.ts, ```ts title=src/foo.ts)
// or from the line immediately preceding the fence (a bare/backticked/bold path,
// optionally trailed by a colon — e.g. **src/foo.ts**, `src/foo.ts`, File: x.ts).
// Blocks with no resolvable path are skipped (prose snippets, shell, etc.).

export interface FileBlock {
  /** Forward-slash relative path the block targets. */
  path: string
  /** Best-effort language token from the fence info string ('' if none). */
  language: string
  /** Block body, trailing newline trimmed. */
  content: string
}

// A path token: allowed path chars with a dotted extension, no spaces. Accepts
// both nested (src/a/b.ts) and root (package.json) paths.
const PATH_RE = /^[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+$/

// Strip surrounding decoration a path may wear in prose: backticks, bold/italic
// markers, a leading "File:"/"Path:" label, a trailing colon, quotes.
function cleanPathCandidate(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^(?:file|path)\s*:\s*/i, '')
  s = s.replace(/^[`*_"'(\[]+/, '').replace(/[`*_"')\]:]+$/, '')
  return s.trim().replace(/\\/g, '/')
}

function asPath(raw: string): string | null {
  const s = cleanPathCandidate(raw)
  if (!s || /\s/.test(s)) return null
  return PATH_RE.test(s) ? s : null
}

// Pull a path out of a fence info string. The first token is the language; a
// later token, or a `lang:path` colon form, may carry the path.
function pathFromInfo(info: string): { language: string; path: string | null } {
  const trimmed = info.trim()
  if (!trimmed) return { language: '', path: null }
  const tokens = trimmed.split(/\s+/)
  const first = tokens[0]
  // `lang:path` (Cursor style)
  const colon = first.indexOf(':')
  if (colon > 0) {
    const p = asPath(first.slice(colon + 1))
    if (p) return { language: first.slice(0, colon), path: p }
  }
  // language then a path token, possibly `title=path`/`file=path`
  for (let i = 1; i < tokens.length; i++) {
    const eq = tokens[i].indexOf('=')
    const cand = eq >= 0 ? tokens[i].slice(eq + 1) : tokens[i]
    const p = asPath(cand)
    if (p) return { language: first, path: p }
  }
  // first token might itself be a bare path (```src/foo.ts)
  const asFirst = asPath(first)
  if (asFirst) return { language: '', path: asFirst }
  return { language: first, path: null }
}

export function extractFileBlocks(markdown: string): FileBlock[] {
  const lines = markdown.split('\n')
  const out: FileBlock[] = []
  let i = 0
  let prevNonEmpty = ''
  while (i < lines.length) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})(.*)$/)
    if (!open) {
      if (lines[i].trim()) prevNonEmpty = lines[i].trim()
      i++
      continue
    }
    const fence = open[2]
    const info = open[3]
    // Collect the block body until the matching closing fence (same char, >= len).
    const bodyLines: string[] = []
    let j = i + 1
    let closed = false
    for (; j < lines.length; j++) {
      const close = lines[j].match(/^(\s*)(`{3,}|~{3,})\s*$/)
      if (close && close[2][0] === fence[0] && close[2].length >= fence.length) {
        closed = true
        break
      }
      bodyLines.push(lines[j])
    }
    const fromInfo = pathFromInfo(info)
    const path = fromInfo.path ?? asPath(prevNonEmpty)
    if (path) {
      out.push({
        path,
        language: fromInfo.language,
        content: bodyLines.join('\n').replace(/\n+$/, ''),
      })
    }
    // Advance past the block; the closing fence is not a path label.
    i = closed ? j + 1 : j
    prevNonEmpty = ''
  }
  return out
}
