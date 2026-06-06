// Central keyboard-shortcut registry.
//
// Every rebindable action lives here with a normalized default binding. A combo
// is stored as a canonical string built in a fixed modifier order, e.g.
// "Mod+Shift+V" or "Mod+,". "Mod" means Ctrl on Windows/Linux and Cmd on macOS,
// so a single binding works cross-platform.
//
// Overrides are persisted (as a JSON map of actionId → combo) in the Zustand
// store under `keybindings`; `getEffectiveKeys()` merges them over the defaults.
// The global actions are dispatched centrally in App.tsx; component-scoped ones
// (voice, pane search) are matched where they live via `matchEvent()`.

import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

// Accept both DOM and React synthetic keyboard events — they share the fields
// we read (key + modifier flags).
type AnyKeyEvent = KeyboardEvent | ReactKeyboardEvent

export type ShortcutCategory = 'Global' | 'Panes'

export interface ShortcutDef {
  id: string
  label: string
  category: ShortcutCategory
  defaultKeys: string
  // true → handled by the central dispatcher in App.tsx; false → matched inside
  // the owning component (it has local state the action needs).
  global: boolean
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'command-palette', label: 'Open command palette', category: 'Global', defaultKeys: 'Mod+K', global: true },
  { id: 'broadcast',       label: 'Toggle broadcast bar',  category: 'Global', defaultKeys: 'Mod+B', global: true },
  { id: 'settings',        label: 'Open settings',         category: 'Global', defaultKeys: 'Mod+,', global: true },
  { id: 'new-pane',        label: 'New terminal pane',     category: 'Global', defaultKeys: 'Mod+T', global: true },
  { id: 'voice',           label: 'Toggle SwarmVoice',     category: 'Global', defaultKeys: 'Mod+Shift+V', global: false },
  { id: 'pane-search',     label: 'Search in pane',        category: 'Panes',  defaultKeys: 'Mod+F', global: false },
]

const SHORTCUT_BY_ID: Record<string, ShortcutDef> = Object.fromEntries(SHORTCUTS.map(s => [s.id, s]))

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

// Keys we never treat as the "main" key — they're modifiers on their own.
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph'])

// Build the canonical combo string for a keyboard event, or null if only
// modifiers are held (so the capture UI keeps waiting for a real key).
export function eventToKeys(e: AnyKeyEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  parts.push(key)
  return parts.join('+')
}

// Does this event match the given canonical combo? Case-insensitive on the main
// key so Shift-letter combos still match (Shift makes e.key uppercase already,
// but layouts vary).
export function matchEvent(e: AnyKeyEvent, keys: string): boolean {
  const combo = eventToKeys(e)
  return combo != null && combo.toLowerCase() === keys.toLowerCase()
}

export function getEffectiveKeys(id: string, overrides: Record<string, string>): string {
  return overrides[id] ?? SHORTCUT_BY_ID[id]?.defaultKeys ?? ''
}

// Pretty-print a combo for display: Mod → ⌘ (mac) or Ctrl, etc.
export function formatKeys(keys: string): string {
  if (!keys) return ''
  return keys
    .split('+')
    .map(part => {
      if (part === 'Mod') return IS_MAC ? '⌘' : 'Ctrl'
      if (part === 'Alt') return IS_MAC ? '⌥' : 'Alt'
      if (part === 'Shift') return IS_MAC ? '⇧' : 'Shift'
      if (part === ',') return ','
      return part
    })
    .join(IS_MAC ? '' : '+')
}

// Find another action that already uses this combo (excluding `selfId`), for
// conflict warnings in the settings UI.
export function findConflict(keys: string, selfId: string, overrides: Record<string, string>): ShortcutDef | null {
  for (const def of SHORTCUTS) {
    if (def.id === selfId) continue
    if (getEffectiveKeys(def.id, overrides) === keys) return def
  }
  return null
}
