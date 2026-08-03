import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AGENT_IDS, useWorkspaceStore, type PaneLeaf, type PaneNode } from '../store/workspace'
import { describeIntent, parseVoiceCommand } from '../lib/voiceCommand'
import { useVoice, preloadVoiceModel, VOICE_MODELS } from '../hooks/useVoice'
import { useWakeWord } from '../hooks/useWakeWord'
import { useLoadingStore } from '../store/loading'
import { matchEvent, getEffectiveKeys, formatKeys } from '../shortcuts'
import { useT } from '../i18n'
import { IconBtn } from './IconBtn'
import { VoiceWidget } from './VoiceWidget'

// ── Icons ─────────────────────────────────────────────────────────────────────

function MicIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  )
}

function BoltIcon() {
  return (
    <svg width="10" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M13 2 3 14h9l-1 8 10-12h-9z" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg
      width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
      aria-hidden="true"
      style={{ animation: 'voice-spin 0.8s linear infinite', flexShrink: 0 }}
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  )
}

// ── SwarmVoice ────────────────────────────────────────────────────────────────

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

export function SwarmVoice() {
  const t = useT()
  const activePaneId = useWorkspaceStore(s => s.activePaneId)
  const widgetOpen   = useWorkspaceStore(s => s.voiceWidgetOpen)
  const toggleWidget = useWorkspaceStore(s => s.toggleVoiceWidget)
  const voicePreload = useWorkspaceStore(s => s.voicePreload)
  const voiceModel   = useWorkspaceStore(s => s.voiceModel)
  const keybindings  = useWorkspaceStore(s => s.keybindings)
  const activePaneIdRef = useRef(activePaneId)
  useEffect(() => { activePaneIdRef.current = activePaneId }, [activePaneId])

  // Pretty-printed effective shortcut for tooltips (honours rebinding).
  const voiceKeys = formatKeys(getEffectiveKeys('voice', keybindings))

  const [flashMsg, setFlashMsg] = useState<string | null>(null)
  const [transcriptFlash, setTranscriptFlash] = useState('')
  const prevTranscriptRef = useRef('')

  const handleTranscript = useCallback((text: string) => {
    const id = activePaneIdRef.current
    if (id) window.swarmmind.ptyInput(id, text)
  }, [])

  const { status, modelProgress, lastTranscript, start, stop, error } = useVoice(handleTranscript)

  // Localised model label + one-time download size, shared by both the overlay
  // (foreground) and the ambient pill (background preload).
  const modelLabel = voiceModel.charAt(0).toUpperCase() + voiceModel.slice(1)
  const modelSize = String(VOICE_MODELS[voiceModel].sizeMB)

  // Warm the Whisper model in the background shortly after startup so the
  // first dictation doesn't wait for download/init/warm-up. Delayed so it
  // never competes with app launch for CPU/network; the model singleton makes
  // a user click during (or before) this a single shared load. Gated on the
  // `voicePreload` setting; re-runs when the user picks a different model so
  // the new one is warmed too. Surfaces a small ambient pill (bottom-left) so
  // the user can see what's loading without being interrupted.
  useEffect(() => {
    if (!voicePreload) return
    const { startLoading, updateLoading, finishLoading } = useLoadingStore.getState()
    let cancelled = false
    const timer = window.setTimeout(() => {
      startLoading('voice-preload', {
        variant: 'ambient',
        title: t('loading.voice.ambient'),
        progress: null,
      })
      preloadVoiceModel(pct => {
        if (!cancelled) updateLoading('voice-preload', { progress: pct })
      }).finally(() => finishLoading('voice-preload'))
    }, 2500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      useLoadingStore.getState().finishLoading('voice-preload')
    }
  }, [voicePreload, voiceModel, t])

  // Foreground model load — when the user actually triggers voice and the model
  // isn't ready yet, show the centred loading overlay. A single 'voice-model'
  // task is created on entering `model-loading` (variant set once so a later
  // "Continue in background" dismissal sticks) and removed when it ends.
  useEffect(() => {
    const { startLoading, finishLoading } = useLoadingStore.getState()
    if (status === 'model-loading') {
      startLoading('voice-model', {
        variant: 'overlay',
        title: t('loading.voice.title'),
        detail: t('loading.voice.detail', { model: modelLabel, size: modelSize }),
        hint: t('loading.voice.hint'),
        progress: modelProgress > 0 ? modelProgress : null,
      })
    } else {
      finishLoading('voice-model')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // Keep the overlay's progress (and localised strings) in sync without
  // re-creating the task, so a dismissal to the ambient pill isn't undone.
  useEffect(() => {
    useLoadingStore.getState().updateLoading('voice-model', {
      title: t('loading.voice.title'),
      detail: t('loading.voice.detail', { model: modelLabel, size: modelSize }),
      hint: t('loading.voice.hint'),
      progress: modelProgress > 0 ? modelProgress : null,
    })
  }, [modelProgress, modelLabel, modelSize, t])

  const isModelLoading = status === 'model-loading'
  const isRecording    = status === 'recording'
  const isTranscribing = status === 'transcribing'
  const isActive       = isRecording || isTranscribing
  const isError        = status === 'error'

  // Flash transcript after injection
  useEffect(() => {
    if (!lastTranscript || lastTranscript === prevTranscriptRef.current) return
    prevTranscriptRef.current = lastTranscript
    setTranscriptFlash(lastTranscript)
    const t = setTimeout(() => setTranscriptFlash(''), 2500)
    return () => clearTimeout(t)
  }, [lastTranscript])

  // Brief overlay message for non-actionable states
  const showFlash = useCallback((msg: string) => {
    setFlashMsg(msg)
    setTimeout(() => setFlashMsg(null), 1800)
  }, [])

  // ── Wake word ───────────────────────────────────────────────────────────────
  // Hands-free trigger: armed, the user says the phrase instead of reaching for
  // the pill. Two shapes, both handled here:
  //
  //   "hey swarm, run the tests"  → the command rode along with the phrase, so
  //                                 inject it directly; no dictation needed.
  //   "hey swarm"                 → open dictation and let them talk.
  //
  // Suspended (`paused`) whenever the recorder is doing anything, so the wake
  // listener and dictation never hold the mic at once — and so the listener
  // can't hear the user's own dictation and re-trigger off it.
  const wakeEnabled = useWorkspaceStore(s => s.voiceWakeEnabled)
  const wakePhrase = useWorkspaceStore(s => s.voiceWakePhrase)
  const startRef = useRef(start)
  startRef.current = start

  // ── Voice orchestration ────────────────────────────────────────────────────
  // A command spoken in the same breath as the wake phrase is classified before
  // it's typed anywhere: "hey swarm, have Codex fix the failing tests" queues a
  // task for Codex rather than typing that sentence into whichever pane happens
  // to be focused. Everything the parser doesn't confidently recognise falls
  // through to dictation, so this only ever adds behaviour — which is why it can
  // be on by default without ever swallowing text the user meant to type.
  //
  // Only the wake-word path is routed. Dictation opened deliberately (the pill,
  // the shortcut) stays literal: the user is looking at a terminal and expects
  // characters in it, and reinterpreting that would be a trap.
  // Returns false when the command needed an active pane and there wasn't one,
  // so the caller can say so instead of silently dropping what was said.
  const runSpokenCommand = useCallback((command: string): boolean => {
    const paneId = activePaneIdRef.current
    const st = useWorkspaceStore.getState()

    const intent = st.voiceCommands
      ? parseVoiceCommand(command, AGENT_IDS)
      : ({ kind: 'dictate', text: command } as const)

    switch (intent.kind) {
      case 'goal':
        st.setOrchestratorGoal(intent.text)
        if (!st.orchestratorBarOpen) st.toggleOrchestratorBar()
        break
      case 'task':
        // Fire-and-forget: the task lands in the board and the conductor picks
        // it up on its next wake, so there's nothing to await here.
        void window.swarmmind.taskCreate(intent.text, undefined, intent.agent ?? undefined)
        break
      case 'control':
        if (intent.action === 'start') {
          // Voice starts the run, but never escalates autonomy behind the user's
          // back: an `off` swarm comes up in `assisted`, where a human still
          // approves each dispatch. Jumping straight to `auto` from a phrase
          // that could be misheard is not a trade worth making.
          if (st.orchestrationMode === 'off') st.setOrchestrationMode('assisted')
          st.startOrchestration()
        } else {
          st.stopOrchestration()
        }
        break
      case 'broadcast':
        for (const leaf of collectLeaves(st.rootPane)) {
          if (leaf.ptyStatus === 'running') window.swarmmind.ptyInput(leaf.id, intent.text)
        }
        break
      case 'dictate':
        // Only dictation actually needs somewhere to type. Orchestration
        // commands act on the swarm, so "hey swarm, stop the swarm" has to work
        // with no pane focused — the state this used to reject outright.
        if (!paneId) return false
        window.swarmmind.ptyInput(paneId, intent.text)
        break
    }
    setTranscriptFlash(describeIntent(intent))
    return true
  }, [])

  // The wake callback is created before this in source order and must not go
  // stale when the store changes, so it reaches the handler through a ref.
  const runSpokenCommandRef = useRef(runSpokenCommand)
  runSpokenCommandRef.current = runSpokenCommand

  const handleWake = useCallback((command: string, stream: MediaStream | null) => {
    // A command spoken with the phrase never needs the mic again — and an
    // orchestration command doesn't need a pane either, so it's routed before
    // the no-pane check that only dictation actually cares about.
    if (command) {
      stream?.getTracks().forEach(tr => tr.stop())
      if (!runSpokenCommandRef.current(command)) showFlash(t('voice.flash.noPane'))
      return
    }
    if (!activePaneIdRef.current) {
      // Nothing will adopt the handed-over mic, so close it here rather than
      // leaving a live microphone owned by nobody.
      stream?.getTracks().forEach(tr => tr.stop())
      showFlash(t('voice.flash.noPane'))
      return
    }
    // Adopt the listener's live stream — dictation is now recording without
    // waiting on another getUserMedia.
    void startRef.current(stream ?? undefined)
  }, [showFlash, t])

  const { wakeStatus, wakeError } = useWakeWord({
    enabled: wakeEnabled,
    phrase: wakePhrase,
    onWake: handleWake,
    paused: status !== 'idle',
  })
  const wakeListening = wakeStatus === 'armed' || wakeStatus === 'checking'

  const handleToggle = useCallback(() => {
    switch (status) {
      case 'transcribing':
        showFlash(t('voice.flash.transcribing'))
        return
      case 'model-loading':
        showFlash(modelProgress > 0
          ? t('voice.flash.downloadingPct', { pct: String(modelProgress) })
          : t('voice.flash.downloading'))
        return
      case 'recording':
        stop()
        return
      case 'error':
        // fall through — clicking in error state retries
      case 'idle':
        if (!activePaneIdRef.current) {
          showFlash(t('voice.flash.noPane'))
          return
        }
        start()
        return
    }
  }, [status, modelProgress, start, stop, showFlash, t])

  // Global voice toggle — binding comes from the shortcut registry (default
  // Ctrl/Cmd+Shift+M) and honours any user rebinding.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const keys = getEffectiveKeys('voice', useWorkspaceStore.getState().keybindings)
      if (matchEvent(e, keys)) {
        e.preventDefault()
        handleToggle()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleToggle])

  // Only the foreground colour is ours now; IconBtn owns the box, background
  // and hover states so the button matches the icons around it.
  const fgColor = isActive ? 'var(--accent)' : isError ? 'var(--error)' : 'var(--text-muted)'

  const tooltip = isModelLoading
    ? `${t('voice.tooltip.downloading')}${modelProgress > 0 ? ` ${modelProgress}%` : ''}`
    : isTranscribing  ? t('voice.tooltip.transcribing')
    : isRecording     ? t('voice.tooltip.recording', { keys: voiceKeys })
    : isError         ? (error ?? t('voice.tooltip.error'))
    : wakeError       ? t('voice.wake.failed', { error: wakeError })
    : wakeListening   ? t('voice.wake.armed', { phrase: wakePhrase })
    : t('voice.tooltip.idle', { keys: voiceKeys })

  return (
    <>
      {/* ── Floating dictation widget (drag anywhere) ─────────────────────────── */}
      {widgetOpen && (
        <VoiceWidget
          status={status}
          modelProgress={modelProgress}
          lastTranscript={lastTranscript}
          error={error}
          wakeListening={wakeListening}
          wakePhrase={wakePhrase}
          onToggle={handleToggle}
          onClose={toggleWidget}
        />
      )}

      {/* ── Status flash (model loading / no pane / etc.) ────────────────────── */}
      {flashMsg && (
        <div style={{
          position: 'fixed', top: 46, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
          borderRadius: 10, padding: '5px 14px', maxWidth: 400, zIndex: 5000,
          pointerEvents: 'none', boxShadow: 'var(--shadow-md)',
        }}>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            {flashMsg}
          </p>
        </div>
      )}

      {/* ── Transcript flash ──────────────────────────────────────────────────── */}
      {transcriptFlash && (
        <div style={{
          position: 'fixed', top: 46, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--accent)',
          borderRadius: 10, padding: '5px 14px', maxWidth: 500, zIndex: 5000,
          pointerEvents: 'none', boxShadow: '0 4px 20px var(--accent-glow)',
        }}>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {transcriptFlash}
          </p>
        </div>
      )}

      {/* ── Voice button ─────────────────────────────────────────────────────── */}
      {/* Icon only, and it shows/hides the floating pill rather than recording:
          talking happens on the pill (or via the shortcut, which still toggles
          recording directly). Keeps the TopBar quiet while making the dictation
          surface something you park next to the pane you're watching. */}
      {/* Uses the TopBar's shared IconBtn so it sits flush with the icons beside
          it — same 28×28 box, same 6px radius, same hover/active treatment.
          Only the colour is overridden, and only while dictation is actually
          live, so the button reads as "recording" without breaking the row. */}
      <IconBtn
        label={t('voice.aria.widget')}
        title={`${t('voice.tooltip.widget', { keys: voiceKeys })}\n${tooltip}`}
        onClick={toggleWidget}
        active={widgetOpen}
        pressed={widgetOpen}
        style={isActive || isError ? { color: fgColor } : undefined}
      >
        {/* Busy states still read from the TopBar even when the pill is hidden. */}
        {isModelLoading || isTranscribing ? <SpinnerIcon /> : isRecording ? <BoltIcon /> : <MicIcon />}
        {/* A hands-free mic is listening even when nothing else says so, and
            that's exactly the state a user must never be in unknowingly — so
            the dot shows on the TopBar regardless of whether the pill is open. */}
        {wakeListening && !isActive && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', right: 4, bottom: 4,
              width: 5, height: 5, borderRadius: '50%',
              background: 'var(--accent)',
              boxShadow: '0 0 4px var(--accent-glow)',
            }}
          />
        )}
      </IconBtn>
    </>
  )
}
