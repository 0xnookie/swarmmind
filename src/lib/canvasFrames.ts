/**
 * Frames — named regions on the canvas that own whatever sits inside them.
 *
 * A board full of cards has no structure beyond where things happen to be, so
 * "the auth work" and "the flaky test" are a spatial convention in the user's
 * head and nothing more. A frame makes that convention real: it has a name, it
 * moves its contents with it, and — the part that earns it — it knows which
 * *panes* are inside, so one instruction can go to all of them.
 *
 * Two decisions here are load-bearing:
 *
 *  - **Containment is by centre, not by overlap.** A card straddling two frames
 *    has to belong to exactly one of them or dragging either frame duplicates
 *    the movement and tears the board apart. The centre is unambiguous and
 *    matches what the eye reports.
 *  - **Frames never contain frames.** Nested regions read fine but make the
 *    move recursive, and a cycle (two frames each nominally inside the other,
 *    which overlapping rectangles produce readily) would move a card twice per
 *    drag. Excluding them keeps one flat level with no cycle to detect.
 *
 * Dependency-free (see CLAUDE.md), asserted in tests/lib-units.mts.
 */

export interface FrameBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface FramedItem {
  id: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  paneId?: string
  locked?: boolean
}

/** Frames paint behind every other card, whatever order they were created in. */
export const FRAME_Z = -1000

/**
 * …but a frame's *label* paints in front of them.
 *
 * The label is the only way to grab, rename or address a frame, and the frame
 * itself is by definition underneath a pile of cards — a label sharing the
 * frame's z-index is unclickable the moment a card lands on it, which is the
 * normal state of a frame doing its job. It's drawn as a sibling of the region
 * rather than a child for exactly this reason: a child can never escape its
 * parent's stacking context. Kept below the focus-mode (899000+) and maximized
 * (999999) bands so a card placed in screen space still covers it.
 */
export const FRAME_LABEL_Z = 100_000

export const FRAME_COLORS = ['#e8956b', '#7fb0e8', '#7fc8a0', '#c89be0', '#f4c95d', '#e88ba5']

export const FRAME_HEADER_H = 30
export const MIN_FRAME_W = 260
export const MIN_FRAME_H = 200

export function isFrameKind(kind: string): boolean {
  return kind === 'frame'
}

/**
 * The items a frame owns: everything whose centre falls inside it, except
 * other frames and the frame itself.
 *
 * Locked cards are still *listed* — a lock means "don't move me", which the
 * drag honours separately; leaving them out here would also hide them from the
 * frame's count and from a frame-wide broadcast, neither of which a lock is
 * supposed to mean.
 */
export function frameChildren(frame: FrameBox, items: readonly FramedItem[]): string[] {
  const out: string[] = []
  for (const it of items) {
    if (it.id === frame.id || isFrameKind(it.kind)) continue
    const cx = it.x + it.w / 2
    const cy = it.y + it.h / 2
    if (cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h) {
      out.push(it.id)
    }
  }
  return out
}

/**
 * The panes a frame can speak to — its terminal children, de-duplicated.
 *
 * This is the frame's reason to exist, so it's a function rather than a filter
 * written twice at the two call sites (the header count and the send button)
 * that must never disagree about what "3 agents" meant.
 */
export function framePanes(frame: FrameBox, items: readonly FramedItem[]): string[] {
  const inside = new Set(frameChildren(frame, items))
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of items) {
    if (!inside.has(it.id) || it.kind !== 'terminal' || !it.paneId) continue
    if (seen.has(it.paneId)) continue
    seen.add(it.paneId)
    out.push(it.paneId)
  }
  return out
}

/**
 * Which frame a card belongs to, innermost (smallest) first.
 *
 * Overlapping frames are legal — the smaller one is the more specific label, so
 * a card in both is reported as belonging to that one. Returns null for a card
 * in no frame, which is most of them.
 */
export function frameOf(item: FramedItem, frames: readonly FrameBox[]): string | null {
  let best: { id: string; area: number } | null = null
  for (const f of frames) {
    if (f.id === item.id) continue
    if (!frameChildren(f, [item]).length) continue
    const area = f.w * f.h
    if (!best || area < best.area) best = { id: f.id, area }
  }
  return best?.id ?? null
}

/**
 * A default name for a new frame — `Frame 1`, `Frame 2`, … skipping names
 * already taken, so duplicating a frame twice doesn't produce three cards all
 * called the same thing.
 */
export function nextFrameName(existing: readonly string[], prefix: string): string {
  const taken = new Set(existing.map(n => n.trim().toLowerCase()))
  for (let i = 1; i < 1000; i++) {
    const name = `${prefix} ${i}`
    if (!taken.has(name.toLowerCase())) return name
  }
  return prefix
}

/** Colour for a new frame, cycled so consecutive frames never match. */
export function nextFrameColor(count: number): string {
  return FRAME_COLORS[count % FRAME_COLORS.length]
}
