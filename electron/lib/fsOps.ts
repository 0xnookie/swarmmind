/**
 * Pure helpers for the mutating filesystem operations (create / rename / move /
 * copy / duplicate) exposed by `electron/ipc/filesystem.ts`.
 *
 * These are the parts that are easy to get subtly wrong — name validation that
 * has to stay portable across Windows and POSIX, collision-free "copy" naming,
 * and the containment check that stops a move from swallowing its own parent —
 * so per CLAUDE.md they live here, dependency-free, and are asserted against in
 * `tests/lib-units.mts` rather than only exercised through the UI.
 */

/** Device names Windows still reserves, with or without an extension. */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/**
 * Control characters (U+0000-U+001F) are legal in POSIX names but produce
 * entries no tool can address. Checked by code point rather than a regex
 * literal so the source file stays free of raw control bytes.
 */
function hasControlChars(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 0x20) return true
  }
  return false
}

/** Characters the Win32 API refuses outright in a path segment. */
const WINDOWS_ILLEGAL = /[<>:"|?*]/

/**
 * Split a filename into stem + extension, treating a leading dot as part of the
 * name (`.gitignore` is all stem, not an extension) so dotfiles round-trip.
 */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

/**
 * Is `name` usable as a single directory entry?
 *
 * Always rejected: empty, over-long, `.`/`..`, path separators and control
 * characters. With `windows: true` we additionally reject the characters and
 * device names the Win32 API refuses, plus trailing dots/spaces (which Windows
 * silently strips, so the file you get is not the file you asked for).
 */
export function isValidEntryName(name: string, opts: { windows?: boolean } = {}): boolean {
  if (!name || name.length > 255) return false
  if (name === '.' || name === '..') return false
  if (/[\\/]/.test(name)) return false
  if (hasControlChars(name)) return false
  if (!opts.windows) return true
  if (WINDOWS_ILLEGAL.test(name)) return false
  if (/[. ]$/.test(name)) return false
  const stem = name.split('.')[0].toUpperCase()
  return !WINDOWS_RESERVED.has(stem)
}

/** Normalize separators and drop a trailing one, so path compares line up. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Is `child` strictly beneath `parent`? Used to refuse moving/copying a folder
 * into itself or one of its own descendants — `fs.rename` would happily do it
 * and leave an unreachable subtree behind.
 */
export function isInside(parent: string, child: string, caseInsensitive = false): boolean {
  const p = normalize(parent)
  const c = normalize(child)
  const [a, b] = caseInsensitive ? [p.toLowerCase(), c.toLowerCase()] : [p, c]
  return b.startsWith(a + '/')
}

/** Same path, modulo separator style, trailing slash and (optionally) case. */
export function samePathish(a: string, b: string, caseInsensitive = false): boolean {
  const x = normalize(a)
  const y = normalize(b)
  return caseInsensitive ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * Pick a name for `name` that isn't in `taken`, Finder/VS Code style:
 * `foo.ts` → `foo copy.ts` → `foo copy 2.ts` → …
 *
 * An existing ` copy`/` copy N` suffix is stripped first, so duplicating a
 * duplicate yields `foo copy 2.ts` rather than `foo copy copy.ts`.
 */
export function nextAvailableName(
  name: string,
  taken: Iterable<string>,
  opts: { caseInsensitive?: boolean } = {}
): string {
  const ci = opts.caseInsensitive ?? true
  const key = (s: string) => (ci ? s.toLowerCase() : s)
  const used = new Set<string>()
  for (const t of taken) used.add(key(t))
  if (!used.has(key(name))) return name

  const { stem, ext } = splitName(name)
  const base = stem.replace(/ copy( \d+)?$/i, '')
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${base} copy${ext}` : `${base} copy ${i}${ext}`
    if (!used.has(key(candidate))) return candidate
  }
  // Pathological directory (1000 copies) — fall back to something unique.
  return `${base} copy ${Date.now()}${ext}`
}
