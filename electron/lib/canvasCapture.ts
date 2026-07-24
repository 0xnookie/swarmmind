/**
 * Pure parsing for Canvas mode's screenshot-capture handoff (the IPC handler in
 * `electron/ipc/filesystem.ts` is the impure shell that writes the file). The
 * renderer hands the main process a `data:` URL from a webview `capturePage()`
 * (plus any baked-in annotations); this validates and decodes it before a byte
 * is written to disk. Dependency-free and unit-tested per CLAUDE.md.
 */

export interface ParsedImageDataUrl {
  /** File extension to save under. */
  ext: 'png' | 'jpg'
  /** The raw base64 payload, whitespace stripped. */
  base64: string
}

/** Screenshots are bounded so a runaway capture can't write an enormous file. */
export const MAX_CAPTURE_BYTES = 25 * 1024 * 1024

/**
 * Parse a base64 image data URL, accepting only PNG/JPEG (what a webview
 * capture and the canvas compositor produce). Returns null for anything else —
 * an SVG or `data:text/html` URL must never round-trip to a saved image.
 */
export function parseImageDataUrl(dataUrl: string | null | undefined): ParsedImageDataUrl | null {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl ?? '')
  if (!m) return null
  const base64 = m[2].replace(/\s+/g, '')
  if (!base64) return null
  return { ext: m[1] === 'png' ? 'png' : 'jpg', base64 }
}
