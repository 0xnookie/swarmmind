// ── Code folding ──────────────────────────────────────────────────────────────
//
// CodeMirror's stock `foldGutter()` draws its markers as **text**: the literal
// characters `⌄` and `›` in a `document.createTextNode`. They inherit the
// editor's monospace font, so their size, weight and vertical centring are
// whatever JetBrains Mono happens to do with those two codepoints — which is why
// the open and closed markers appear at different sizes and neither lines up
// with its line number.
//
// This replaces them with one real SVG chevron that *rotates* between states, in
// the same geometry family as the rest of the app's icons (24-box, currentColor,
// round caps — see `components/Icons.tsx`).
//
// Two behaviours here are deliberate, and both match VS Code:
//
//  - **Open markers are revealed on hover, closed markers are always visible.**
//    A permanently-lit chevron on every foldable line is visual noise on a file
//    that is mostly foldable; a *folded* region, on the other hand, is hidden
//    state and must announce itself even when the pointer is elsewhere.
//  - **The gutter reserves its width unconditionally**, so revealing a marker
//    never shifts the code sideways.

import { foldGutter, foldAll, unfoldAll, foldCode, unfoldCode } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * One chevron, pointing right when the region is folded and rotated down when it
 * is open. Built as raw DOM because the gutter marker is outside React's tree.
 */
function chevronMarker(open: boolean): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'cm-fold-marker'
  // The hover rule keys off this, and it doubles as the accessible state.
  wrap.dataset.open = String(open)
  wrap.setAttribute('aria-hidden', 'true')
  wrap.title = open ? 'Fold region' : 'Unfold region'

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')

  const poly = document.createElementNS(SVG_NS, 'polyline')
  poly.setAttribute('points', '9 18 15 12 9 6')
  svg.appendChild(poly)
  wrap.appendChild(svg)
  return wrap
}

const foldTheme = EditorView.theme({
  '.cm-foldGutter': {
    // Reserved up front so revealing a marker on hover doesn't reflow the code.
    minWidth: '16px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 1px',
  },
  '.cm-fold-marker': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-dim)',
    borderRadius: '3px',
    // Rotating one icon (rather than swapping two) makes the state change read
    // as a single motion.
    transition: 'opacity 100ms ease-out, color 100ms ease-out, transform 120ms ease-out',
  },
  '.cm-fold-marker[data-open="true"]': {
    transform: 'rotate(90deg)',
    opacity: '0',
  },
  '.cm-fold-marker[data-open="false"]': {
    // A folded region is hidden state — it stays lit whether or not you hover,
    // and takes the accent so it's findable at a glance.
    transform: 'rotate(0deg)',
    opacity: '1',
    color: 'var(--accent)',
  },
  // Reveal the fold affordances once the pointer is anywhere in the editor.
  '&:hover .cm-fold-marker[data-open="true"], &.cm-focused .cm-fold-marker[data-open="true"]': {
    opacity: '0.65',
  },
  '.cm-fold-marker:hover': {
    color: 'var(--text-primary)',
    background: 'var(--overlay-hover)',
  },
  // The "…" chip standing in for a folded region.
  '.cm-foldPlaceholder': {
    fontFamily: 'var(--font-ui)',
    fontSize: '11px',
  },
})

/** Fold gutter with the app's chevron, plus its supporting styles. */
export const codeFolding: Extension = [
  foldGutter({ markerDOM: chevronMarker }),
  foldTheme,
]

// Re-exported so the status bar's fold controls don't have to import
// `@codemirror/language` just for two commands.
export { foldAll, unfoldAll, foldCode, unfoldCode }
