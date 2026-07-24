/**
 * Pure path/selection helpers for the file explorer's IDE-grade operations —
 * multi-select, cut/copy/paste, drag-and-drop move, and keeping open editor
 * tabs pointed at files that moved underneath them.
 *
 * Dependency-free (no React, no Electron, no `path`) so it can be unit-tested
 * straight from source; see `tests/lib-units.mts`. Everything here works on the
 * raw platform paths the main process hands back, which on Windows use `\` —
 * hence the per-path separator sniffing rather than assuming POSIX.
 */

/** Separator style used by a concrete path ('\' on Windows listings, else '/'). */
export function pathSep(p: string): string {
  return p.includes('\\') ? '\\' : '/'
}

/** Last segment of a path ('src/a/b.ts' → 'b.ts'). Trailing separators ignored. */
export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

/** Containing directory of a path, or '' when there is no separator at all. */
export function parentDir(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx < 0) return ''
  // Keep the separator for a filesystem root ('C:\' / '/').
  return idx === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, idx)
}

/** Join a directory and a single entry name using the directory's own style. */
export function joinPath(dir: string, name: string): string {
  const sep = pathSep(dir)
  return dir.replace(/[\\/]+$/, '') + sep + name
}

/**
 * Follow a rename/move: given a path, return where it ends up when `oldPath`
 * becomes `newPath`, or `null` when unaffected. Handles both the moved entry
 * itself and anything beneath it (a moved *folder* drags every open tab under
 * it along).
 */
export function rewritePath(p: string, oldPath: string, newPath: string): string | null {
  if (p === oldPath) return newPath
  const sep = pathSep(oldPath)
  const prefix = oldPath + sep
  if (p.startsWith(prefix)) return newPath + pathSep(newPath) + p.slice(prefix.length)
  return null
}

/** Inclusive slice of `items` between two indices, in either order. */
export function selectRange<T>(items: T[], a: number, b: number): T[] {
  if (a < 0 || b < 0 || a >= items.length || b >= items.length) return []
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return items.slice(lo, hi + 1)
}

/** Ctrl/⌘-click semantics: add the path if absent, remove it if present. */
export function toggleSelection(selection: string[], path: string): string[] {
  return selection.includes(path) ? selection.filter((p) => p !== path) : [...selection, path]
}

/** Is `child` strictly beneath `parent`? Separator- and case-insensitive. */
export function isUnder(parent: string, child: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(child).startsWith(norm(parent) + '/')
}

/**
 * May `sources` be dropped into `targetDir` as a **move**?
 *
 * Rejected when the target is one of the dragged entries, sits inside one of
 * them (a folder can't become its own child), or is already their parent —
 * that last case is a no-op, and showing a drop target for it just invites
 * confusing "nothing happened" moves.
 */
export function canMoveInto(sources: string[], targetDir: string): boolean {
  if (!sources.length) return false
  const eq = (a: string, b: string) =>
    a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
    b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const s of sources) {
    if (eq(s, targetDir)) return false
    if (isUnder(s, targetDir)) return false
  }
  return sources.some((s) => !eq(parentDir(s), targetDir))
}

/**
 * Copies are allowed everywhere a move is, plus back into the same folder
 * (that's "duplicate"). Only self/descendant targets are impossible.
 */
export function canCopyInto(sources: string[], targetDir: string): boolean {
  if (!sources.length) return false
  const eq = (a: string, b: string) =>
    a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
    b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return sources.every((s) => !eq(s, targetDir) && !isUnder(s, targetDir))
}

/**
 * Drop the redundant descendants from a selection: when a folder and something
 * inside it are both selected, only the folder is operated on. Without this a
 * multi-move would try to relocate a child whose parent had already moved out
 * from under it.
 */
export function topLevelPaths(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((other) => other !== p && isUnder(other, p)))
}

/** Workspace-relative, POSIX-slashed form of a path — for "Copy relative path". */
export function relativeToRoot(root: string, filePath: string): string {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const f = norm(filePath)
  return f.toLowerCase().startsWith(r.toLowerCase() + '/') ? f.slice(r.length + 1) : f
}
