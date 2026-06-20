import { useEffect } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { THEMES, UI_FONTS, MONO_FONTS, type ThemePreset, type UiDensity, type UiFontId, type MonoFontId } from '../appearance'

// Load the user's persisted appearance (theme/accent/density/fonts) + language
// and apply them to THIS window's document. The full app does this inline in
// App.tsx; the SwarmAgent widget is a separate window/renderer with its own
// document, so it must replay the same hydration to match what the user picked.
export function useAppearanceSync(): void {
  useEffect(() => {
    window.swarmmind.getAppSetting('language').then(val => {
      if (val === 'en' || val === 'de') useWorkspaceStore.setState({ language: val })
    }).catch(() => {})

    Promise.all([
      window.swarmmind.getAppSetting('themePreset'),
      window.swarmmind.getAppSetting('accentColor'),
      window.swarmmind.getAppSetting('uiDensity'),
      window.swarmmind.getAppSetting('uiFont'),
      window.swarmmind.getAppSetting('monoFont'),
      window.swarmmind.getAppSetting('editorFontSize'),
    ]).then(([theme, accent, density, uiFont, monoFont, editorFontSize]) => {
      const edSize = editorFontSize ? Number(editorFontSize) : NaN
      useWorkspaceStore.getState().hydrateAppearance({
        themePreset: theme && theme in THEMES ? (theme as ThemePreset) : undefined,
        accentColor: accent ? accent : (accent === '' ? null : undefined),
        uiDensity: density === 'compact' || density === 'default' || density === 'comfortable'
          ? (density as UiDensity) : undefined,
        uiFont: uiFont && uiFont in UI_FONTS ? (uiFont as UiFontId) : undefined,
        monoFont: monoFont && monoFont in MONO_FONTS ? (monoFont as MonoFontId) : undefined,
        editorFontSize: Number.isFinite(edSize) ? edSize : undefined,
      })
    }).catch(() => {
      useWorkspaceStore.getState().hydrateAppearance({})
    })
  }, [])
}
