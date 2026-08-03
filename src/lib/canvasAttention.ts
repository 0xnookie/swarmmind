/**
 * Attention camera — finding the pane that needs you on a board bigger than the
 * screen, and getting there.
 *
 * The board's whole premise is that it can be larger than the viewport, which
 * quietly breaks the one signal that matters: an agent three screens away going
 * "may I edit this file?" is invisible. The TopBar bell knows, the minimap
 * doesn't, and the camera certainly doesn't. This module is the maths for
 * closing that gap — what the camera can currently see, whether a card is
 * outside it, and which card deserves the jump.
 *
 * The selection rule is the load-bearing part. `paneAttention === 'waiting'`
 * means "finished a turn", which is most panes most of the time and would make
 * a follow-camera pan continuously for no reason. The discrete "needs you"
 * signal is the *notification* — already question-gated in `pty-manager`
 * (`looksLikeQuestion`) — so that, not idleness, is what moves the camera.
 *
 * Dependency-free (see CLAUDE.md), asserted in tests/lib-units.mts.
 */

export interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

export interface Viewport {
  w: number
  h: number
}

/** The slice of world the camera currently shows. */
export function viewportWorldRect(camera: Camera, viewport: Viewport): Box {
  const z = Math.max(camera.zoom, 0.01)
  return {
    id: 'viewport',
    x: -camera.x / z,
    y: -camera.y / z,
    w: viewport.w / z,
    h: viewport.h / z,
  }
}

/**
 * Is this card outside what's on screen?
 *
 * Deliberately "outside" and not "fully inside": a card whose header is visible
 * has already announced itself, and a jump chip for something you can see is
 * noise. `margin` shrinks the visible rect, so a card clinging to the very edge
 * still counts as off-screen.
 */
export function isOffscreen(item: Box, view: Box, margin = 0): boolean {
  const vx = view.x + margin
  const vy = view.y + margin
  const vw = Math.max(0, view.w - margin * 2)
  const vh = Math.max(0, view.h - margin * 2)
  return !(item.x < vx + vw && vx < item.x + item.w && item.y < vy + vh && vy < item.y + item.h)
}

/**
 * A camera that centres `item`.
 *
 * The zoom is carried through untouched rather than framed to the card: the
 * user chose this zoom, and a jump that also rescales the board loses the
 * mental map the jump was supposed to preserve.
 */
export function cameraToCenter(item: Box, viewport: Viewport, zoom: number): Camera {
  const z = Math.max(zoom, 0.01)
  const cx = item.x + item.w / 2
  const cy = item.y + item.h / 2
  return { zoom: z, x: viewport.w / 2 - cx * z, y: viewport.h / 2 - cy * z }
}

export interface AttentionCard extends Box {
  kind: string
  paneId?: string
}

/**
 * Which card the "needs you" affordance should point at.
 *
 * Ordering is by the *notification* list, which arrives newest-first — so the
 * chip follows the most recent question rather than whichever card happens to
 * sit earliest in the board's item array. A pane with no card on the board
 * (closed, or never placed) is skipped rather than returned as a target the
 * camera can't reach.
 */
export function pickAttentionTarget(
  cards: readonly AttentionCard[],
  notifiedPaneIds: readonly string[],
): string | null {
  const byPane = new Map<string, string>()
  for (const c of cards) {
    if (c.kind !== 'terminal' || !c.paneId) continue
    if (!byPane.has(c.paneId)) byPane.set(c.paneId, c.id)
  }
  for (const paneId of notifiedPaneIds) {
    const cardId = byPane.get(paneId)
    if (cardId) return cardId
  }
  return null
}

/**
 * Should the follow camera actually move?
 *
 * Only for a target it hasn't already chased (otherwise dismissing the chip and
 * panning away re-snaps you back on the next render) and only when the card is
 * off screen — a visible card needs no camera work, and jerking the board a few
 * pixels to centre something already in view is pure motion sickness.
 */
export function shouldFollow(
  target: string | null,
  lastFollowed: string | null,
  offscreen: boolean,
): boolean {
  if (!target || target === lastFollowed) return false
  return offscreen
}
