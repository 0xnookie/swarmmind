/**
 * Semantic zoom (level-of-detail) for the canvas board — pure geometry.
 *
 * The board stops paying off at exactly the pane count that makes a swarm
 * interesting: zoomed out far enough to see eight terminals at once, every one
 * of them is a 3px-tall smear of unreadable glyphs. Rendering a *status tile*
 * instead below a zoom threshold turns that same view into a dashboard — agent,
 * task, state, spend — and zooming back in returns the live terminal.
 *
 * Two things here are load-bearing and both are why this is a module rather
 * than a couple of inline comparisons:
 *
 *  - **Hysteresis.** One threshold means a wheel nudge parked exactly on the
 *    boundary flips every terminal on the board between two completely
 *    different renderings, several times a second. Entering tile mode and
 *    leaving it use different zooms, so the transition happens once.
 *  - **Sizes are world units derived from a screen target.** The tile is drawn
 *    inside the world layer, which is scaled by the camera — so a fixed 13px
 *    font would render at 4px at the zoom where tiles exist at all. Everything
 *    here is `screenPx / zoom`, clamped against the card so a small card gets
 *    less text instead of overflowing text.
 *
 * Dependency-free (see CLAUDE.md), asserted in tests/lib-units.mts.
 */

/** Below this zoom a terminal card renders as a status tile. */
export const TILE_ZOOM_ENTER = 0.55
/** …and it takes zooming past *this* to get the live terminal back. */
export const TILE_ZOOM_EXIT = 0.66

/**
 * Should this card render as a tile right now?
 *
 * `wasTile` is the previous answer, which is what makes the two thresholds a
 * hysteresis band rather than two unrelated constants: inside the band the
 * answer is "whatever it already was".
 */
export function isTileZoom(zoom: number, wasTile: boolean): boolean {
  if (wasTile) return zoom < TILE_ZOOM_EXIT
  return zoom < TILE_ZOOM_ENTER
}

export type TileState = 'waiting' | 'working' | 'idle' | 'stopped'

/**
 * What a terminal tile says the pane is doing.
 *
 * `paneAttention` only exists while a pty is alive, so the pty status decides
 * first: a pane that exited while it happened to be `working` must not keep
 * claiming it is. "waiting" is the one that matters — it's the state the board
 * exists to surface.
 */
export function tileState(input: { ptyStatus: string; attention?: 'working' | 'waiting' | null }): TileState {
  if (input.ptyStatus !== 'running') return input.ptyStatus === 'idle' ? 'idle' : 'stopped'
  if (input.attention === 'waiting') return 'waiting'
  if (input.attention === 'working') return 'working'
  return 'idle'
}

export const TILE_STATE_COLOR: Record<TileState, string> = {
  waiting: '#f4c95d',
  working: '#7fc8a0',
  idle: '#8a807a',
  stopped: '#e88ba5',
}

export interface TileMetrics {
  /** World-unit padding, font sizes and dot diameter. */
  pad: number
  title: number
  meta: number
  dot: number
  gap: number
  /** A card too small on screen to fit them drops the lower rows entirely. */
  showTitle: boolean
  showMeta: boolean
}

/**
 * Tile typography in **world units**, sized so it lands at a fixed size on
 * screen and never outgrows the card it's drawn in.
 *
 * The clamps against `card` are the whole reason this isn't `13 / zoom`: a
 * terminal card the user shrank to a 140×80 stub would otherwise get 13px-tall
 * text in a box 3 lines high and paint over its own border. Below the size
 * where a row can be read at all, the row is dropped rather than clipped — a
 * tile showing half a word is worse than a tile showing a status dot.
 */
export function tileMetrics(zoom: number, card: { w: number; h: number }): TileMetrics {
  const z = Math.max(zoom, 0.01)
  const px = (screen: number) => screen / z
  const screenW = card.w * z
  const screenH = card.h * z
  return {
    pad: Math.min(px(11), card.w * 0.07, card.h * 0.1),
    title: Math.min(px(13), card.h * 0.26),
    meta: Math.min(px(10.5), card.h * 0.19),
    dot: Math.min(px(8), card.h * 0.16),
    gap: Math.min(px(6), card.h * 0.08),
    showTitle: screenH >= 30 && screenW >= 64,
    showMeta: screenH >= 74 && screenW >= 116,
  }
}

/**
 * The spend figure on a tile.
 *
 * Sub-cent amounts round to `$0.00`, which reads as "this agent is free" — the
 * exact opposite of the thing the number exists to warn about — so anything
 * above zero shows at least `<$0.01`.
 */
export function tileCost(usd: number | undefined): string | null {
  if (!usd || usd <= 0) return null
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}
