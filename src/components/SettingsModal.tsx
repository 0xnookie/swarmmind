import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useWorkspaceStore, type AgentId, type ShellStyle } from '../store/workspace'
import {
  THEME_LIST, ACCENT_PRESETS, UI_FONTS, MONO_FONTS, DENSITY_LIST, isValidHex,
  type ThemePreset, type UiDensity, type UiFontId, type MonoFontId,
} from '../appearance'
import { SHORTCUTS, getEffectiveKeys, formatKeys, eventToKeys, findConflict } from '../shortcuts'
import { useT, LANGUAGES, type TFunction, type Language } from '../i18n'

// Agents that expose configurable launch settings (API key, model, …).
const AGENTS: { id: AgentId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'kilo', label: 'Kilo Code' },
  { id: 'opencode', label: 'OpenCode' }
]

// Full roster offered as the "default agent" for new panes.
const ALL_AGENTS: { id: AgentId; label: string }[] = [
  { id: 'claude',   label: 'Claude Code' },
  { id: 'codex',    label: 'Codex' },
  { id: 'cursor',   label: 'Cursor' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'kilo',     label: 'Kilo Code' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'cline',    label: 'Cline' }
]

const SHELL_OPTIONS: { value: ShellStyle; label: string; descKey: 'settings.shell.powershell.desc' | 'settings.shell.cmd.desc' | 'settings.shell.bash.desc' }[] = [
  { value: 'powershell', label: 'PowerShell', descKey: 'settings.shell.powershell.desc' },
  { value: 'cmd', label: 'CMD', descKey: 'settings.shell.cmd.desc' },
  { value: 'bash', label: 'Bash', descKey: 'settings.shell.bash.desc' }
]

// Per-agent placeholder for the API-key field.
const API_KEY_ENV: Partial<Record<AgentId, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY'
}

interface AgentConfig {
  apiKey?: string
  model?: string
  executablePath?: string
  extraFlags?: string[]
}

type Section = 'general' | 'appearance' | 'shortcuts' | 'terminal' | AgentId

// The shell-style wrapper only takes effect on Windows — resolveSpawn() in the
// main process ignores it on macOS/Linux (it runs the command directly / uses
// $SHELL), so the control is a no-op there and we hide it.
const IS_WINDOWS = typeof window !== 'undefined' && window.swarmmind?.platform === 'win32'

export function SettingsModal() {
  const t = useT()
  const language = useWorkspaceStore(s => s.language)
  const setLanguage = useWorkspaceStore(s => s.setLanguage)
  const settingsOpen = useWorkspaceStore(s => s.settingsOpen)
  const settingsAgentId = useWorkspaceStore(s => s.settingsAgentId)
  const closeSettings = useWorkspaceStore(s => s.closeSettings)
  const storeShellStyle = useWorkspaceStore(s => s.shellStyle)
  const setShellStyle = useWorkspaceStore(s => s.setShellStyle)
  const storeDefaultAgentId = useWorkspaceStore(s => s.defaultAgentId)
  const setDefaultAgentId = useWorkspaceStore(s => s.setDefaultAgentId)
  const storeFontSize = useWorkspaceStore(s => s.terminalFontSize)
  const setTerminalFontSize = useWorkspaceStore(s => s.setTerminalFontSize)
  const storeCursorBlink = useWorkspaceStore(s => s.terminalCursorBlink)
  const setTerminalCursorBlink = useWorkspaceStore(s => s.setTerminalCursorBlink)
  const storeCloseToTray = useWorkspaceStore(s => s.closeToTray)
  const setCloseToTray = useWorkspaceStore(s => s.setCloseToTray)

  // Appearance + shortcuts apply instantly (no draft/Save), so we read live
  // store values and call setters directly from the controls.
  const themePreset = useWorkspaceStore(s => s.themePreset)
  const accentColor = useWorkspaceStore(s => s.accentColor)
  const uiDensity = useWorkspaceStore(s => s.uiDensity)
  const uiFont = useWorkspaceStore(s => s.uiFont)
  const monoFont = useWorkspaceStore(s => s.monoFont)
  const setThemePreset = useWorkspaceStore(s => s.setThemePreset)
  const setAccentColor = useWorkspaceStore(s => s.setAccentColor)
  const setUiDensity = useWorkspaceStore(s => s.setUiDensity)
  const setUiFont = useWorkspaceStore(s => s.setUiFont)
  const setMonoFont = useWorkspaceStore(s => s.setMonoFont)
  const keybindings = useWorkspaceStore(s => s.keybindings)
  const setKeybinding = useWorkspaceStore(s => s.setKeybinding)
  const resetKeybinding = useWorkspaceStore(s => s.resetKeybinding)

  // Which shortcut is currently being recorded (capturing the next key combo).
  const [recordingId, setRecordingId] = useState<string | null>(null)
  // Custom-accent hex text field draft (so a partial/invalid value doesn't apply).
  const [accentDraft, setAccentDraft] = useState('')

  const [section, setSection] = useState<Section>(settingsAgentId ?? 'general')

  // General-section draft
  const [shell, setShell] = useState<ShellStyle>(storeShellStyle)
  const [defaultAgent, setDefaultAgent] = useState<AgentId | null>(storeDefaultAgentId)
  const [idleSeconds, setIdleSeconds] = useState(4)
  const [closeTray, setCloseTray] = useState(storeCloseToTray)
  // Terminal-section draft
  const [fontSize, setFontSize] = useState(storeFontSize)
  const [cursorBlink, setCursorBlink] = useState(storeCursorBlink)
  // Agent drafts, lazily loaded and edited in place
  const [agentConfigs, setAgentConfigs] = useState<Record<string, AgentConfig>>({})

  // Per-section dirty tracking so Save can commit everything at once (switching
  // sections no longer discards unsaved edits) and nav items can show a dot.
  const [generalDirty, setGeneralDirty] = useState(false)
  const [terminalDirty, setTerminalDirty] = useState(false)
  const [dirtyAgents, setDirtyAgents] = useState<Set<AgentId>>(new Set())

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const modalRef = useRef<HTMLDivElement>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  const loadedAgentsRef = useRef<Set<AgentId>>(new Set())

  const anyDirty = generalDirty || terminalDirty || dirtyAgents.size > 0

  const markAgentDirty = (id: AgentId) =>
    setDirtyAgents(prev => (prev.has(id) ? prev : new Set(prev).add(id)))

  // (Re)initialise all drafts whenever the modal opens.
  useEffect(() => {
    if (!settingsOpen) return
    setSection(settingsAgentId ?? 'general')
    setGeneralDirty(false)
    setTerminalDirty(false)
    setDirtyAgents(new Set())
    setAgentConfigs({})
    loadedAgentsRef.current = new Set()
    setShell(storeShellStyle)
    setDefaultAgent(storeDefaultAgentId)
    setFontSize(storeFontSize)
    setCursorBlink(storeCursorBlink)
    setCloseTray(storeCloseToTray)
    setRecordingId(null)
    setAccentDraft(useWorkspaceStore.getState().accentColor ?? '')

    window.swarmmind.getAppSetting('shellStyle').then(val => {
      if (val) setShell(val as ShellStyle)
    }).catch(() => {})
    window.swarmmind.getAppSetting('agentIdleMs').then(val => {
      const ms = Number(val)
      if (Number.isFinite(ms) && ms > 0) setIdleSeconds(Math.round(ms / 1000))
    }).catch(() => {})
  }, [settingsOpen])

  // Follow an external request to jump straight to an agent's tab.
  useEffect(() => {
    if (settingsOpen && settingsAgentId) setSection(settingsAgentId)
  }, [settingsAgentId, settingsOpen])

  // Lazily load an agent's persisted config the first time its tab is shown.
  useEffect(() => {
    if (!settingsOpen) return
    if (section === 'general' || section === 'terminal' || section === 'appearance' || section === 'shortcuts') return
    const id = section as AgentId
    if (loadedAgentsRef.current.has(id)) return
    loadedAgentsRef.current.add(id)
    window.swarmmind.getAgentConfig(id).then((cfg: AgentConfig) => {
      setAgentConfigs(prev => ({ ...prev, [id]: cfg ?? {} }))
    }).catch(() => {})
  }, [section, settingsOpen])

  // Focus management: remember what was focused, trap focus inside the dialog,
  // restore on close.
  useEffect(() => {
    if (!settingsOpen) return
    lastFocusedRef.current = document.activeElement as HTMLElement | null
    const t = setTimeout(() => modalRef.current?.focus(), 0)
    return () => {
      clearTimeout(t)
      lastFocusedRef.current?.focus?.()
    }
  }, [settingsOpen])

  // While recording a shortcut, capture the next key combo at the window
  // capture phase so it beats the modal's Escape/Tab handling and the global
  // dispatcher. Escape cancels; modifier-only presses keep waiting.
  useEffect(() => {
    if (!recordingId) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setRecordingId(null); return }
      const keys = eventToKeys(e)
      if (!keys) return
      setKeybinding(recordingId, keys)
      setRecordingId(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recordingId, setKeybinding])

  const handleSave = useCallback(async () => {
    setSaving(true)
    if (generalDirty) {
      await window.swarmmind.setAppSetting('shellStyle', shell)
      setShellStyle(shell)
      setDefaultAgentId(defaultAgent)
      const clamped = Math.min(60, Math.max(1, Math.round(idleSeconds) || 4))
      await window.swarmmind.setAppSetting('agentIdleMs', String(clamped * 1000))
      setCloseToTray(closeTray)
    }
    if (terminalDirty) {
      setTerminalFontSize(fontSize)
      setTerminalCursorBlink(cursorBlink)
    }
    for (const id of dirtyAgents) {
      await window.swarmmind.setAgentConfig(id, agentConfigs[id] ?? {})
    }
    setGeneralDirty(false)
    setTerminalDirty(false)
    setDirtyAgents(new Set())
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [generalDirty, terminalDirty, dirtyAgents, agentConfigs, shell, defaultAgent, idleSeconds, closeTray,
      fontSize, cursorBlink, setShellStyle, setDefaultAgentId, setTerminalFontSize, setTerminalCursorBlink, setCloseToTray])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeSettings()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (anyDirty) handleSave()
      return
    }
    if (e.key !== 'Tab' || !modalRef.current) return
    const focusable = Array.from(
      modalRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }, [anyDirty, handleSave, closeSettings])

  if (!settingsOpen) return null

  const editAgent = (id: AgentId, patch: Partial<AgentConfig>) => {
    setAgentConfigs(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }))
    markAgentDirty(id)
  }

  const navItem = (id: Section, label: string, icon: React.ReactNode, dirty: boolean) => (
    <button
      key={id}
      role="tab"
      aria-selected={section === id}
      className="settings-nav-item"
      onClick={() => setSection(id)}
    >
      <span className="nav-icon" aria-hidden="true">{icon}</span>
      {label}
      {dirty && <span className="settings-dirty-dot" aria-label={t('settings.nav.unsaved')} />}
    </button>
  )

  return (
    <div style={styles.overlay} onClick={e => e.target === e.currentTarget && closeSettings()}>
      <div
        ref={modalRef}
        style={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div style={styles.header}>
          <h2 id="settings-title" style={styles.title}>{t('settings.title')}</h2>
          <button style={styles.closeBtn} onClick={closeSettings} aria-label={t('settings.close')}>✕</button>
        </div>

        <div style={styles.body}>
          {/* Sidebar navigation */}
          <nav style={styles.nav} role="tablist" aria-orientation="vertical" aria-label="Settings sections">
            {navItem('general', t('settings.nav.general'), <GearIcon />, generalDirty)}
            {navItem('appearance', t('settings.nav.appearance'), <PaletteIcon />, false)}
            {navItem('shortcuts', t('settings.nav.shortcuts'), <KeyIcon />, false)}
            {navItem('terminal', t('settings.nav.terminal'), <TerminalIcon />, terminalDirty)}
            <div style={styles.navLabel}>{t('settings.nav.agents')}</div>
            {AGENTS.map(a => navItem(a.id, a.label, <AgentDot />, dirtyAgents.has(a.id)))}
          </nav>

          {/* Content panel */}
          <div style={styles.content} role="tabpanel">
            {section === 'general' && (
              <div style={styles.fields}>
                <Group title={t('settings.language.group')}>
                  <FieldLabel htmlFor="ui-language">{t('settings.language.label')}</FieldLabel>
                  <select
                    id="ui-language"
                    style={styles.select}
                    value={language}
                    onChange={e => setLanguage(e.target.value as Language)}
                  >
                    {LANGUAGES.map(l => (
                      <option key={l.id} value={l.id}>{l.native}</option>
                    ))}
                  </select>
                  <p style={styles.desc}>{t('settings.language.desc')}</p>
                </Group>

                {IS_WINDOWS && (
                  <Group title={t('settings.shell.group')}>
                    <FieldLabel>{t('settings.shell.label')}</FieldLabel>
                    <p style={styles.desc}>{t('settings.shell.desc')}</p>
                    <div style={styles.cardGrid}>
                      {SHELL_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          className="settings-card"
                          aria-pressed={shell === opt.value}
                          onClick={() => { setShell(opt.value); setGeneralDirty(true) }}
                        >
                          <span style={styles.cardTitle}>{opt.label}</span>
                          <span style={styles.cardDesc}>{t(opt.descKey)}</span>
                        </button>
                      ))}
                    </div>
                  </Group>
                )}

                <Group title={t('settings.panes.group')}>
                  <FieldLabel htmlFor="default-agent">{t('settings.panes.defaultAgent')}</FieldLabel>
                  <select
                    id="default-agent"
                    style={styles.select}
                    value={defaultAgent ?? ''}
                    onChange={e => { setDefaultAgent((e.target.value as AgentId) || null); setGeneralDirty(true) }}
                  >
                    <option value="">{t('common.none')}</option>
                    {ALL_AGENTS.map(a => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </select>
                  <p style={styles.desc}>{t('settings.panes.defaultAgentDesc')}</p>
                </Group>

                <Group title={t('settings.window.group')}>
                  <div style={styles.rowBetween}>
                    <div>
                      <FieldLabel>{t('settings.window.closeToTray')}</FieldLabel>
                      <p style={{ ...styles.desc, marginTop: 2 }}>
                        {t('settings.window.closeToTrayDesc')}
                      </p>
                    </div>
                    <button
                      className="settings-toggle"
                      role="switch"
                      aria-checked={closeTray}
                      aria-label={t('settings.window.closeToTray')}
                      onClick={() => { setCloseTray(v => !v); setGeneralDirty(true) }}
                    />
                  </div>
                </Group>

                <Group title={t('settings.notifications.group')}>
                  <div style={styles.rowBetween}>
                    <FieldLabel htmlFor="idle-threshold">{t('settings.notifications.idleThreshold')}</FieldLabel>
                    <span style={styles.value}>{idleSeconds}s</span>
                  </div>
                  <input
                    id="idle-threshold"
                    type="range"
                    min={1}
                    max={30}
                    step={1}
                    value={Math.min(30, idleSeconds)}
                    onChange={e => { setIdleSeconds(Number(e.target.value)); setGeneralDirty(true) }}
                    style={styles.range}
                  />
                  <p style={styles.desc}>{t('settings.notifications.idleDesc')}</p>
                </Group>

                <Group title={t('settings.voice.group')}>
                  <p style={styles.desc}>
                    {t('settings.voice.desc')} <kbd style={styles.kbd}>Ctrl</kbd>+
                    <kbd style={styles.kbd}>Shift</kbd>+<kbd style={styles.kbd}>V</kbd>.
                  </p>
                </Group>

                <UpdatesSection t={t} />
              </div>
            )}

            {section === 'terminal' && (
              <div style={styles.fields}>
                <Group title={t('settings.terminal.display')}>
                  <div style={styles.rowBetween}>
                    <FieldLabel htmlFor="font-size">{t('settings.terminal.fontSize')}</FieldLabel>
                    <span style={styles.value}>{fontSize}px</span>
                  </div>
                  <input
                    id="font-size"
                    type="range"
                    min={9}
                    max={24}
                    step={1}
                    value={fontSize}
                    onChange={e => { setFontSize(Number(e.target.value)); setTerminalDirty(true) }}
                    style={styles.range}
                  />
                  <p style={styles.desc}>{t('settings.terminal.fontSizeDesc')}</p>

                  <div style={{ ...styles.rowBetween, marginTop: 14 }}>
                    <div>
                      <FieldLabel>{t('settings.terminal.cursorBlink')}</FieldLabel>
                      <p style={{ ...styles.desc, marginTop: 2 }}>{t('settings.terminal.cursorBlinkDesc')}</p>
                    </div>
                    <button
                      className="settings-toggle"
                      role="switch"
                      aria-checked={cursorBlink}
                      aria-label={t('settings.terminal.cursorBlink')}
                      onClick={() => { setCursorBlink(v => !v); setTerminalDirty(true) }}
                    />
                  </div>
                </Group>
              </div>
            )}

            {section === 'appearance' && (
              <div style={styles.fields}>
                <Group title={t('settings.appearance.theme')}>
                  <div style={styles.cardGrid}>
                    {THEME_LIST.map(t => (
                      <button
                        key={t.id}
                        className="settings-card"
                        aria-pressed={themePreset === t.id}
                        onClick={() => setThemePreset(t.id as ThemePreset)}
                      >
                        <span style={styles.swatchRow}>
                          {['--bg-base', '--bg-elevated', '--border-active', '--accent'].map(v => (
                            <span key={v} style={{ ...styles.miniSwatch, background: t.vars[v] }} />
                          ))}
                        </span>
                        <span style={styles.cardTitle}>{t.label}</span>
                        <span style={styles.cardDesc}>{t.desc}</span>
                      </button>
                    ))}
                  </div>
                </Group>

                <Group title={t('settings.appearance.accent')}>
                  <div style={styles.accentRow}>
                    {ACCENT_PRESETS.map(a => (
                      <button
                        key={a.hex}
                        className="accent-swatch"
                        aria-pressed={(accentColor ?? '').toLowerCase() === a.hex.toLowerCase()}
                        title={a.label}
                        style={{ background: a.hex }}
                        onClick={() => { setAccentColor(a.hex); setAccentDraft(a.hex) }}
                      />
                    ))}
                    <button
                      className="accent-swatch"
                      aria-pressed={accentColor === null}
                      title={t('settings.appearance.accentAutoTitle')}
                      style={styles.accentAuto}
                      onClick={() => { setAccentColor(null); setAccentDraft('') }}
                    >
                      {t('settings.appearance.accentAuto')}
                    </button>
                  </div>
                  <div style={styles.rowInline}>
                    <input
                      style={{ ...styles.input, flex: 1 }}
                      type="text"
                      placeholder="#d4845a"
                      value={accentDraft}
                      onChange={e => setAccentDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && isValidHex(accentDraft)) setAccentColor(accentDraft) }}
                    />
                    <button
                      className="settings-card"
                      style={styles.inlineBtn}
                      disabled={!isValidHex(accentDraft)}
                      onClick={() => setAccentColor(accentDraft)}
                    >
                      {t('common.apply')}
                    </button>
                  </div>
                  <p style={styles.desc}>{t('settings.appearance.accentDesc')}</p>
                </Group>

                <Group title={t('settings.appearance.density')}>
                  <div style={styles.cardGrid}>
                    {DENSITY_LIST.map(d => (
                      <button
                        key={d.id}
                        className="settings-card"
                        aria-pressed={uiDensity === d.id}
                        onClick={() => setUiDensity(d.id as UiDensity)}
                      >
                        <span style={styles.cardTitle}>{d.label}</span>
                        <span style={styles.cardDesc}>{d.desc}</span>
                      </button>
                    ))}
                  </div>
                </Group>

                <Group title={t('settings.appearance.fonts')}>
                  <FieldLabel htmlFor="ui-font">{t('settings.appearance.uiFont')}</FieldLabel>
                  <select
                    id="ui-font"
                    style={styles.select}
                    value={uiFont}
                    onChange={e => setUiFont(e.target.value as UiFontId)}
                  >
                    {Object.entries(UI_FONTS).map(([id, f]) => (
                      <option key={id} value={id}>{f.label}</option>
                    ))}
                  </select>

                  <FieldLabel htmlFor="mono-font">{t('settings.appearance.monoFont')}</FieldLabel>
                  <select
                    id="mono-font"
                    style={{ ...styles.select, fontFamily: MONO_FONTS[monoFont].stack }}
                    value={monoFont}
                    onChange={e => setMonoFont(e.target.value as MonoFontId)}
                  >
                    {Object.entries(MONO_FONTS).map(([id, f]) => (
                      <option key={id} value={id}>{f.label}</option>
                    ))}
                  </select>
                  <p style={styles.desc}>{t('settings.appearance.fontsDesc')}</p>
                </Group>
              </div>
            )}

            {section === 'shortcuts' && (
              <div style={styles.fields}>
                {(['Global', 'Panes'] as const).map(cat => {
                  const defs = SHORTCUTS.filter(s => s.category === cat)
                  if (defs.length === 0) return null
                  return (
                    <Group key={cat} title={cat}>
                      {defs.map(def => {
                        const keys = getEffectiveKeys(def.id, keybindings)
                        const overridden = keybindings[def.id] !== undefined
                        const recording = recordingId === def.id
                        const conflict = findConflict(keys, def.id, keybindings)
                        return (
                          <div key={def.id} style={styles.shortcutRow}>
                            <div style={{ minWidth: 0 }}>
                              <span style={styles.shortcutLabel}>{def.label}</span>
                              {conflict && (
                                <span style={styles.conflict}>{t('settings.shortcuts.conflict', { label: conflict.label })}</span>
                              )}
                            </div>
                            <div style={styles.rowInline}>
                              <button
                                className="settings-keycap"
                                data-recording={recording}
                                onClick={() => setRecordingId(recording ? null : def.id)}
                              >
                                {recording ? t('settings.shortcuts.pressKeys') : (formatKeys(keys) || t('settings.shortcuts.unset'))}
                              </button>
                              {overridden && (
                                <button
                                  className="pane-action-btn"
                                  title={t('settings.shortcuts.resetTitle')}
                                  aria-label={t('settings.shortcuts.resetAria', { label: def.label })}
                                  onClick={() => resetKeybinding(def.id)}
                                >
                                  ↺
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </Group>
                  )
                })}
                <p style={styles.desc}>{t('settings.shortcuts.desc')}</p>
              </div>
            )}

            {section !== 'general' && section !== 'terminal' && section !== 'appearance' && section !== 'shortcuts' && (() => {
              const id = section as AgentId
              const cfg = agentConfigs[id] ?? {}
              return (
                <div style={styles.fields}>
                  <Group title={t('settings.agent.configuration', { agent: AGENTS.find(a => a.id === id)?.label ?? id })}>
                    <FieldLabel htmlFor={`${id}-key`}>{t('settings.agent.apiKey')}</FieldLabel>
                    <input
                      id={`${id}-key`}
                      style={styles.input}
                      type="password"
                      placeholder={API_KEY_ENV[id] ?? `${id.toUpperCase()}_API_KEY`}
                      value={cfg.apiKey ?? ''}
                      onChange={e => editAgent(id, { apiKey: e.target.value })}
                    />

                    <FieldLabel htmlFor={`${id}-model`}>{t('settings.agent.model')} <span style={styles.optional}>{t('common.optional')}</span></FieldLabel>
                    <input
                      id={`${id}-model`}
                      style={styles.input}
                      type="text"
                      placeholder={t('settings.agent.modelPlaceholder')}
                      value={cfg.model ?? ''}
                      onChange={e => editAgent(id, { model: e.target.value })}
                    />

                    <FieldLabel htmlFor={`${id}-path`}>{t('settings.agent.execPath')} <span style={styles.optional}>{t('common.optional')}</span></FieldLabel>
                    <input
                      id={`${id}-path`}
                      style={styles.input}
                      type="text"
                      placeholder={t('settings.agent.execPathPlaceholder', { agent: id })}
                      value={cfg.executablePath ?? ''}
                      onChange={e => editAgent(id, { executablePath: e.target.value })}
                    />

                    <FieldLabel htmlFor={`${id}-flags`}>{t('settings.agent.extraFlags')} <span style={styles.optional}>{t('settings.agent.extraFlagsHint')}</span></FieldLabel>
                    <input
                      id={`${id}-flags`}
                      style={styles.input}
                      type="text"
                      placeholder={t('settings.agent.extraFlagsPlaceholder')}
                      value={(cfg.extraFlags ?? []).join(' ')}
                      onChange={e => editAgent(id, { extraFlags: e.target.value.split(' ').filter(Boolean) })}
                    />
                  </Group>
                  <p style={styles.desc}>
                    {t('settings.agent.storageNote')} <code style={styles.code}>http://127.0.0.1:[auto-assigned]</code>.
                  </p>
                </div>
              )
            })()}
          </div>
        </div>

        <div style={styles.footer}>
          <span style={styles.footerHint}>{anyDirty ? t('common.unsavedChanges') : ''}</span>
          <button style={styles.cancelBtn} onClick={closeSettings}>{t('common.cancel')}</button>
          <button style={styles.saveBtn} onClick={handleSave} disabled={saving || !anyDirty}>
            {saved ? t('common.saved') : saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Updates ──────────────────────────────────────────── */

// Self-contained: it subscribes to `update:status` and triggers manual checks
// directly, outside the modal's draft/Save model (an update isn't a "setting").
// Surfaces every state — checking / up-to-date / available / downloading /
// ready / error — that the silent UpdateBanner deliberately hides.
function UpdatesSection({ t }: { t: TFunction }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [version, setVersion] = useState('')
  const [unsupported, setUnsupported] = useState(false)

  useEffect(() => window.swarmmind.onUpdateStatus(setStatus), [])
  useEffect(() => { window.swarmmind.getAppVersion().then(setVersion).catch(() => {}) }, [])

  const check = useCallback(async () => {
    setStatus({ state: 'checking' })
    try {
      const { supported } = await window.swarmmind.updateCheck()
      if (!supported) { setUnsupported(true); setStatus(null) }
      // When supported, the main process drives further status via update:status.
    } catch (err) {
      setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const busy = status?.state === 'checking' || status?.state === 'downloading'

  const line = (() => {
    if (unsupported) return t('settings.updates.unsupported')
    switch (status?.state) {
      case 'checking': return t('settings.updates.checkingLine')
      case 'none': return t('settings.updates.latest')
      case 'available': return t('settings.updates.found', { version: status.version })
      case 'downloading': return t('settings.updates.downloading', { percent: status.percent })
      case 'ready': return t('settings.updates.ready', { version: status.version })
      case 'error': return t('settings.updates.failed', { message: status.message })
      default: return t('settings.updates.idle')
    }
  })()

  return (
    <Group title={t('settings.updates.group')}>
      <div style={styles.rowBetween}>
        <div style={{ minWidth: 0 }}>
          <FieldLabel>{t('settings.updates.currentVersion')}</FieldLabel>
          <p style={{ ...styles.desc, marginTop: 2 }}>
            SwarmMind{version ? ` v${version}` : ''}
          </p>
        </div>
        {status?.state === 'ready' ? (
          <button
            className="settings-card"
            style={styles.inlineBtn}
            onClick={() => window.swarmmind.updateInstall()}
          >
            {t('settings.updates.restartToInstall')}
          </button>
        ) : (
          <button
            className="settings-card"
            style={styles.inlineBtn}
            disabled={busy}
            onClick={check}
          >
            {status?.state === 'checking' ? t('settings.updates.checking') : t('settings.updates.check')}
          </button>
        )}
      </div>
      <p
        style={{
          ...styles.desc,
          color: status?.state === 'error' ? 'var(--warning)' : styles.desc.color,
        }}
        role="status"
      >
        {line}
      </p>
    </Group>
  )
}

/* ── Small presentational helpers ─────────────────────── */

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={styles.group}>
      <h3 style={styles.groupTitle}>{title}</h3>
      {children}
    </section>
  )
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return <label htmlFor={htmlFor} style={styles.label}>{children}</label>
}

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

function PaletteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  )
}

function KeyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <line x1="6" y1="10" x2="6" y2="10" />
      <line x1="10" y1="10" x2="10" y2="10" />
      <line x1="14" y1="10" x2="14" y2="10" />
      <line x1="18" y1="10" x2="18" y2="10" />
      <line x1="7" y1="14" x2="17" y2="14" />
    </svg>
  )
}

function AgentDot() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="12" r="1" fill="currentColor" />
      <circle cx="15" cy="12" r="1" fill="currentColor" />
    </svg>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000
  },
  modal: {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    width: 720,
    maxWidth: '92vw',
    height: 560,
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: 'var(--shadow-lg)',
    outline: 'none'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 18px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0
  },
  title: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-dim)',
    cursor: 'pointer',
    fontSize: 14,
    padding: 4,
    lineHeight: 1
  },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  nav: {
    width: 184,
    flexShrink: 0,
    borderRight: '1px solid var(--border)',
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    overflowY: 'auto'
  },
  navLabel: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
    padding: '12px 10px 4px'
  },
  content: { flex: 1, minWidth: 0, overflowY: 'auto', padding: '18px 22px' },
  fields: { display: 'flex', flexDirection: 'column', gap: 20 },
  group: { display: 'flex', flexDirection: 'column', gap: 8 },
  groupTitle: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
    marginBottom: 2
  },
  label: { fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' },
  optional: { fontWeight: 400, color: 'var(--text-dim)' },
  desc: { fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.55 },
  input: {
    background: 'var(--bg-base)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '7px 10px',
    fontSize: 12,
    outline: 'none',
    fontFamily: 'var(--font-mono)',
    width: '100%'
  },
  select: {
    background: 'var(--bg-base)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '7px 10px',
    fontSize: 12,
    outline: 'none',
    cursor: 'pointer',
    width: '100%'
  },
  cardGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  cardTitle: { fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' },
  cardDesc: { fontSize: 10.5, color: 'var(--text-dim)' },
  swatchRow: { display: 'flex', gap: 3, marginBottom: 6 },
  miniSwatch: { width: 16, height: 16, borderRadius: 4, border: '1px solid var(--border-strong)' },
  accentRow: { display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 4 },
  accentAuto: {
    background: 'var(--bg-base)',
    color: 'var(--text-secondary)',
    fontSize: 9.5,
    fontWeight: 600,
    width: 'auto',
    padding: '0 8px',
  },
  rowInline: { display: 'flex', alignItems: 'center', gap: 8 },
  inlineBtn: { width: 'auto', padding: '7px 14px', alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  shortcutRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '7px 0',
    borderBottom: '1px solid var(--border-subtle)',
  },
  shortcutLabel: { fontSize: 12, color: 'var(--text-primary)' },
  conflict: { display: 'block', fontSize: 10, color: 'var(--warning)', marginTop: 2 },
  rowBetween: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  value: { fontSize: 12, fontWeight: 500, color: 'var(--accent)', fontFamily: 'var(--font-mono)' },
  range: { width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' },
  code: { fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontSize: 11 },
  kbd: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--text-secondary)',
    background: 'var(--bg-base)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: '1px 4px',
    margin: '0 1px'
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    padding: '12px 18px',
    borderTop: '1px solid var(--border)',
    flexShrink: 0
  },
  footerHint: { marginRight: 'auto', fontSize: 11, color: 'var(--text-muted)' },
  cancelBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-muted)',
    padding: '6px 16px',
    cursor: 'pointer',
    fontSize: 12,
    transition: 'border-color 120ms, color 120ms'
  },
  saveBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--accent-fg)',
    padding: '6px 18px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    transition: 'opacity 120ms'
  }
}
