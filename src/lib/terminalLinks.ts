// Terminal→editor bridge: find file-path references (with optional :line) in a
// line of terminal output so they can be turned into clickable links that open
// the file in the editor. Pure and dependency-free so it strips-and-runs in the
// unit tests; the impure half (existence checks, resolution against the pane's
// cwd, xterm registration) lives in usePty.ts.

export interface PathLink {
  /** 0-based char offset of the link's first character (inclusive). */
  start: number
  /** 0-based char offset one past the link's last character (exclusive). */
  end: number
  /** The path exactly as written (may be relative, either slash style). */
  path: string
  /** 1-based line number when the reference carried one (path:12, path(12,5)). */
  line?: number
}

// A path segment: no separators, no shell/glob metacharacters, no whitespace.
const SEG = `[^\\\\/:*?"'<>|\\s()\\[\\]{}\`]+`

// Path candidates, most-specific first: drive-absolute (D:\a\b.ts), dot-relative
// (./a/b.ts, ..\a\b.ts), unix-absolute (/a/b.ts), bare relative with at least
// two segments (src/foo.ts — one bare word is far too noisy to link).
const CAND_RE = new RegExp(
  `[A-Za-z]:(?:[\\\\/]${SEG})+` +
  `|\\.{1,2}(?:[\\\\/]${SEG})+` +
  `|/(?:${SEG}/)*${SEG}` +
  `|${SEG}(?:[\\\\/]${SEG})+`,
  'g',
)

// The last segment must look like a filename: dot + short alphanumeric
// extension. Keeps prose like "and/or" or version strings from linking.
const EXT_RE = /\.[A-Za-z][A-Za-z0-9_]{0,9}$/

// Junk that trails a path when it ends a sentence or sits inside quotes.
const TRAIL_RE = /[.,;!?'"’]+$/

// Line suffix directly after the path: ":12", ":12:5" (compilers, stack traces)
// or "(12,5)" / "(12)" (tsc, MSVC).
const LINE_SUFFIX_RE = /^(?::(\d{1,7})(?::\d{1,7})?|\((\d{1,7})(?:[,:]\d{1,7})?\))/

/** Find file-path references in one line of (ANSI-stripped) terminal text. */
export function findPathLinks(text: string): PathLink[] {
  const out: PathLink[] = []
  CAND_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CAND_RE.exec(text))) {
    const start = m.index
    // A '/' just before means this is the tail of something longer that already
    // failed to parse as a path — usually a URL (https://host/x.ts). Skip it.
    if (start > 0 && (text[start - 1] === '/' || text[start - 1] === '\\')) continue
    let raw = m[0]
    const trail = TRAIL_RE.exec(raw)
    if (trail) raw = raw.slice(0, -trail[0].length)
    if (raw.length < 4 || raw.length > 300) continue
    const lastSeg = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1)
    if (!EXT_RE.test(lastSeg)) continue
    let end = start + raw.length
    let line: number | undefined
    const suffix = LINE_SUFFIX_RE.exec(text.slice(end))
    if (suffix) {
      line = Number(suffix[1] ?? suffix[2])
      end += suffix[0].length
    }
    out.push(line !== undefined ? { start, end, path: raw, line } : { start, end, path: raw })
  }
  return out
}

/** True when the path is absolute on either platform (drive letter or leading slash). */
export function isAbsolutePathLike(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\')
}

/**
 * Candidate absolute paths for a (possibly relative) reference, in probe order.
 * `baseDirs` should be ordered most-specific first (worktree, pane cwd,
 * workspace root); duplicates are dropped. Pure string joining — the caller
 * checks which candidate actually exists.
 */
export function candidateAbsolutePaths(path: string, baseDirs: (string | null | undefined)[]): string[] {
  if (isAbsolutePathLike(path)) return [path]
  const seen = new Set<string>()
  const out: string[] = []
  for (const base of baseDirs) {
    if (!base) continue
    const joined = base.replace(/[\\/]+$/, '') + '/' + path.replace(/^\.[\\/]/, '')
    if (!seen.has(joined)) {
      seen.add(joined)
      out.push(joined)
    }
  }
  return out
}
