/**
 * Pure geometry for the canvas board's layout tools — focus mode, tidy/align,
 * marquee selection, and eraser hit-testing.
 *
 * `CanvasMode.tsx` is the impure shell (React state, pointer events, the live
 * pane tree). Everything here is arithmetic over plain rectangles, which is
 * where this feature's real bugs live: a dock that overflows the viewport, a
 * tidy pass that quietly overlaps cards, an eraser that swallows a running
 * terminal. Asserted in tests/lib-units.mts.
 */

// Deliberately dependency-free (see CLAUDE.md): the grid step is passed in by
// the caller rather than imported from canvasResize, so this module strips and
// runs straight from source in the test runner — and so there is still exactly
// one definition of GRID, not a second literal drifting out of sync with it.

export interface Rect { x: number; y: number; w: number; h: number }
export interface Sized { id: string; x: number; y: number; w: number; h: number }

// ── Focus mode ──────────────────────────────────────────────────────────────
// One terminal takes the stage and the rest queue up along the right edge —
// the "one big terminal, the others within reach" arrangement you want while
// actually working, as opposed to the spatial overview the board is for.
//
// Geometry is in SCREEN pixels: the cards are painted through the camera
// transform, but their focus placement must not move when you pan or zoom.

export const FOCUS_PAD = 14
export const FOCUS_GAP = 10
export const DOCK_W = 268
/** Below this a docked terminal is a title bar with no usable rows left. */
export const DOCK_MIN_H = 72
export const DOCK_MAX_H = 240

export interface FocusLayout {
  stage: Rect
  dock: Map<string, Rect>
  /** Docked terminals that didn't fit; the caller hides them and says how many. */
  hidden: string[]
}

/**
 * Place `focusedId` on the stage and the others in the right-hand dock.
 *
 * The dock is top-aligned (it reads as a queue, not a centred gallery) and
 * **never overflows**: slots shrink to fit down to DOCK_MIN_H, and past that
 * the surplus is reported in `hidden` rather than being drawn off the bottom
 * edge where it can't be clicked. With nothing to dock, the stage takes the
 * full width instead of leaving a hole.
 */
export function focusLayout(ids: string[], focusedId: string, viewport: { w: number; h: number }): FocusLayout {
  const others = ids.filter(id => id !== focusedId)
  const availH = Math.max(0, viewport.h - FOCUS_PAD * 2)

  if (others.length === 0 || viewport.w < DOCK_W * 2) {
    return {
      stage: { x: FOCUS_PAD, y: FOCUS_PAD, w: Math.max(1, viewport.w - FOCUS_PAD * 2), h: Math.max(1, availH) },
      dock: new Map(),
      hidden: others,
    }
  }

  // How many slots fit at the smallest usable height; anything beyond that is
  // hidden rather than squeezed into an unusable sliver.
  const perSlot = DOCK_MIN_H + FOCUS_GAP
  const maxSlots = Math.max(1, Math.floor((availH + FOCUS_GAP) / perSlot))
  const shown = others.slice(0, maxSlots)
  const hidden = others.slice(maxSlots)

  const n = shown.length
  const slotH = clamp((availH - FOCUS_GAP * (n - 1)) / n, DOCK_MIN_H, DOCK_MAX_H)
  const dockX = viewport.w - DOCK_W - FOCUS_PAD

  const dock = new Map<string, Rect>()
  shown.forEach((id, i) => {
    dock.set(id, { x: dockX, y: FOCUS_PAD + i * (slotH + FOCUS_GAP), w: DOCK_W, h: slotH })
  })

  return {
    stage: {
      x: FOCUS_PAD,
      y: FOCUS_PAD,
      w: Math.max(1, viewport.w - DOCK_W - FOCUS_PAD * 3),
      h: Math.max(1, availH),
    },
    dock,
    hidden,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// ── Align & tidy ────────────────────────────────────────────────────────────

/**
 * Quantise every item's position and size onto the board grid — the "make this
 * mess line up" pass. Sizes snap too (a card whose width is 503 never looks
 * aligned however well its corner sits) but never below one cell.
 */
export function snapAll(items: Sized[], grid: number): Map<string, Rect> {
  const q = (v: number) => Math.round(v / grid) * grid
  const out = new Map<string, Rect>()
  for (const it of items) {
    out.set(it.id, {
      x: q(it.x),
      y: q(it.y),
      w: Math.max(grid, q(it.w)),
      h: Math.max(grid, q(it.h)),
    })
  }
  return out
}

/**
 * Reflow items into an even grid, keeping each card's own size.
 *
 * Reading order is preserved — items are sorted by their current position in
 * rows, so "tidy" rearranges the spacing, not your mental map of the board.
 * Cells are as wide as the widest card and as tall as the tallest, so nothing
 * can overlap afterwards regardless of how uneven the sizes were, and the whole
 * block starts at the (snapped) top-left of what it replaced.
 */
export function tidyGrid(items: Sized[], grid: number, columns?: number): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (items.length === 0) return out

  const originX = Math.round(Math.min(...items.map(i => i.x)) / grid) * grid
  const originY = Math.round(Math.min(...items.map(i => i.y)) / grid) * grid
  const cellW = Math.max(...items.map(i => i.w)) + grid
  const cellH = Math.max(...items.map(i => i.h)) + grid

  // Row-major reading order. The row band is the tallest card, so items that
  // merely differ in y within one visual row don't get shuffled.
  const rowBand = Math.max(...items.map(i => i.h)) || 1
  const ordered = [...items].sort((a, b) => {
    const ra = Math.floor(a.y / rowBand), rb = Math.floor(b.y / rowBand)
    return ra !== rb ? ra - rb : a.x - b.x
  })

  const cols = Math.max(1, columns ?? Math.ceil(Math.sqrt(ordered.length)))
  ordered.forEach((it, i) => {
    out.set(it.id, {
      x: originX + (i % cols) * cellW,
      y: originY + Math.floor(i / cols) * cellH,
    })
  })
  return out
}

// ── Marquee selection ───────────────────────────────────────────────────────
// Drag a box over empty board to select everything it touches, then drag any
// one of them to move the whole set. The maths that matters is the hit test
// (what counts as "inside the box") and the group delta (what stops snapping
// from shearing a selection apart).

/**
 * A rectangle from two dragged corners, in any direction.
 *
 * The pointer can end up left of and above where it started, which yields a
 * negative width/height — useless for both hit-testing and for a CSS box.
 */
export function normalizeRect(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  }
}

/** Do two axis-aligned rectangles overlap? Touching edges don't count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Does the segment (x1,y1)→(x2,y2) touch `r`? Liang–Barsky clipping.
 *
 * A degenerate segment (both ends the same point) reduces to a point-in-rect
 * test, which is the behaviour a one-dot stroke needs.
 */
export function segmentIntersectsRect(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  const dx = x2 - x1, dy = y2 - y1
  const p = [-dx, dx, -dy, dy]
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1]
  let t0 = 0, t1 = 1
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      // Parallel to this edge: outside its slab means it can never enter.
      if (q[i] < 0) return false
      continue
    }
    const t = q[i] / p[i]
    if (p[i] < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return true
}

export interface SelectTarget {
  id: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  locked?: boolean
  /** Freehand strokes: points relative to {x,y}. */
  points?: { x: number; y: number }[]
}

/**
 * Which items a marquee catches (world coordinates).
 *
 * **Touching selects**, as in Figma/Miro — requiring full containment means
 * anything larger than the screen could never be picked up.
 *
 * A stroke is tested against its path for the same reason the eraser is: a
 * hand-drawn arrow across the board has a bounding box covering everything
 * between its ends, so a box drawn near one corner of it would silently drag a
 * scribble along with the cards. Locked items are never selected — they can't
 * be moved, resized or deleted, so putting them in a selection only makes the
 * next drag look broken.
 */
export function marqueeHits(items: SelectTarget[], rect: Rect): string[] {
  // A click is a box with no width *and* no height, and must select nothing —
  // note this needs saying: a zero-area box dropped inside a card still counts
  // as overlapping it. A sweep flat along one axis is a real gesture, though,
  // so only the fully degenerate case bails.
  if (rect.w === 0 && rect.h === 0) return []
  const out: string[] = []
  for (const it of items) {
    if (it.locked) continue
    if (it.kind === 'draw') {
      const pts = it.points ?? []
      if (pts.length === 0) continue
      const hit = pts.length === 1
        ? segmentIntersectsRect(it.x + pts[0].x, it.y + pts[0].y, it.x + pts[0].x, it.y + pts[0].y, rect)
        : pts.some((pt, i) => i > 0 && segmentIntersectsRect(
            it.x + pts[i - 1].x, it.y + pts[i - 1].y, it.x + pt.x, it.y + pt.y, rect))
      if (hit) out.push(it.id)
      continue
    }
    if (rectsOverlap(it, rect)) out.push(it.id)
  }
  return out
}

/** The box around a set of items — the outline drawn for a multi-selection. */
export function selectionBounds(items: Sized[]): Rect | null {
  if (items.length === 0) return null
  const x = Math.min(...items.map(i => i.x))
  const y = Math.min(...items.map(i => i.y))
  const r = Math.max(...items.map(i => i.x + i.w))
  const b = Math.max(...items.map(i => i.y + i.h))
  return { x, y, w: r - x, h: b - y }
}

/**
 * The offset to apply to every item in a dragged selection.
 *
 * Snapping is resolved **once, against the grabbed card**, and the resulting
 * delta moves the whole group. Snapping each item to the grid independently
 * would quantise their gaps as well as their positions, so a selection dragged
 * with snap on would arrive subtly rearranged — items that were 30px apart
 * landing flush, alignment you'd set up by hand destroyed by moving it.
 */
export function dragDelta(
  anchor: { x: number; y: number },
  dx: number,
  dy: number,
  grid: number | null,
): { dx: number; dy: number } {
  if (!grid) return { dx, dy }
  const q = (v: number) => Math.round(v / grid) * grid
  return { dx: q(anchor.x + dx) - anchor.x, dy: q(anchor.y + dy) - anchor.y }
}

// ── Eraser ──────────────────────────────────────────────────────────────────

/** Eraser radius in SCREEN px; divided by zoom to get world units. */
export const ERASER_RADIUS = 16

/**
 * What the eraser is allowed to remove.
 *
 * Annotation only. A terminal is a live pty, a browser holds page state, and a
 * task card is a row in the tasks table — losing one of those to a stray swipe
 * is not an "oops, redraw it" the way a pen stroke is, so they're immune and
 * must be deleted deliberately (✕ / Delete / context menu).
 */
const ERASABLE = new Set(['draw', 'note', 'text', 'shape', 'image'])

export function isErasableKind(kind: string): boolean {
  return ERASABLE.has(kind)
}

/** Distance from a point to a line segment (0 when the segment is a point). */
export function pointSegmentDistance(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number,
): number {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  // Projection of the point onto the segment, clamped to its ends.
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / lenSq, 0, 1)
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

export interface EraseTarget {
  id: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  locked?: boolean
  /** Freehand strokes: points relative to {x,y}. */
  points?: { x: number; y: number }[]
  strokeWidth?: number
}

/**
 * Whether the eraser at world point (px,py) with `radius` catches this item.
 *
 * A stroke is tested against its actual path, not its bounding box — erasing
 * inside the open loop of a hand-drawn circle should not delete it. Everything
 * else is a plain rect hit. Locked and non-erasable items never match.
 */
export function eraserHits(item: EraseTarget, px: number, py: number, radius: number): boolean {
  if (item.locked || !isErasableKind(item.kind)) return false

  if (item.kind === 'draw') {
    const pts = item.points ?? []
    if (pts.length === 0) return false
    const r = radius + (item.strokeWidth ?? 2) / 2
    if (pts.length === 1) {
      return Math.hypot(px - (item.x + pts[0].x), py - (item.y + pts[0].y)) <= r
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]
      if (pointSegmentDistance(px, py, item.x + a.x, item.y + a.y, item.x + b.x, item.y + b.y) <= r) return true
    }
    return false
  }

  // Rect hit, grown by the eraser radius so brushing an edge counts.
  return px >= item.x - radius && px <= item.x + item.w + radius &&
         py >= item.y - radius && py <= item.y + item.h + radius
}
