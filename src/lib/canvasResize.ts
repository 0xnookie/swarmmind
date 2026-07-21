// Geometry for canvas card resizing from any of the 8 handles.
//
// Kept pure (no React / DOM) so the fiddly part — which edge moves, which edge
// stays pinned, and how snapping and minimum sizes interact — can be asserted
// directly in tests/lib-units.mts.

// ── Board grid ───────────────────────────────────────────────────────────────
// Spacing of the board grid in world units. This is the single definition:
// snapping AND the drawn dots/lines both derive from it. They were previously
// independent literals (20 for snapping, 28 for the background), so snapped
// items landed on an invisible lattice that never matched the visible grid —
// which read as "snap to grid does nothing".

export const GRID = 28

/** Quantise a world coordinate to the grid (or just round, when snap is off). */
export function snapToGrid(v: number, on: boolean): number {
  return on ? Math.round(v / GRID) * GRID : Math.round(v)
}

/**
 * CSS `background-position` offset (in board px) for the tiled grid pattern,
 * given the camera translation on that axis.
 *
 * The pattern is tiled at `GRID * zoom`, so tile edges fall on world multiples
 * of GRID. Dots need a half-cell shift because a `radial-gradient` is centred
 * in its tile by default — without it the dots sit half a cell off the snap
 * lattice and a snapped corner lands between four dots.
 */
export function gridBackgroundOffset(camOffset: number, zoom: number, kind: 'dots' | 'grid'): number {
  const size = GRID * zoom
  // Normalised into [0, size); tiling is periodic so this is cosmetic, but it
  // keeps the value predictable for negative camera offsets.
  const base = ((camOffset % size) + size) % size
  return kind === 'dots' ? base - size / 2 : base
}

export type ResizeDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const RESIZE_DIRS: ResizeDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export const RESIZE_CURSOR: Record<ResizeDir, string> = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface ResizeOpts {
  minW: number
  minH: number
  /** Grid step to snap the dragged edge to, or null for free resize. */
  grid?: number | null
}

/**
 * Apply a pointer delta to `orig` for the given handle.
 *
 * The dragged edge follows the pointer; the opposite edge stays exactly where
 * it was. That pinning is why snapping is applied to the *moving edge* and the
 * other dimension is then derived from the fixed edge — snapping `x` and `w`
 * independently would quietly shift the far edge too (drag the west handle and
 * the east side would creep).
 *
 * Minimum sizes are enforced against the same anchor, so shrinking past the
 * limit from the west stops the card growing leftwards instead of sliding it.
 */
export function resizeRect(orig: Rect, dir: ResizeDir, dx: number, dy: number, opts: ResizeOpts): Rect {
  const { minW, minH, grid } = opts
  const snap = (v: number) => (grid && grid > 0 ? Math.round(v / grid) * grid : Math.round(v))

  const west = dir.includes('w')
  const east = dir.includes('e')
  const north = dir.includes('n')
  const south = dir.includes('s')

  // Edges of the untouched rect — the pin points.
  const eastEdge = orig.x + orig.w
  const southEdge = orig.y + orig.h

  let { x, y, w, h } = orig

  if (east) w = snap(eastEdge + dx) - x
  if (west) { x = snap(orig.x + dx); w = eastEdge - x }
  if (south) h = snap(southEdge + dy) - y
  if (north) { y = snap(orig.y + dy); h = southEdge - y }

  if (w < minW) {
    if (west) x = eastEdge - minW
    w = minW
  }
  if (h < minH) {
    if (north) y = southEdge - minH
    h = minH
  }

  return { x, y, w, h }
}
