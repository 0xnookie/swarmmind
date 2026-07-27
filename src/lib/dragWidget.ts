// Placement maths for draggable floating widgets.
//
// The part that's easy to get wrong isn't the drag itself — it's everything
// after: a widget dropped near an edge must stay fully on screen when the
// window is resized, when it's restored from a previous session at a size the
// window no longer has, and when a display change makes the viewport smaller
// than the saved coordinates. Inline drag handlers usually clamp on drag and
// forget the other three, so the widget ends up unreachable off-edge.
//
// Pure, so all four cases are unit-testable.

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

// Keep `pos` fully inside `viewport`, leaving `margin` px of breathing room.
// When the viewport is smaller than the widget the widget wins: it's pinned to
// the top-left rather than pushed to a negative coordinate, so it stays
// grabbable instead of drifting off-screen.
export function clampToViewport(
  pos: Point,
  size: Size,
  viewport: Size,
  margin = 8,
): Point {
  const maxX = viewport.width - size.width - margin
  const maxY = viewport.height - size.height - margin
  return {
    x: Math.round(Math.min(Math.max(pos.x, margin), Math.max(margin, maxX))),
    y: Math.round(Math.min(Math.max(pos.y, margin), Math.max(margin, maxY))),
  }
}

// Where the widget's top-left goes for a pointer at (clientX, clientY), given
// where inside the widget it was grabbed. Keeping the grab offset is what makes
// the widget track the cursor instead of jumping its corner to the pointer.
export function dragPosition(
  pointer: Point,
  grabOffset: Point,
  size: Size,
  viewport: Size,
  margin = 8,
): Point {
  return clampToViewport(
    { x: pointer.x - grabOffset.x, y: pointer.y - grabOffset.y },
    size,
    viewport,
    margin,
  )
}

// Starting position when the widget has never been placed: just inside the
// bottom-right corner, above where the OS taskbar usually sits.
export function defaultPosition(size: Size, viewport: Size, margin = 16): Point {
  return clampToViewport(
    { x: viewport.width - size.width - margin, y: viewport.height - size.height - margin * 2 },
    size,
    viewport,
    margin,
  )
}

// Parse a persisted position. Anything malformed (old format, hand-edited
// setting, NaN from a previous bug) returns null so the caller falls back to
// the default corner rather than rendering at an unusable coordinate.
export function parsePosition(raw: string | null | undefined): Point | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
    const { x, y } = parsed ?? {}
    // Require actual numbers rather than coercing: `Number(null)` is 0, which
    // would silently pin a widget with a missing coordinate to the screen edge
    // instead of falling back to the default corner.
    return typeof x === 'number' && Number.isFinite(x) &&
           typeof y === 'number' && Number.isFinite(y)
      ? { x, y }
      : null
  } catch {
    return null
  }
}
