import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { useVoice } from '../hooks/useVoice'
import { matchEvent, getEffectiveKeys } from '../shortcuts'

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
  const activePaneId = useWorkspaceStore(s => s.activePaneId)
  const activePaneIdRef = useRef(activePaneId)
  useEffect(() => { activePaneIdRef.current = activePaneId }, [activePaneId])

  const [flashMsg, setFlashMsg] = useState<string | null>(null)
  const [transcriptFlash, setTranscriptFlash] = useState('')
  const prevTranscriptRef = useRef('')

  const handleTranscript = useCallback((text: string) => {
    const id = activePaneIdRef.current
    if (id) window.swarmmind.ptyInput(id, text)
  }, [])

  const { status, modelProgress, audioLevels, lastTranscript, start, stop, error } = useVoice(handleTranscript)

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
        showFlash('Transcribing, please wait…')
        return
      case 'model-loading':
        showFlash(modelProgress > 0 ? `Downloading model… ${modelProgress}%` : 'Downloading model…')
        return
      case 'recording':
        stop()
        return
      case 'error':
        // fall through — clicking in error state retries
      case 'idle':
        if (!activePaneIdRef.current) {
          showFlash('Click a terminal pane first')
          return
        }
        start()
        return
    }
  }, [status, modelProgress, start, stop, showFlash])

  // Global voice toggle — binding comes from the shortcut registry (default
  // Ctrl/Cmd+Shift+V) and honours any user rebinding.
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
    ? `Downloading Whisper model… ${modelProgress > 0 ? modelProgress + '%' : ''}`
    : isTranscribing  ? 'Transcribing…'
    : isRecording     ? 'Recording — click to stop (Ctrl+Shift+V)'
    : isError         ? (error ?? 'Error — click to retry')
    : 'Voice input — local Whisper (Ctrl+Shift+V)'

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
        aria-label={isRecording ? 'Stop recording' : isTranscribing ? 'Transcribing' : 'Start voice input'}
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
        {isModelLoading && <><SpinnerIcon /><span>{modelProgress > 0 ? `${modelProgress}%` : 'Loading'}</span></>}
        {isTranscribing  && <><SpinnerIcon /><span>Transcribing</span></>}
        {isRecording     && <><BoltIcon /><WaveformBars levels={audioLevels} /></>}
        {!isActive && !isModelLoading && <><MicIcon /><span>Voice</span></>}
      </button>
    </>
  )
}
