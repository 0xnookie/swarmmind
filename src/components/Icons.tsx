import React from 'react'

// ── Shared icon set ───────────────────────────────────────────────────────────
//
// The app used to spell its arrows with text glyphs (`▾ ▸ ▲ ▼ ‹ › ↑ ↓`). Those
// are *font* characters, not icons: their weight, baseline and metrics come from
// whatever the UI font decides, so they sit off-centre next to a real SVG icon,
// they don't scale with the control, and they can't be animated. Two adjacent
// glyphs from different Unicode blocks (`‹` and `▾`) don't even match each other.
//
// Everything here is one geometry family — 24×24 box, `currentColor` stroke,
// round caps/joins, no fill — which is the same family `FileExplorer`'s
// file/folder icons already draw in, so a chevron next to a folder finally looks
// like it was drawn by the same hand.
//
// Colour comes from `currentColor`, so an icon inherits whatever the surrounding
// button/row is already doing for hover, active and disabled states. Size is the
// only knob most callers need.

export interface IconProps {
  /** Edge length in px (the SVG is square). */
  size?: number
  /** Stroke weight in the 24-unit viewBox. Defaults to a UI-friendly 2. */
  strokeWidth?: number
  className?: string
  style?: React.CSSProperties
  /** Set when the icon is the only content of a control and carries meaning. */
  title?: string
}

function Svg({
  size = 14,
  strokeWidth = 2,
  className,
  style,
  title,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, display: 'block', ...style }}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  )
}

// ── Chevrons ──────────────────────────────────────────────────────────────────
// The disclosure/navigation family. `ChevronRight` is the canonical one: the
// collapsed state everywhere in the app is a right-pointing chevron that
// *rotates* 90° to point down when expanded (see `ChevronDisclosure`), which is
// what every IDE does and what makes expansion read as a single motion rather
// than two unrelated symbols swapping places.

export const ChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="9 18 15 12 9 6" />
  </Svg>
)

export const ChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="15 18 9 12 15 6" />
  </Svg>
)

export const ChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Svg>
)

export const ChevronUp = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="18 15 12 9 6 15" />
  </Svg>
)

// Fold-all / unfold-all.
//
// The obvious drawing is two bare chevrons pointing at (or away from) each
// other — but the status bar renders these at 13px, where a 6-unit gap in a
// 24-unit box is about 3px, and the two strokes antialias into a single blob:
// "fold" came out looking like an X and "unfold" like a diamond. The centre
// line fixes that twice over. It physically separates the chevrons, and it
// gives them something to point *at*, which is the actual metaphor — code
// collapsing onto one line.

/** Fold all: chevrons closing onto the centre line. */
export const FoldVertical = (p: IconProps) => (
  <Svg {...p}>
    <line x1="4" y1="12" x2="20" y2="12" />
    <polyline points="8 3 12 7 16 3" />
    <polyline points="8 21 12 17 16 21" />
  </Svg>
)

/** Unfold all: chevrons opening away from the centre line. */
export const UnfoldVertical = (p: IconProps) => (
  <Svg {...p}>
    <line x1="4" y1="12" x2="20" y2="12" />
    <polyline points="8 7 12 3 16 7" />
    <polyline points="8 17 12 21 16 17" />
  </Svg>
)

// ── Arrows ────────────────────────────────────────────────────────────────────
// Chevrons mean "there is more in this direction"; arrows mean "move / go".
// Keeping the two apart is what stops a sort indicator from looking like a
// collapse control.

export const ArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </Svg>
)

export const ArrowDown = (p: IconProps) => (
  <Svg {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <polyline points="19 12 12 19 5 12" />
  </Svg>
)

// ── Editor controls ───────────────────────────────────────────────────────────

/** Word wrap: a line that turns back on itself. */
export const WrapText = (p: IconProps) => (
  <Svg {...p}>
    <line x1="3" y1="6" x2="21" y2="6" />
    <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
    <polyline points="16 16 14 18 16 20" />
    <line x1="3" y1="18" x2="10" y2="18" />
  </Svg>
)

// ── Disclosure triangle ───────────────────────────────────────────────────────

/**
 * The expand/collapse control used by every tree in the app: one chevron that
 * rotates rather than two glyphs that swap. `invisible` keeps a leaf row's
 * indentation aligned with its siblings without drawing anything — a tree whose
 * files start 14px left of its folders reads as broken.
 */
export function ChevronDisclosure({
  open,
  size = 12,
  invisible,
  style,
  ...rest
}: IconProps & { open: boolean; invisible?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size + 2,
        height: size + 2,
        flexShrink: 0,
        opacity: invisible ? 0 : 1,
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 120ms ease-out',
        ...style,
      }}
    >
      {!invisible && <ChevronRight size={size} {...rest} />}
    </span>
  )
}

/**
 * The `a › b › c` separator used by breadcrumbs. A real chevron rather than the
 * `›` character, which renders at text weight and hangs below the baseline.
 */
export const BreadcrumbSep = ({ size = 11 }: { size?: number }) => (
  <ChevronRight
    size={size}
    strokeWidth={2.4}
    style={{ display: 'inline-block', verticalAlign: 'middle', opacity: 0.5, margin: '0 3px' }}
  />
)
