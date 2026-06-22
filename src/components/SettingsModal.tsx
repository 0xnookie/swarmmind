import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useWorkspaceStore, type AgentId, type ShellStyle } from '../store/workspace'
import {
  THEME_LIST, ACCENT_PRESETS, UI_FONTS, MONO_FONTS, DENSITY_LIST, isValidHex,
  EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX,
  type ThemePreset, type UiDensity, type UiFontId, type MonoFontId,
} from '../appearance'
import { SHORTCUTS, getEffectiveKeys, formatKeys, eventToKeys, findConflict } from '../shortcuts'
import { useT, LANGUAGES, type TFunction, type Language } from '../i18n'
import { type VoiceModel } from '../hooks/useVoice'
import { AgentIcon } from '../data/agents'
import { LoginTerminal } from './LoginTerminal'

// Agents whose CLIs support one-click connect (an isolated profile dir + the
// CLI's own browser-OAuth login flow). Mirrors PROFILE_LOGIN in
// electron/agent-accounts.ts. Other agents fall back to manual API-key entry.
const PROFILE_AGENTS = new Set<AgentId>(['claude', 'codex', 'opencode'])

// Curated SwarmAgent (Groq) model recommendations — quick-pick buttons next to
// the model field. The live list fetched from the key augments these in the
// datalist; verify the catalogue per release (Groq's lineup changes often).
const SWARMAGENT_RECOMMENDED: { id: string; label: string }[] = [
  { id: 'openai/gpt-oss-120b', label: 'Most capable' },
  { id: 'llama-3.3-70b-versatile', label: 'Balanced' },
  { id: 'openai/gpt-oss-20b', label: 'Fastest' },
]

// Whisper model choices for SwarmVoice (Settings → General).
const VOICE_MODEL_OPTIONS: { value: VoiceModel; labelKey: 'settings.voice.model.tiny' | 'settings.voice.model.base' | 'settings.voice.model.small' }[] = [
  { value: 'tiny',  labelKey: 'settings.voice.model.tiny' },
  { value: 'base',  labelKey: 'settings.voice.model.base' },
  { value: 'small', labelKey: 'settings.voice.model.small' },
]

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

// Accounts keep it simple on purpose: a name plus either a CLI login (profileDir)
// or an API key. model/env still exist in the stored shape (older saves carry
// them and the spawn path honours them) but are no longer editable here.
interface AgentAccount {
  id: string
  label: string
  profileDir?: string
  apiKey?: string
  model?: string
  env?: Record<string, string>
}

interface AgentAccountsState {
  accounts: AgentAccount[]
  activeId?: string
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
  const storeVoiceModel = useWorkspaceStore(s => s.voiceModel)
  const setVoiceModelStore = useWorkspaceStore(s => s.setVoiceModel)
  const storeVoicePreload = useWorkspaceStore(s => s.voicePreload)
  const setVoicePreloadStore = useWorkspaceStore(s => s.setVoicePreload)

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
  const editorFontSize = useWorkspaceStore(s => s.editorFontSize)
  const setEditorFontSize = useWorkspaceStore(s => s.setEditorFontSize)
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
  const [voiceModelDraft, setVoiceModelDraft] = useState<VoiceModel>(storeVoiceModel)
  const [voicePreloadDraft, setVoicePreloadDraft] = useState(storeVoicePreload)
  // SwarmAgent (Groq) — key is write-only (never read back); model is plain.
  const [swarmAgentKeyDraft, setSwarmAgentKeyDraft] = useState('')
  const [swarmAgentHasKey, setSwarmAgentHasKey] = useState(false)
  const [swarmAgentModelDraft, setSwarmAgentModelDraft] = useState('')
  // Models fetched live from Groq (empty until the key is set / fetch returns).
  const [swarmAgentModels, setSwarmAgentModels] = useState<string[]>([])
  // Terminal-section draft
  const [fontSize, setFontSize] = useState(storeFontSize)
  const [cursorBlink, setCursorBlink] = useState(storeCursorBlink)
  // Agent drafts, lazily loaded and edited in place
  const [agentConfigs, setAgentConfigs] = useState<Record<string, AgentConfig>>({})
  // Global per-agent accounts (apiKey/model/env), lazily loaded with the config.
  const [agentAccounts, setAgentAccounts] = useState<Record<string, AgentAccountsState>>({})
  // The open "connect account" login terminal, if any.
  const [loginSession, setLoginSession] = useState<{ agentId: AgentId; agentLabel: string; accountId: string; profileDir: string } | null>(null)

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
    setAgentAccounts({})
    loadedAgentsRef.current = new Set()
    setShell(storeShellStyle)
    setDefaultAgent(storeDefaultAgentId)
    setFontSize(storeFontSize)
    setCursorBlink(storeCursorBlink)
    setCloseTray(storeCloseToTray)
    setVoiceModelDraft(storeVoiceModel)
    setVoicePreloadDraft(storeVoicePreload)
    setSwarmAgentKeyDraft('')
    window.swarmmind.swarmAgentHasKey().then(setSwarmAgentHasKey).catch(() => {})
    window.swarmmind.getAppSetting('swarmAgentModel').then(val => setSwarmAgentModelDraft(val ?? '')).catch(() => {})
    window.swarmmind.swarmAgentListModels().then(m => { if (Array.isArray(m)) setSwarmAgentModels(m) }).catch(() => {})
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
    window.swarmmind.listAgentAccounts(id).then((res) => {
      setAgentAccounts(prev => ({ ...prev, [id]: { accounts: res?.accounts ?? [], activeId: res?.activeId } }))
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
      setVoiceModelStore(voiceModelDraft)
      setVoicePreloadStore(voicePreloadDraft)
      if (swarmAgentKeyDraft.trim()) {
        await window.swarmmind.swarmAgentSetKey(swarmAgentKeyDraft.trim())
        setSwarmAgentHasKey(true)
        setSwarmAgentKeyDraft('')
      }
      await window.swarmmind.setAppSetting('swarmAgentModel', swarmAgentModelDraft.trim())
    }
    if (terminalDirty) {
      setTerminalFontSize(fontSize)
      setTerminalCursorBlink(cursorBlink)
    }
    for (const id of dirtyAgents) {
      await window.swarmmind.setAgentConfig(id, agentConfigs[id] ?? {})
      const acct = agentAccounts[id]
      if (acct) {
        // Drop blank manual accounts (no name and no key) so an empty "+ Add"
        // row doesn't persist; CLI-login accounts always survive (their
        // credential lives in the profile dir, not in these fields). Keep the
        // active id pointing at a surviving account.
        const accounts = acct.accounts.filter(a => a.profileDir || a.label.trim() || a.apiKey?.trim())
        const activeId = accounts.some(a => a.id === acct.activeId) ? acct.activeId : accounts[0]?.id
        await window.swarmmind.saveAgentAccounts(id, accounts, activeId)
      }
    }
    setGeneralDirty(false)
    setTerminalDirty(false)
    setDirtyAgents(new Set())
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [generalDirty, terminalDirty, dirtyAgents, agentConfigs, agentAccounts, shell, defaultAgent, idleSeconds, closeTray,
      voiceModelDraft, voicePreloadDraft, setVoiceModelStore, setVoicePreloadStore, swarmAgentKeyDraft, swarmAgentModelDraft,
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

  // ── Account editing ──────────────────────────────────────────────────────
  const updateAccounts = (id: AgentId, fn: (s: AgentAccountsState) => AgentAccountsState) => {
    setAgentAccounts(prev => ({ ...prev, [id]: fn(prev[id] ?? { accounts: [] }) }))
    markAgentDirty(id)
  }

  const addAccount = (id: AgentId) => {
    const acc: AgentAccount = { id: crypto.randomUUID(), label: '' }
    updateAccounts(id, s => ({
      accounts: [...s.accounts, acc],
      // First account becomes active automatically.
      activeId: s.accounts.length === 0 ? acc.id : s.activeId,
    }))
  }

  // One-click connect: the main process creates (and persists) a fresh profile-dir
  // account, then we open the embedded login terminal running the agent CLI's own
  // sign-in flow. No dirty-marking — the account is already saved; the login
  // credential lands in the profile dir, outside the Settings draft model.
  const connectAccount = async (id: AgentId, agentLabel: string) => {
    const n = (agentAccounts[id]?.accounts.length ?? 0) + 1
    const res = await window.swarmmind.connectAgentAccount(id, t('settings.agent.accounts.untitled', { n }))
    if (!res?.account) return
    const acc = res.account
    setAgentAccounts(prev => {
      const s = prev[id] ?? { accounts: [] }
      return { ...prev, [id]: { accounts: [...s.accounts, acc], activeId: s.activeId ?? acc.id } }
    })
    setLoginSession({ agentId: id, agentLabel, accountId: acc.id, profileDir: acc.profileDir! })
  }

  const editAccount = (id: AgentId, accId: string, patch: Partial<AgentAccount>) => {
    updateAccounts(id, s => ({
      ...s,
      accounts: s.accounts.map(a => (a.id === accId ? { ...a, ...patch } : a)),
    }))
  }

  const removeAccount = (id: AgentId, accId: string) => {
    updateAccounts(id, s => {
      const accounts = s.accounts.filter(a => a.id !== accId)
      const activeId = s.activeId === accId ? accounts[0]?.id : s.activeId
      return { accounts, activeId }
    })
  }

  const setActiveAccount = (id: AgentId, accId: string) => {
    updateAccounts(id, s => ({ ...s, activeId: accId }))
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
            {AGENTS.map(a => navItem(a.id, a.label, <AgentIcon id={a.id} size={14} />, dirtyAgents.has(a.id)))}
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
                  <FieldLabel htmlFor="voice-model">{t('settings.voice.model')}</FieldLabel>
                  <select
                    id="voice-model"
                    style={styles.select}
                    value={voiceModelDraft}
                    onChange={e => { setVoiceModelDraft(e.target.value as VoiceModel); setGeneralDirty(true) }}
                  >
                    {VOICE_MODEL_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                    ))}
                  </select>
                  <p style={styles.desc}>{t('settings.voice.modelDesc')}</p>

                  <div style={styles.rowBetween}>
                    <div>
                      <FieldLabel>{t('settings.voice.preload')}</FieldLabel>
                      <p style={{ ...styles.desc, marginTop: 2 }}>
                        {t('settings.voice.preloadDesc')}
                      </p>
                    </div>
                    <button
                      className="settings-toggle"
                      role="switch"
                      aria-checked={voicePreloadDraft}
                      aria-label={t('settings.voice.preload')}
                      onClick={() => { setVoicePreloadDraft(v => !v); setGeneralDirty(true) }}
                    />
                  </div>

                  <p style={styles.desc}>
                    {t('settings.voice.desc')}{' '}
                    {formatKeys(getEffectiveKeys('voice', keybindings)).split('+').map((k, i, arr) => (
                      <React.Fragment key={i}>
                        <kbd style={styles.kbd}>{k}</kbd>{i < arr.length - 1 ? '+' : ''}
                      </React.Fragment>
                    ))}.
                  </p>
                </Group>

                <Group title={t('settings.swarmAgent.group')}>
                  <FieldLabel htmlFor="swarmagent-key">{t('settings.swarmAgent.apiKey')}</FieldLabel>
                  <input
                    id="swarmagent-key"
                    type="password"
                    style={styles.input}
                    autoComplete="off"
                    value={swarmAgentKeyDraft}
                    placeholder={swarmAgentHasKey ? '••••••••••••' : 'gsk_…'}
                    onChange={e => { setSwarmAgentKeyDraft(e.target.value); setGeneralDirty(true) }}
                  />
                  <p style={styles.desc}>
                    {swarmAgentHasKey && !swarmAgentKeyDraft
                      ? t('settings.swarmAgent.apiKeyConfigured')
                      : t('settings.swarmAgent.apiKeyDesc')}
                  </p>

                  <FieldLabel htmlFor="swarmagent-model">{t('settings.swarmAgent.model')}</FieldLabel>
                  <input
                    id="swarmagent-model"
                    type="text"
                    list="swarmagent-model-options"
                    style={styles.input}
                    value={swarmAgentModelDraft}
                    placeholder="llama-3.3-70b-versatile"
                    onChange={e => { setSwarmAgentModelDraft(e.target.value); setGeneralDirty(true) }}
                  />
                  <datalist id="swarmagent-model-options">
                    {Array.from(new Set([...SWARMAGENT_RECOMMENDED.map(r => r.id), ...swarmAgentModels])).map(id => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <div style={styles.modelPicks}>
                    {SWARMAGENT_RECOMMENDED.map(r => (
                      <button
                        key={r.id}
                        type="button"
                        style={{ ...styles.modelPick, ...(swarmAgentModelDraft === r.id ? styles.modelPickActive : {}) }}
                        title={r.id}
                        onClick={() => { setSwarmAgentModelDraft(r.id); setGeneralDirty(true) }}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <p style={styles.desc}>{t('settings.swarmAgent.modelDesc')}</p>
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

                  <div style={{ ...styles.rowBetween, marginTop: 14 }}>
                    <FieldLabel htmlFor="editor-font-size">{t('settings.appearance.editorFontSize')}</FieldLabel>
                    <span style={styles.value}>{editorFontSize}px</span>
                  </div>
                  <input
                    id="editor-font-size"
                    type="range"
                    min={EDITOR_FONT_SIZE_MIN}
                    max={EDITOR_FONT_SIZE_MAX}
                    step={1}
                    value={editorFontSize}
                    onChange={e => setEditorFontSize(Number(e.target.value))}
                    style={styles.range}
                  />
                  <p style={styles.desc}>{t('settings.appearance.editorFontSizeDesc')}</p>
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
              const agentLabel = AGENTS.find(a => a.id === id)?.label ?? id
              const acctState = agentAccounts[id] ?? { accounts: [] }
              const keyPlaceholder = API_KEY_ENV[id] ?? `${id.toUpperCase()}_API_KEY`
              return (
                <div style={styles.fields}>
                  <Group title={t('settings.agent.accounts.group')}>
                    <p style={styles.desc}>{t('settings.agent.accounts.desc', { agent: agentLabel })}</p>

                    {acctState.accounts.length === 0 && (
                      <p style={styles.accountEmpty}>{t('settings.agent.accounts.empty')}</p>
                    )}

                    {acctState.accounts.map((acc, idx) => {
                      const active = acctState.activeId === acc.id
                      return (
                        <div key={acc.id} style={{ ...styles.accountCard, ...(active ? styles.accountCardActive : {}) }}>
                          <div style={styles.accountHead}>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={active}
                              aria-label={t('settings.agent.accounts.setActive')}
                              title={t('settings.agent.accounts.setActive')}
                              onClick={() => setActiveAccount(id, acc.id)}
                              style={{ ...styles.accountRadio, ...(active ? { borderColor: 'var(--accent)' } : {}) }}
                            >
                              {active && <span style={styles.accountRadioDot} />}
                            </button>
                            <input
                              style={{ ...styles.input, flex: 1 }}
                              type="text"
                              placeholder={t('settings.agent.accounts.untitled', { n: idx + 1 })}
                              value={acc.label}
                              onChange={e => editAccount(id, acc.id, { label: e.target.value })}
                            />
                            {active && <span style={styles.accountActiveTag}>{t('settings.agent.accounts.active')}</span>}
                            <button
                              className="pane-action-btn"
                              title={t('settings.agent.accounts.remove')}
                              aria-label={t('settings.agent.accounts.remove')}
                              onClick={() => removeAccount(id, acc.id)}
                            >
                              ✕
                            </button>
                          </div>

                          {acc.profileDir ? (
                            // CLI-login account: the credential lives in its profile
                            // dir (written by the agent's own login flow) — nothing
                            // to type here. Offer a re-login for expired sessions.
                            <div style={styles.rowBetween}>
                              <span style={styles.cliBadge} title={acc.profileDir}>
                                <span style={styles.cliBadgeDot} />
                                {t('settings.agent.accounts.cliBadge')}
                              </span>
                              <button
                                className="settings-card"
                                style={styles.inlineBtn}
                                onClick={() => setLoginSession({ agentId: id, agentLabel, accountId: acc.id, profileDir: acc.profileDir! })}
                              >
                                {t('settings.agent.accounts.relogin')}
                              </button>
                            </div>
                          ) : (
                            <>
                              <FieldLabel htmlFor={`${acc.id}-key`}>{t('settings.agent.apiKey')}</FieldLabel>
                              <input
                                id={`${acc.id}-key`}
                                style={styles.input}
                                type="password"
                                autoComplete="off"
                                placeholder={keyPlaceholder}
                                value={acc.apiKey ?? ''}
                                onChange={e => editAccount(id, acc.id, { apiKey: e.target.value })}
                              />
                            </>
                          )}
                        </div>
                      )
                    })}

                    <div style={styles.rowInline}>
                      {PROFILE_AGENTS.has(id) && (
                        <button style={styles.connectBtn} onClick={() => connectAccount(id, agentLabel)}>
                          {t('settings.agent.accounts.connect', { agent: agentLabel })}
                        </button>
                      )}
                      <button
                        className="settings-card"
                        style={styles.addAccountBtn}
                        onClick={() => addAccount(id)}
                      >
                        {PROFILE_AGENTS.has(id) ? t('settings.agent.accounts.addManual') : t('settings.agent.accounts.add')}
                      </button>
                    </div>
                  </Group>

                  <Group title={t('settings.agent.launch.group')}>
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

      {/* Embedded CLI-login terminal for "connect account" (renders its own
          fixed overlay above this modal). */}
      {loginSession && (
        <LoginTerminal
          agentId={loginSession.agentId}
          agentLabel={loginSession.agentLabel}
          accountId={loginSession.accountId}
          profileDir={loginSession.profileDir}
          onClose={() => setLoginSession(null)}
        />
      )}
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
  modelPicks: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 2px' },
  modelPick: {
    fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-base)',
    border: '1px solid var(--border)', borderRadius: 9999, padding: '3px 11px', cursor: 'pointer',
    transition: 'border-color 120ms, color 120ms, background 120ms',
  },
  modelPickActive: { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-subtle)' },
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
  accountEmpty: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    padding: '4px 0',
  },
  accountCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '12px 12px 14px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    background: 'var(--bg-base)',
  },
  accountCardActive: {
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 1px var(--accent) inset',
  },
  accountHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  accountRadio: {
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: '50%',
    border: '1.5px solid var(--border-strong)',
    background: 'var(--bg-elevated)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  accountRadioDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--accent)',
  },
  accountActiveTag: {
    fontSize: 9.5,
    fontWeight: 600,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: 'var(--accent)',
    flexShrink: 0,
  },
  addAccountBtn: {
    width: 'auto',
    alignSelf: 'flex-start',
    padding: '7px 14px',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  connectBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--accent-fg)',
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    marginTop: 4,
  },
  cliBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '3px 8px',
  },
  cliBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--success)',
    flexShrink: 0,
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
