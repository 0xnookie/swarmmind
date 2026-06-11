// Appearance: theme presets, accent colours, fonts and interface density.
//
// Everything here is applied at runtime by writing CSS custom properties (and a
// `zoom` factor for density) onto the document root, so a change instantly
// re-cascades through the whole app — no component needs to know the theme.
// The selected values are persisted via the `appsetting:*` IPC channel and
// re-applied at startup (see App.tsx) so the look survives a restart.

export type ThemePreset =
  | 'warm' | 'neutral' | 'midnight' | 'contrast'
  | 'mono' | 'paper' | 'forest' | 'ocean' | 'rose'
export type UiDensity = 'compact' | 'default' | 'comfortable'
export type UiFontId = 'inter' | 'system'
export type MonoFontId = 'sfmono' | 'jetbrains' | 'fira'

export interface AppearanceSettings {
  themePreset: ThemePreset
  // null → use the active theme's own accent; otherwise an explicit hex override.
  accentColor: string | null
  uiDensity: UiDensity
  uiFont: UiFontId
  monoFont: MonoFontId
  // Code-editor font size in px (the terminal has its own fontSize setting).
  editorFontSize: number
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  themePreset: 'mono',
  accentColor: null,
  uiDensity: 'default',
  uiFont: 'inter',
  monoFont: 'sfmono',
  editorFontSize: 13,
}

export const EDITOR_FONT_SIZE_MIN = 9
export const EDITOR_FONT_SIZE_MAX = 28

export function clampEditorFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_APPEARANCE.editorFontSize
  return Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(n)))
}

interface ThemeDef {
  id: ThemePreset
  label: string
  desc: string
  // The core palette. `--accent` here is the theme's default accent, used when
  // the user hasn't picked an explicit accent override.
  vars: Record<string, string>
  // Optional override of the terminal's 16-colour ANSI palette. Dark themes omit
  // this and inherit ANSI_DEFAULT; light themes (e.g. Paper) must supply a darker
  // palette so coloured terminal output stays legible on a pale background.
  term?: Partial<Record<AnsiKey, string>>
  // Optional override of the editor syntax palette (defaults to SYN_DEFAULT).
  syn?: Partial<Record<SynKey, string>>
}

// ── Terminal ANSI palette ────────────────────────────────────────────────────
// xterm needs concrete colours and can't read CSS variables, so we publish the
// 16-colour palette as `--term-*` custom properties (set in applyAppearance) and
// have usePty read them back. This keeps the palette theme-aware in one place.

export type AnsiKey =
  | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow'
  | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'

export const ANSI_DEFAULT: Record<AnsiKey, string> = {
  black: '#1c1a18', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#38bdf8', white: '#c8bfb4',
  brightBlack: '#6b6259', brightRed: '#fca5a5', brightGreen: '#86efac',
  brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9', brightWhite: '#ece7e0',
}

export const TERM_ANSI_KEYS = Object.keys(ANSI_DEFAULT) as AnsiKey[]

// kebab CSS-var name for an ANSI key, e.g. brightBlack → --term-bright-black.
export function termAnsiVar(k: AnsiKey): string {
  return '--term-' + k.replace(/([A-Z])/g, '-$1').toLowerCase()
}

// ── Editor syntax palette ────────────────────────────────────────────────────
// Token colours for the built-in code editor (src/editor/theme.ts reads these
// as `--syn-*` custom properties). Deliberately separate from the terminal's
// ANSI palette: greyscale themes (Mono) keep their muted terminal, but code
// highlighting must stay colourful everywhere. Defaults follow VS Code Dark+;
// light themes override with the Light+ palette so tokens stay legible.

export type SynKey =
  | 'comment' | 'keyword' | 'string' | 'regexp' | 'number' | 'atom'
  | 'function' | 'type' | 'property' | 'tag' | 'invalid'

export const SYN_DEFAULT: Record<SynKey, string> = {
  comment: '#6a9955', keyword: '#c586c0', string: '#ce9178', regexp: '#d16969',
  number: '#b5cea8', atom: '#569cd6', function: '#dcdcaa', type: '#4ec9b0',
  property: '#9cdcfe', tag: '#569cd6', invalid: '#f44747',
}

// VS Code Light+ equivalents, for light backgrounds (Paper).
export const SYN_LIGHT: Record<SynKey, string> = {
  comment: '#008000', keyword: '#af00db', string: '#a31515', regexp: '#811f3f',
  number: '#098658', atom: '#0000ff', function: '#795e26', type: '#267f99',
  property: '#001080', tag: '#800000', invalid: '#cd3131',
}

export const SYN_KEYS = Object.keys(SYN_DEFAULT) as SynKey[]

export const THEMES: Record<ThemePreset, ThemeDef> = {
  warm: {
    id: 'warm',
    label: 'Warm Dark',
    desc: 'Claude palette',
    vars: {
      '--bg-base': '#161412', '--bg-panel': '#1c1a18', '--bg-elevated': '#222019',
      '--bg-elevated-2': '#2a2722', '--bg-terminal': '#121110', '--bg-input': '#1e1c1a',
      '--border-subtle': '#242018', '--border': '#2e2b24', '--border-strong': '#3a362e',
      '--border-active': '#524d43', '--text-primary': '#ece7e0', '--text-secondary': '#a89e94',
      '--text-muted': '#6b6259', '--text-dim': '#3d3830', '--accent': '#d4845a',
    },
  },
  neutral: {
    id: 'neutral',
    label: 'Neutral Dark',
    desc: 'Cool, low-warmth greys',
    vars: {
      '--bg-base': '#141517', '--bg-panel': '#191a1c', '--bg-elevated': '#1f2123',
      '--bg-elevated-2': '#272a2d', '--bg-terminal': '#101113', '--bg-input': '#1b1d1f',
      '--border-subtle': '#202225', '--border': '#2a2d31', '--border-strong': '#383c41',
      '--border-active': '#4d535a', '--text-primary': '#e6e8ea', '--text-secondary': '#969ca3',
      '--text-muted': '#5d636a', '--text-dim': '#353a40', '--accent': '#6ea8fe',
    },
  },
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    desc: 'Deep indigo blue',
    vars: {
      '--bg-base': '#0e1018', '--bg-panel': '#13151f', '--bg-elevated': '#181b28',
      '--bg-elevated-2': '#1f2333', '--bg-terminal': '#0a0c12', '--bg-input': '#151824',
      '--border-subtle': '#1b1f2e', '--border': '#232838', '--border-strong': '#2f3548',
      '--border-active': '#424a63', '--text-primary': '#e4e7f2', '--text-secondary': '#969cb3',
      '--text-muted': '#5c627a', '--text-dim': '#333851', '--accent': '#818cf8',
    },
  },
  contrast: {
    id: 'contrast',
    label: 'High Contrast',
    desc: 'Maximum legibility',
    vars: {
      '--bg-base': '#000000', '--bg-panel': '#0a0a0a', '--bg-elevated': '#141414',
      '--bg-elevated-2': '#1e1e1e', '--bg-terminal': '#000000', '--bg-input': '#121212',
      '--border-subtle': '#2a2a2a', '--border': '#3d3d3d', '--border-strong': '#555555',
      '--border-active': '#777777', '--text-primary': '#ffffff', '--text-secondary': '#cccccc',
      '--text-muted': '#999999', '--text-dim': '#5a5a5a', '--accent': '#ffb454',
    },
  },
  mono: {
    id: 'mono',
    label: 'Monochrome',
    desc: 'Simple black & white',
    vars: {
      '--bg-base': '#000000', '--bg-panel': '#0b0b0b', '--bg-elevated': '#141414',
      '--bg-elevated-2': '#1c1c1c', '--bg-terminal': '#000000', '--bg-input': '#0e0e0e',
      '--border-subtle': '#1e1e1e', '--border': '#2c2c2c', '--border-strong': '#3f3f3f',
      '--border-active': '#5a5a5a', '--text-primary': '#f2f2f2', '--text-secondary': '#a8a8a8',
      '--text-muted': '#6e6e6e', '--text-dim': '#3a3a3a', '--accent': '#f2f2f2',
    },
    // A greyscale terminal palette keeps the monochrome look consistent.
    term: {
      black: '#2a2a2a', red: '#c4c4c4', green: '#e6e6e6', yellow: '#f2f2f2',
      blue: '#a8a8a8', magenta: '#d0d0d0', cyan: '#cccccc', white: '#e0e0e0',
      brightBlack: '#6a6a6a', brightRed: '#d8d8d8', brightGreen: '#f4f4f4',
      brightYellow: '#ffffff', brightBlue: '#c0c0c0', brightMagenta: '#e4e4e4',
      brightCyan: '#e0e0e0', brightWhite: '#ffffff',
    },
  },
  paper: {
    id: 'paper',
    label: 'Paper',
    desc: 'Simple black on white',
    vars: {
      '--bg-base': '#ffffff', '--bg-panel': '#f6f5f3', '--bg-elevated': '#efeeec',
      '--bg-elevated-2': '#e6e4e1', '--bg-terminal': '#ffffff', '--bg-input': '#ffffff',
      '--border-subtle': '#eceae7', '--border': '#dcd9d4', '--border-strong': '#c4c0b9',
      '--border-active': '#9b958c', '--text-primary': '#1a1a1a', '--text-secondary': '#55504a',
      '--text-muted': '#86807a', '--text-dim': '#bdb8b1', '--accent': '#1a1a1a',
    },
    // Light background → a darker ANSI palette so coloured output stays readable.
    term: {
      black: '#2b2b2b', red: '#c0392b', green: '#2e7d32', yellow: '#b8860b',
      blue: '#1565c0', magenta: '#8e24aa', cyan: '#00838f', white: '#3b3b3b',
      brightBlack: '#6b6b6b', brightRed: '#d84a3a', brightGreen: '#388e3c',
      brightYellow: '#c79100', brightBlue: '#1976d2', brightMagenta: '#9c27b0',
      brightCyan: '#0097a7', brightWhite: '#1a1a1a',
    },
    syn: SYN_LIGHT,
  },
  forest: {
    id: 'forest',
    label: 'Forest',
    desc: 'Deep green dark',
    vars: {
      '--bg-base': '#0e1311', '--bg-panel': '#131a17', '--bg-elevated': '#18211d',
      '--bg-elevated-2': '#1f2a25', '--bg-terminal': '#0a0f0d', '--bg-input': '#141b18',
      '--border-subtle': '#1a2420', '--border': '#232f2a', '--border-strong': '#2f3d37',
      '--border-active': '#44574e', '--text-primary': '#e3ece7', '--text-secondary': '#93a59c',
      '--text-muted': '#5a6b63', '--text-dim': '#324039', '--accent': '#6ee7b7',
    },
  },
  ocean: {
    id: 'ocean',
    label: 'Ocean',
    desc: 'Deep teal blue',
    vars: {
      '--bg-base': '#0c1418', '--bg-panel': '#101a20', '--bg-elevated': '#152229',
      '--bg-elevated-2': '#1b2c34', '--bg-terminal': '#081014', '--bg-input': '#121f25',
      '--border-subtle': '#18262d', '--border': '#213139', '--border-strong': '#2c424c',
      '--border-active': '#3f5d6a', '--text-primary': '#e0ecf0', '--text-secondary': '#90a5af',
      '--text-muted': '#586a73', '--text-dim': '#2f424b', '--accent': '#38bdf8',
    },
  },
  rose: {
    id: 'rose',
    label: 'Rosewood',
    desc: 'Warm crimson dark',
    vars: {
      '--bg-base': '#16100f', '--bg-panel': '#1d1513', '--bg-elevated': '#241917',
      '--bg-elevated-2': '#2d201d', '--bg-terminal': '#120c0b', '--bg-input': '#1f1614',
      '--border-subtle': '#261b18', '--border': '#332420', '--border-strong': '#42302b',
      '--border-active': '#5c423b', '--text-primary': '#f0e6e3', '--text-secondary': '#b09a94',
      '--text-muted': '#735f5a', '--text-dim': '#3f302c', '--accent': '#fb7185',
    },
  },
}

export const THEME_LIST: ThemeDef[] = [
  THEMES.warm, THEMES.neutral, THEMES.midnight, THEMES.contrast,
  THEMES.mono, THEMES.paper, THEMES.forest, THEMES.ocean, THEMES.rose,
]

// Accent presets shown as swatches. The user can also enter any hex.
export const ACCENT_PRESETS: { label: string; hex: string }[] = [
  { label: 'Claude Orange', hex: '#d4845a' },
  { label: 'Amber', hex: '#e0a458' },
  { label: 'Teal', hex: '#2dd4bf' },
  { label: 'Blue', hex: '#60a5fa' },
  { label: 'Indigo', hex: '#818cf8' },
  { label: 'Purple', hex: '#c084fc' },
  { label: 'Rose', hex: '#fb7185' },
  { label: 'Green', hex: '#4ade80' },
]

export const UI_FONTS: Record<UiFontId, { label: string; stack: string }> = {
  inter: { label: 'Inter', stack: "'Inter', system-ui, -apple-system, sans-serif" },
  system: { label: 'System', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
}

export const MONO_FONTS: Record<MonoFontId, { label: string; stack: string }> = {
  sfmono: { label: 'SF Mono', stack: "'SF Mono','SFMono-Regular',Menlo,Monaco,'Cascadia Code','JetBrains Mono',ui-monospace,monospace" },
  jetbrains: { label: 'JetBrains Mono', stack: "'JetBrains Mono','Cascadia Code',ui-monospace,monospace" },
  fira: { label: 'Fira Code', stack: "'Fira Code','JetBrains Mono',ui-monospace,monospace" },
}

const DENSITY: Record<UiDensity, { label: string; desc: string; zoom: number }> = {
  compact: { label: 'Compact', desc: 'Tighter, more on screen', zoom: 0.9 },
  default: { label: 'Default', desc: 'Standard spacing', zoom: 1 },
  comfortable: { label: 'Comfortable', desc: 'Roomier, larger UI', zoom: 1.12 },
}

export const DENSITY_LIST = (Object.keys(DENSITY) as UiDensity[]).map(id => ({ id, ...DENSITY[id] }))

// ── Colour helpers ──────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

export function isValidHex(hex: string): boolean {
  return hexToRgb(hex) !== null
}

function rgba(hex: string, alpha: number): string {
  const c = hexToRgb(hex)
  if (!c) return hex
  return `rgba(${c.r},${c.g},${c.b},${alpha})`
}

// Lighten toward white by `amount` (0..1) for the hover accent.
function lighten(hex: string, amount: number): string {
  const c = hexToRgb(hex)
  if (!c) return hex
  const mix = (v: number) => Math.round(v + (255 - v) * amount)
  const toHex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${toHex(mix(c.r))}${toHex(mix(c.g))}${toHex(mix(c.b))}`
}

// Pick a legible foreground (text/icon) colour for content sitting on a solid
// `hex` fill, using perceived sRGB luminance: dark text on light fills, light
// text on dark ones. This keeps accent-filled buttons readable on every theme —
// e.g. the near-white Monochrome accent would render white-on-white otherwise.
export function readableOn(hex: string): string {
  const c = hexToRgb(hex)
  if (!c) return '#ffffff'
  const lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255
  return lum > 0.6 ? '#1a1a1a' : '#ffffff'
}

function applyAccent(root: HTMLElement, hex: string): void {
  const safe = isValidHex(hex) ? hex : THEMES.warm.vars['--accent']
  root.style.setProperty('--accent', safe)
  root.style.setProperty('--accent-hover', lighten(safe, 0.14))
  root.style.setProperty('--accent-subtle', rgba(safe, 0.12))
  root.style.setProperty('--accent-glow', rgba(safe, 0.28))
  root.style.setProperty('--accent-fg', readableOn(safe))
}

// ── Apply ────────────────────────────────────────────────────────────────────

export function applyAppearance(s: AppearanceSettings): void {
  const root = document.documentElement
  const theme = THEMES[s.themePreset] ?? THEMES.warm
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v)
  // Publish the terminal ANSI palette (theme override falls back to the default).
  for (const k of TERM_ANSI_KEYS) root.style.setProperty(termAnsiVar(k), theme.term?.[k] ?? ANSI_DEFAULT[k])
  // Publish the editor syntax palette likewise.
  for (const k of SYN_KEYS) root.style.setProperty('--syn-' + k, theme.syn?.[k] ?? SYN_DEFAULT[k])
  // Accent: explicit override wins over the theme's own accent.
  applyAccent(root, s.accentColor || theme.vars['--accent'])
  // Fonts.
  root.style.setProperty('--font-ui', (UI_FONTS[s.uiFont] ?? UI_FONTS.inter).stack)
  const mono = (MONO_FONTS[s.monoFont] ?? MONO_FONTS.sfmono).stack
  root.style.setProperty('--font-mono', mono)
  root.style.setProperty('--font-editor', mono)
  root.style.setProperty('--editor-font-size', clampEditorFontSize(s.editorFontSize) + 'px')
  // Density via Chromium `zoom` — scales the whole UI without touching the
  // hundreds of hardcoded px values in inline styles. (`zoom` isn't in the TS
  // CSS typings, so set it via setProperty.)
  root.style.setProperty('zoom', String((DENSITY[s.uiDensity] ?? DENSITY.default).zoom))
}

// Resolve the mono font-family string for a given id — used by the terminal,
// which needs a concrete font stack (xterm can't read CSS variables).
export function monoFontStack(id: MonoFontId): string {
  return (MONO_FONTS[id] ?? MONO_FONTS.sfmono).stack
}
