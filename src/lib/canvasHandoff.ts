/**
 * Pure geometry + prompt helpers for Canvas mode's "capture → annotate → hand
 * off to an agent" loop (the impure DOM/compositing shell lives in
 * `CanvasMode.tsx`). Extracted per CLAUDE.md so the fiddly parts — mapping a
 * freehand stroke drawn in *world* coordinates onto an image's *pixel* grid,
 * deciding which strokes sit over a screenshot, and building the single-line
 * prompt injected into a terminal — are unit-tested rather than only exercised
 * by eyeballing a screenshot.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Do two axis-aligned boxes overlap at all? (Touching edges don't count.) */
export function rectsIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Fit a natural-size image into a max box, preserving aspect ratio and never
 * upscaling (scale ≤ 1). Mirrors the sizing the image tool has always used, so
 * a captured screenshot lands the same size as a dropped one.
 */
export function fitBox(natW: number, natH: number, maxW: number, maxH: number): { w: number; h: number } {
  if (!(natW > 0) || !(natH > 0)) return { w: Math.round(maxW), h: Math.round(maxH) }
  const scale = Math.min(1, maxW / natW, maxH / natH)
  return { w: Math.max(80, Math.round(natW * scale)), h: Math.max(60, Math.round(natH * scale)) }
}

/**
 * Project a world point onto an image's local pixel coordinates. The image card
 * is displayed at `image.w × image.h` world units but the underlying picture is
 * `natW × natH` pixels; a stroke drawn over the card must be scaled by that
 * ratio to bake in at full resolution.
 */
export function projectPointToImage(
  image: Box,
  natW: number,
  natH: number,
  wx: number,
  wy: number
): { x: number; y: number } {
  const sx = image.w > 0 ? natW / image.w : 1
  const sy = image.h > 0 ? natH / image.h : 1
  return { x: (wx - image.x) * sx, y: (wy - image.y) * sy }
}

/** Average of the two axis scale factors — the stroke width baked onto an image
 *  has no single axis, so it scales by the mean (matches a uniform-ish resize). */
export function strokeScale(image: Box, natW: number, natH: number): number {
  const sx = image.w > 0 ? natW / image.w : 1
  const sy = image.h > 0 ? natH / image.h : 1
  return (sx + sy) / 2
}

/**
 * Build the one-line prompt injected into a terminal. Agents read input through
 * the PTY, so the handoff references the saved screenshot by path rather than
 * inlining pixels; whitespace in the note is collapsed so a multi-line textarea
 * can never submit the prompt early. An empty note falls back to a generic ask.
 */
export function buildHandoffPrompt(
  note: string | null | undefined,
  relPath: string,
  fallback = 'Take a look at this screenshot.'
): string {
  const clean = (note ?? '').replace(/\s+/g, ' ').trim()
  const body = clean || fallback
  return `${body} (screenshot: ${relPath})`
}
