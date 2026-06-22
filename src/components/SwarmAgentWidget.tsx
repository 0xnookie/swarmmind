import React, { useEffect, useRef, useState } from 'react'
import { useSwarmAgent } from '../hooks/useSwarmAgent'
import { useVoice } from '../hooks/useVoice'
import { useAppearanceSync } from '../hooks/useAppearanceSync'
import { useT } from '../i18n'
import { AGENTS, AgentIcon } from '../data/agents'
import { Markdown } from '../lib/markdown'
import logoUrl from '../assets/logo.png'
import './SwarmAgentWidget.css'

// SwarmAgent desktop widget — a slim floating bar that hosts the assistant when
// the main SwarmMind window is minimized or tucked in the tray. It runs the same
// agent loop as the in-app chat but forwards every tool call to the main window
// (which owns the real workspace state). Drag it around the desktop by the bar.
//
// Collapsed it's just the input bar; once there's a conversation it grows upward
// to show a compact transcript (the main process resizes the window — see
// widget:resize). Matches the user's selected theme via useAppearanceSync.

const forwardTool = (name: string, rawArgs: string): Promise<string> =>
  window.swarmmind.widgetForwardTool(name, rawArgs)

const COLLAPSED_H = 70
const EXPANDED_H = 460
const ALERT_H = 42

export function SwarmAgentWidget() {
  useAppearanceSync()
  const t = useT()
  // The widget has no store of its own (it forwards tools to the main window),
  // so it can't build live context locally — omit it rather than report a
  // misleading empty state; the assistant can still call get_status if needed.
  const { messages, streaming, sending, error, send, stop, clear } = useSwarmAgent({ runTool: forwardTool, getContext: () => '' })
  const [input, setInput] = useState('')
  const [hasKey, setHasKey] = useState(true)
  // Panes that have pinged "needs your input" since the user last acted, mapped
  // to the agent running there — the widget's ambient awareness when SwarmMind
  // is minimized out of sight.
  const [attention, setAttention] = useState<Map<string, string | null>>(new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // pty:attention is broadcast to every window with the blocked pane's agent
  // (see pty-manager); collect the pings here. Cleared when the user opens the
  // app or dismisses.
  useEffect(() => {
    return window.swarmmind.onPtyAttention((paneId, agentId) => {
      setAttention(prev => {
        if (prev.get(paneId) === agentId) return prev
        return new Map(prev).set(paneId, agentId)
      })
    })
  }, [])
  const attentionCount = attention.size
  // The single waiting agent's id (for an icon + name), if exactly one is waiting.
  const soloAgentId = attentionCount === 1 ? [...attention.values()][0] : null
  const soloAgentLabel = soloAgentId ? (AGENTS.find(a => a.id === soloAgentId)?.label ?? soloAgentId) : null
  const openApp = () => { setAttention(new Map()); window.swarmmind.widgetRestoreMain() }

  const voice = useVoice(text => { if (text.trim()) send(text) })
  const voiceLoading = voice.status === 'model-loading'
  const voiceRecording = voice.status === 'recording'
  const voiceTranscribing = voice.status === 'transcribing'
  const micActive = voiceRecording || voiceTranscribing || voiceLoading
  const handleMic = () => {
    if (voiceRecording) voice.stop()
    else if (voice.status === 'idle' || voice.status === 'error') voice.start()
  }

  const expanded = messages.length > 0 || sending || !!streaming || (!!error)
  const showAlert = attentionCount > 0

  // Grow the window upward when a conversation is showing (and to fit the alert
  // banner), shrink back to a bar when both are gone.
  useEffect(() => {
    const base = expanded ? EXPANDED_H : COLLAPSED_H
    window.swarmmind.widgetResize(base + (showAlert ? ALERT_H : 0))
  }, [expanded, showAlert])

  useEffect(() => {
    window.swarmmind.swarmAgentHasKey().then(setHasKey).catch(() => setHasKey(false))
    inputRef.current?.focus()
  }, [])

  // Stick to the bottom only when already near it (don't yank the user back down
  // while they scroll up to re-read), but always snap down when first expanding.
  const stickRef = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }
  useEffect(() => {
    if (expanded && stickRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, streaming, sending, expanded])

  const grow = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 80) + 'px'
  }

  const submit = () => {
    if (!input.trim() || sending) return
    send(input)
    setInput('')
    requestAnimationFrame(grow)
  }

  return (
    <div className={`wg-root${expanded ? ' wg-expanded' : ''}`}>
      {showAlert && (
        <div className="wg-alert">
          {soloAgentId
            ? <span className="wg-alert-agent"><AgentIcon id={soloAgentId} size={15} /></span>
            : <span className="wg-alert-pulse" />}
          <span className="wg-alert-text">
            {attentionCount === 1
              ? (soloAgentLabel ? t('widget.attention.named', { agent: soloAgentLabel }) : t('widget.attention.one'))
              : t('widget.attention.many', { n: attentionCount })}
          </span>
          <button className="wg-alert-open" onClick={openApp}>{t('widget.open')}</button>
          <button className="wg-icon wg-alert-x" title={t('widget.dismiss')} onClick={() => setAttention(new Map())}><CloseIcon /></button>
        </div>
      )}

      {expanded && (
        <>
          <header className="wg-head">
            <span className="wg-head-title">
              <span className={`wg-dot${sending ? ' wg-dot-busy' : ''}`} />
              {sending ? t('swarmAgent.thinking') : t('swarmAgent.ready')}
            </span>
            <div className="wg-head-actions">
              <button className="wg-icon" title={t('swarmAgent.clear')} onClick={clear} disabled={!messages.length}><TrashIcon /></button>
              <button className="wg-icon" title={t('widget.openApp')} onClick={openApp}><ExpandIcon /></button>
              <button className="wg-icon wg-close" title={t('widget.close')} onClick={() => window.swarmmind.widgetHide()}><CloseIcon /></button>
            </div>
          </header>

          <div ref={scrollRef} className="wg-scroll" onScroll={onScroll}>
            {!hasKey && (
              <div className="wg-notice">
                {t('swarmAgent.noKey')}
                <button onClick={openApp}>{t('widget.openApp')}</button>
              </div>
            )}
            {messages.map((m, i) => <WidgetRow key={i} m={m} />)}
            {streaming && (
              <div className="wg-row wg-assistant"><div className="wg-bubble wg-from-assistant"><Markdown text={streaming} /></div></div>
            )}
            {sending && !streaming && (
              <div className="wg-row wg-assistant"><div className="wg-bubble wg-from-assistant wg-typing"><span /><span /><span /></div></div>
            )}
            {error && !sending && <div className="wg-error">{error}</div>}
          </div>
        </>
      )}

      {/* The bar — always present; it's the drag handle (controls are no-drag). */}
      <div className="wg-bar">
        <span className="wg-orb" title="SwarmAgent"><img src={logoUrl} alt="" draggable={false} /></span>
        <textarea
          ref={inputRef}
          className="wg-input"
          value={input}
          placeholder={t('swarmAgent.placeholder')}
          rows={1}
          onChange={e => { setInput(e.target.value); grow() }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
        />
        <button
          className="wg-mic"
          data-active={micActive}
          data-recording={voiceRecording}
          title={voiceRecording ? t('swarmAgent.listening') : t('swarmAgent.talk')}
          onClick={handleMic}
        >
          {voiceLoading ? (
            <span className="wg-mic-load"><span className="wg-spinner" />{voice.modelProgress > 0 ? `${voice.modelProgress}%` : ''}</span>
          ) : voiceTranscribing ? (
            <span className="wg-spinner" />
          ) : voiceRecording ? (
            <WaveformBars levels={voice.audioLevels} />
          ) : (
            <MicIcon />
          )}
        </button>
        {sending ? (
          <button className="wg-send wg-stop" onClick={stop} title={t('swarmAgent.stop')}><StopIcon /></button>
        ) : (
          <button className="wg-send" onClick={submit} disabled={!input.trim()} title={t('swarmAgent.send')}><SendIcon /></button>
        )}
        {!expanded && (
          <button className="wg-icon wg-bar-close" title={t('widget.close')} onClick={() => window.swarmmind.widgetHide()}><CloseIcon /></button>
        )}
      </div>
    </div>
  )
}

function WidgetRow({ m }: { m: SwarmAgentMessage }) {
  if (m.role === 'user') {
    return <div className="wg-row wg-user"><div className="wg-bubble wg-from-user">{m.content ?? ''}</div></div>
  }
  if (m.role === 'tool') {
    return <div className="wg-tool"><CheckIcon />{m.content}</div>
  }
  return (
    <>
      {m.content && <div className="wg-row wg-assistant"><div className="wg-bubble wg-from-assistant"><Markdown text={m.content} /></div></div>}
      {m.tool_calls?.map(c => (
        <div key={c.id} className="wg-tool"><CheckIcon /><code>{c.function.name}</code></div>
      ))}
    </>
  )
}

// Live mic level bars while recording — mirrors SwarmVoice's waveform.
function WaveformBars({ levels }: { levels: number[] }) {
  const hasSignal = levels.some(l => l > 0.02)
  return (
    <span className="wg-wave" aria-hidden>
      {levels.map((level, i) => (
        <i
          key={i}
          style={{
            transition: hasSignal ? 'transform 55ms ease-out' : undefined,
            transform: hasSignal ? `scaleY(${Math.max(0.18, level)})` : undefined,
            animation: hasSignal ? 'none' : `wg-bar-pulse 0.55s ease-in-out ${i * 0.11}s infinite alternate`,
          }}
        />
      ))}
    </span>
  )
}

// ── Icons ───────────────────────────────────────────────────────────────────
const ico = (w: number) => ({ width: w, height: w, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true })
function SendIcon() { return <svg {...ico(16)}><path d="M12 19V5M5 12l7-7 7 7" /></svg> }
function StopIcon() { return <svg {...ico(15)} fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg> }
function MicIcon() { return <svg {...ico(16)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg> }
function CheckIcon() { return <svg {...ico(12)}><path d="M20 6 9 17l-5-5" /></svg> }
function TrashIcon() { return <svg {...ico(14)}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" /></svg> }
function ExpandIcon() { return <svg {...ico(14)}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg> }
function CloseIcon() { return <svg {...ico(13)}><path d="M18 6 6 18M6 6l12 12" /></svg> }
