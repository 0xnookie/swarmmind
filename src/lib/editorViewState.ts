// ── Per-file editor view state ────────────────────────────────────────────────
//
// `FilePanel` renders `<FileEditor key={activePath}>`, so switching tabs
// *unmounts* the editor and mounts a fresh one. That keying is deliberate (it
// guarantees no state leaks between files), but it means the cursor and scroll
// position are thrown away every time you glance at another tab — you come back
// to line 1 of a 2000-line file. Every real IDE remembers.
//
// This is the pure half: a bounded most-recently-used record of positions, and
// the clamp that makes restoring one safe. Both matter:
//
//  - **Bounded**, because a long session opens hundreds of files and this record
//    would otherwise grow for the life of the process.
//  - **Clamped**, because the remembered offset is a *byte position* in a
//    document that may have changed since (an agent rewrote the file, the user
//    edited it in another pane, git switched branches). Dispatching an
//    out-of-range selection makes CodeMirror throw, which unmounts the editor
//    into the error boundary — a blank panel instead of a file.

export interface EditorViewState {
  /** Selection anchor, as a document offset. */
  anchor: number
  /** Selection head, as a document offset. */
  head: number
  /** `scrollDOM.scrollTop` in px. */
  scrollTop: number
}

export type ViewStateMap = Record<string, EditorViewState>

/** How many files' positions to keep. Roughly "every tab you've touched today". */
export const MAX_REMEMBERED_FILES = 60

/**
 * Record `state` for `path`, evicting the least-recently-recorded entries once
 * the map exceeds `max`.
 *
 * Insertion order is the recency order: re-recording a path deletes and re-adds
 * it so it moves to the end. Object key order is insertion order for string
 * keys, which is exactly the guarantee this relies on.
 */
export function rememberViewState(
  states: ViewStateMap,
  path: string,
  state: EditorViewState,
  max: number = MAX_REMEMBERED_FILES
): ViewStateMap {
  const next: ViewStateMap = {}
  for (const [k, v] of Object.entries(states)) {
    if (k !== path) next[k] = v
  }
  next[path] = state

  const keys = Object.keys(next)
  if (keys.length <= max) return next

  const pruned: ViewStateMap = {}
  for (const k of keys.slice(keys.length - max)) pruned[k] = next[k]
  return pruned
}

/** Drop a path (e.g. it was deleted or renamed). */
export function forgetViewState(states: ViewStateMap, path: string): ViewStateMap {
  if (!(path in states)) return states
  const next: ViewStateMap = {}
  for (const [k, v] of Object.entries(states)) {
    if (k !== path) next[k] = v
  }
  return next
}

/**
 * Make a remembered state safe to apply to a document of `docLength` characters.
 *
 * Returns `null` when there is nothing worth restoring (no state, or a position
 * that clamps to the very top — restoring that is indistinguishable from the
 * default and would only cost a needless dispatch).
 */
export function clampViewState(
  state: EditorViewState | undefined | null,
  docLength: number
): EditorViewState | null {
  if (!state) return null

  const clamp = (n: number): number => {
    if (!Number.isFinite(n)) return 0
    return Math.max(0, Math.min(Math.floor(n), docLength))
  }
  const anchor = clamp(state.anchor)
  const head = clamp(state.head)
  const scrollTop =
    Number.isFinite(state.scrollTop) && state.scrollTop > 0 ? Math.floor(state.scrollTop) : 0

  if (anchor === 0 && head === 0 && scrollTop === 0) return null
  return { anchor, head, scrollTop }
}
