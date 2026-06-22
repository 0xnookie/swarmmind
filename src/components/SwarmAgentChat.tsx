import React, { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore, type PaneNode } from '../store/workspace'
import { useSwarmAgent } from '../hooks/useSwarmAgent'
import { useVoice } from '../hooks/useVoice'
import { useFileMentions } from '../hooks/useFileMentions'
import { useT, type TFunction } from '../i18n'
import { Markdown } from '../lib/markdown'
import logoUrl from '../assets/logo.png'
import './SwarmAgentChat.css'

// SwarmAgent — the in-app assistant. A center overlay: chat by typing or
// talking; it answers and can perform app actions (open a workspace with N
// agents, add panes, broadcast prompts) via tool calls.
export function SwarmAgentChat() {
  const t = useT()
  const openSettings = useWorkspaceStore(s => s.openSettings)
  const workspace = useWorkspaceStore(s => s.workspace)
  const rootPane = useWorkspaceStore(s => s.rootPane)
  // Context-aware empty-state chips: orient a newcomer, then nudge toward setup,
  // then toward acting on running agents — so the suggestions stay relevant.
  const suggestions = !workspace
    ? NEW_USER_SUGGESTIONS
    : countRunningAgents(rootPane) > 0
      ? ACTIVE_SUGGESTIONS
      : WORKSPACE_SUGGESTIONS
  const { messages, streaming, sending, error, ttsEnabled, setTtsEnabled, send, stop, regenerate, canRegenerate, clear } = useSwarmAgent()
  const [input, setInput] = useState('')
  const [hasKey, setHasKey] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mentions = useFileMentions({ value: input, setValue: setInput, textareaRef: inputRef })

  // Voice input: a transcript is sent straight through for a hands-free flow.
  const voice = useVoice(text => { if (text.trim()) send(text) })
  const voiceLoading = voice.status === 'model-loading'
  const voiceRecording = voice.status === 'recording'
  const voiceTranscribing = voice.status === 'transcribing'
  const micActive = voiceRecording || voiceTranscribing || voiceLoading

  // Mirror SwarmVoice's toggle semantics: start when idle/error, stop only while
  // recording; ignore clicks during load/transcribe so they can't be cut short.
  const handleMic = () => {
    if (voiceRecording) voice.stop()
    else if (voice.status === 'idle' || voice.status === 'error') voice.start()
  }
  const micTitle = voiceLoading ? t('voice.tooltip.downloading')
    : voiceTranscribing ? t('voice.tooltip.transcribing')
    : voiceRecording ? t('swarmAgent.listening')
    : t('swarmAgent.talk')

  useEffect(() => {
    window.swarmmind.swarmAgentHasKey().then(setHasKey).catch(() => setHasKey(false))
    inputRef.current?.focus()
  }, [])

  // Return focus to the composer once a turn finishes so the next prompt can be
  // typed immediately (e.g. after a voice send or a multi-step tool run).
  useEffect(() => {
    if (!sending) inputRef.current?.focus()
  }, [sending])

  // Stick to the bottom only when the user is already near it — so scrolling up
  // to re-read history isn't yanked back down while the agent streams.
  const stickRef = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useEffect(() => {
    if (!stickRef.current) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, streaming, sending])

  // Auto-grow the composer up to the CSS max-height.
  const grow = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }

  const submit = () => {
    if (!input.trim() || sending) return
    send(input)
    setInput('')
    requestAnimationFrame(grow)
  }

  return (
    <div className="sa-root">
      <header className="sa-header">
        <div className="sa-brand">
          <div className="sa-orb"><OrbMark /></div>
          <div>
            <div className="sa-title">{t('swarmAgent.title')}</div>
            <div className="sa-status">
              <span className={`sa-status-dot${sending ? ' sa-busy' : ''}`} />
              {sending ? t('swarmAgent.thinking') : t('swarmAgent.ready')}
            </div>
          </div>
        </div>
        <div className="sa-actions">
          <button
            className="sa-pill"
            data-on={ttsEnabled}
            title={ttsEnabled ? t('swarmAgent.speakOn') : t('swarmAgent.speakOff')}
            onClick={() => setTtsEnabled(!ttsEnabled)}
          >
            {ttsEnabled ? <SpeakerOnIcon /> : <SpeakerOffIcon />}
            {ttsEnabled ? t('swarmAgent.voice') : t('swarmAgent.voice')}
          </button>
          <button className="sa-icon" title={t('swarmAgent.regenerate')} onClick={regenerate} disabled={!canRegenerate}>
            <RegenIcon />
          </button>
          <button className="sa-icon" title={t('swarmAgent.clear')} onClick={clear} disabled={!messages.length}>
            <TrashIcon />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="sa-scroll" onScroll={onScroll}>
        {!hasKey && (
          <div className="sa-notice">
            <span className="sa-notice-key"><KeyIcon /></span>
            <span>{t('swarmAgent.noKey')}</span>
            <button onClick={() => openSettings()}>{t('swarmAgent.openSettings')}</button>
          </div>
        )}

        {messages.length === 0 && hasKey && (
          <div className="sa-hero">
            <div className="sa-orb"><OrbMark /></div>
            <div className="sa-hero-title">{t('swarmAgent.heroTitle')}</div>
            <div className="sa-hero-sub">{t('swarmAgent.heroSub')}</div>
            <div className="sa-suggestions">
              {suggestions.map(s => (
                <button key={s.key} className="sa-suggestion" onClick={() => send(t(s.key))}>
                  {s.icon}
                  {t(s.key)}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => <MessageRow key={i} m={m} t={t} live={sending && i === messages.length - 1} />)}

        {streaming && (
          <div className="sa-row sa-assistant">
            <div className="sa-orb sa-orb-sm"><OrbMark /></div>
            <div className="sa-bubble sa-from-assistant"><Markdown text={streaming} /></div>
          </div>
        )}
        {sending && !streaming && (
          <div className="sa-row sa-assistant">
            <div className="sa-orb sa-orb-sm sa-orb-thinking"><OrbMark /></div>
            <div className="sa-thinking">
              <span className="sa-thinking-label">{t('swarmAgent.thinking')}</span>
            </div>
          </div>
        )}
        {error && !sending && <div className="sa-error">{error}</div>}
      </div>

      <div className="sa-composer">
        {mentions.active && (
          <div className="sa-mention-menu">
            {mentions.candidates.map((path, i) => (
              <button
                key={path}
                className={`sa-mention-item${i === mentions.index ? ' sa-mention-active' : ''}`}
                onMouseEnter={() => mentions.setIndex(i)}
                onMouseDown={e => { e.preventDefault(); mentions.choose(path); grow() }}
              >
                <span className="sa-mention-name">{path.split('/').pop()}</span>
                <span className="sa-mention-dir">{path}</span>
              </button>
            ))}
          </div>
        )}
        <div className="sa-composer-box">
          <button
            className="sa-mic"
            data-active={micActive}
            data-recording={voiceRecording}
            title={micTitle}
            onClick={handleMic}
          >
            {voiceLoading ? (
              <span className="sa-mic-load"><span className="sa-spinner" />{voice.modelProgress > 0 ? `${voice.modelProgress}%` : t('voice.button.loading')}</span>
            ) : voiceTranscribing ? (
              <span className="sa-mic-load"><span className="sa-spinner" />{t('voice.button.transcribing')}</span>
            ) : voiceRecording ? (
              <WaveformBars levels={voice.audioLevels} />
            ) : (
              <MicIcon />
            )}
          </button>
          <textarea
            ref={inputRef}
            className="sa-input"
            value={input}
            placeholder={t('swarmAgent.placeholder')}
            rows={1}
            onChange={e => { setInput(e.target.value); grow(); requestAnimationFrame(mentions.refresh) }}
            onKeyUp={mentions.refresh}
            onClick={mentions.refresh}
            onKeyDown={e => {
              if (mentions.onKeyDown(e)) return
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            }}
          />
          {sending ? (
            <button className="sa-send sa-stop" onClick={stop} title={t('swarmAgent.stop')}>
              <StopIcon />
            </button>
          ) : (
            <button className="sa-send" onClick={submit} disabled={!input.trim()} title={t('swarmAgent.send')}>
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageRow({ m, t, live }: { m: SwarmAgentMessage; t: TFunction; live: boolean }) {
  if (m.role === 'user') {
    return (
      <div className="sa-row sa-user">
        <div className="sa-bubble sa-from-user">{m.content ?? ''}</div>
      </div>
    )
  }
  if (m.role === 'tool') {
    return (
      <div className="sa-tool-result">
        <CheckIcon />
        {m.content}
      </div>
    )
  }
  // assistant
  return (
    <>
      {m.content && (
        <div className="sa-row sa-assistant">
          <div className="sa-orb sa-orb-sm"><OrbMark /></div>
          <div className="sa-bubble sa-from-assistant"><Markdown text={m.content} /></div>
        </div>
      )}
      {m.tool_calls?.map(c => (
        <div key={c.id} className="sa-tool-chip" data-done={!live}>
          {live ? <span className="sa-spinner" /> : <CheckIcon />}
          {live ? t('swarmAgent.running') : t('swarmAgent.ran')} <code>{c.function.name}</code>
        </div>
      ))}
    </>
  )
}

// Live mic level bars while recording — mirrors SwarmVoice's waveform. Falls
// back to a gentle idle pulse when there's no signal yet.
function WaveformBars({ levels }: { levels: number[] }) {
  const hasSignal = levels.some(l => l > 0.02)
  return (
    <span className="sa-mic-wave" aria-hidden>
      {levels.map((level, i) => (
        <i
          key={i}
          style={{
            transition: hasSignal ? 'transform 55ms ease-out' : undefined,
            transform: hasSignal ? `scaleY(${Math.max(0.18, level)})` : undefined,
            animation: hasSignal ? 'none' : `voice-bar-pulse 0.55s ease-in-out ${i * 0.11}s infinite alternate`,
          }}
        />
      ))}
    </span>
  )
}

// Suggestion chips shown on the empty state — clicking sends the prompt. Three
// sets, chosen by workspace state so the assistant proposes a relevant next step.
type TKey = Parameters<TFunction>[0]
type Suggestion = { key: TKey; icon: React.ReactNode }

// No workspace open yet — orient a brand-new user.
const NEW_USER_SUGGESTIONS: Suggestion[] = [
  { key: 'swarmAgent.suggest.openWorkspace', icon: <FolderIcon /> },
  { key: 'swarmAgent.suggest.listWorkspaces', icon: <ListIcon /> },
  { key: 'swarmAgent.suggest.whatCanYouDo', icon: <InfoIcon /> },
]
// Workspace open but nothing running — nudge toward putting agents to work.
const WORKSPACE_SUGGESTIONS: Suggestion[] = [
  { key: 'swarmAgent.suggest.addAgents', icon: <PlusIcon /> },
  { key: 'swarmAgent.suggest.status', icon: <ActivityIcon /> },
  { key: 'swarmAgent.suggest.whatCanYouDo', icon: <InfoIcon /> },
]
// Agents are running — suggest acting on them.
const ACTIVE_SUGGESTIONS: Suggestion[] = [
  { key: 'swarmAgent.suggest.status', icon: <ActivityIcon /> },
  { key: 'swarmAgent.suggest.changes', icon: <ListIcon /> },
  { key: 'swarmAgent.suggest.reviewWork', icon: <BranchIcon /> },
  { key: 'swarmAgent.suggest.checkpoint', icon: <FlagIcon /> },
]

// Count running agent panes in the layout tree (drives which chip set shows).
function countRunningAgents(node: PaneNode): number {
  if (node.type === 'leaf') return node.agentId && node.ptyStatus === 'running' ? 1 : 0
  return node.children.reduce((n, c) => n + countRunningAgents(c), 0)
}

// ── Icons ───────────────────────────────────────────────────────────────────
const ico = (w: number) => ({ width: w, height: w, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true })

// The SwarmMind brand mark — the same swarm logo used in the title bar and start
// screen — rendered inside the orb so the assistant reads as part of the app.
function OrbMark() {
  return <img className="sa-orb-img" src={logoUrl} alt="" draggable={false} />
}
function SpeakerOnIcon() { return <svg {...ico(15)}><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg> }
function SpeakerOffIcon() { return <svg {...ico(15)}><path d="M11 5 6 9H2v6h4l5 4z" /><path d="m22 9-6 6M16 9l6 6" /></svg> }
function TrashIcon() { return <svg {...ico(15)}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" /></svg> }
function KeyIcon() { return <svg {...ico(18)}><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.5 12.5 8-8M16 7l2 2M19 4l2 2" /></svg> }
function MicIcon() { return <svg {...ico(17)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg> }
function SendIcon() { return <svg {...ico(17)}><path d="M12 19V5M5 12l7-7 7 7" /></svg> }
function StopIcon() { return <svg {...ico(16)} fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg> }
function RegenIcon() { return <svg {...ico(15)}><path d="M21 5v5h-5M3 19v-5h5" /><path d="M19.4 9A7.5 7.5 0 0 0 6.3 6.3L3 9m18 6-3.3 2.7A7.5 7.5 0 0 1 4.6 15" /></svg> }
function CheckIcon() { return <svg {...ico(13)}><path d="M20 6 9 17l-5-5" /></svg> }
function FolderIcon() { return <svg {...ico(14)}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg> }
function PlusIcon() { return <svg {...ico(14)}><path d="M12 5v14M5 12h14" /></svg> }
function ListIcon() { return <svg {...ico(14)}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg> }
function InfoIcon() { return <svg {...ico(14)}><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg> }
function ActivityIcon() { return <svg {...ico(14)}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg> }
function BranchIcon() { return <svg {...ico(14)}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="8" r="3" /><path d="M18 11a6 6 0 0 1-6 6H9M6 9v6" /></svg> }
function FlagIcon() { return <svg {...ico(14)}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" /></svg> }
