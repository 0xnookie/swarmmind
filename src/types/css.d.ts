import 'react'

// Electron exposes `-webkit-app-region` to mark draggable regions of a custom
// (frameless) title bar. React's CSSProperties type doesn't include it, so we
// augment the interface to allow it on inline `style` objects.
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}
