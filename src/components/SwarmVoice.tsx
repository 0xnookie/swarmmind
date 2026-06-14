import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { useVoice, preloadVoiceModel, VOICE_MODELS } from '../hooks/useVoice'
import { useLoadingStore } from '../store/loading'
import { matchEvent, getEffectiveKeys, formatKeys } from '../shortcuts'
import { useT } from '../i18n'

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

// ── Waveform bars ─────────────────────────────────────────────────────────────

function WaveformBars({ levels }: { levels: number[] }) {
  const hasSignal = levels.some(l => l > 0.02)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 14, flexShrink: 0 }}>
      {levels.map((level, i) => (
        <div
          key={i}
          style={{
            width: 3,
            height: 12,
            background: 'currentColor',
            borderRadius: 2,
            transformOrigin: 'center',
            transition: hasSignal ? 'transform 55ms ease-out' : 'none',
            transform: hasSignal ? `scaleY(${Math.max(0.15, level)})` : undefined,
            animation: !hasSignal
              ? `voice-bar-pulse 0.55s ease-in-out ${i * 0.11}s infinite alternate`
              : 'none',
          }}
        />
      ))}
    </div>
  )
}

// ── SwarmVoice ────────────────────────────────────────────────────────────────

export function SwarmVoice() {
  const t = useT()
  const activePaneId = useWorkspaceStore(s => s.activePaneId)
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

  const { status, modelProgress, audioLevels, lastTranscript, start, stop, error } = useVoice(handleTranscript)

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

  // Button colours
  const borderColor = isActive  ? 'var(--accent)'
    : isError        ? 'var(--error)'
    : isModelLoading ? 'var(--border-strong)'
    : 'var(--border-strong)'

  const bgColor = isActive ? 'var(--accent-subtle)' : 'transparent'

  const fgColor = isActive       ? 'var(--accent)'
    : isError        ? 'var(--error)'
    : isModelLoading ? 'var(--text-dim)'
    : 'var(--text-muted)'

  const tooltip = isModelLoading
    ? `${t('voice.tooltip.downloading')}${modelProgress > 0 ? ` ${modelProgress}%` : ''}`
    : isTranscribing  ? t('voice.tooltip.transcribing')
    : isRecording     ? t('voice.tooltip.recording', { keys: voiceKeys })
    : isError         ? (error ?? t('voice.tooltip.error'))
    : t('voice.tooltip.idle', { keys: voiceKeys })

  return (
    <>
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
      <button
        aria-label={isRecording ? t('voice.aria.stop') : isTranscribing ? t('voice.aria.transcribing') : t('voice.aria.start')}
        title={tooltip}
        onClick={handleToggle}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          height: 28, padding: '0 10px', borderRadius: 14,
          border: `1px solid ${borderColor}`,
          background: bgColor, color: fgColor,
          cursor: 'pointer', fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
          transition: 'border-color 150ms, background 150ms, color 150ms',
          flexShrink: 0, whiteSpace: 'nowrap',
        }}
      >
        {isModelLoading && <><SpinnerIcon /><span>{modelProgress > 0 ? `${modelProgress}%` : t('voice.button.loading')}</span></>}
        {isTranscribing  && <><SpinnerIcon /><span>{t('voice.button.transcribing')}</span></>}
        {isRecording     && <><BoltIcon /><WaveformBars levels={audioLevels} /></>}
        {!isActive && !isModelLoading && <><MicIcon /><span>{t('voice.button.voice')}</span></>}
      </button>
    </>
  )
}
