import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useWorkspaceStore, type PaneNode, type PaneLeaf } from '../store/workspace'
import { clampToViewport, dragPosition, defaultPosition, type Point } from '../lib/dragWidget'
import { WaveformBars } from './WaveformBars'
import { useT } from '../i18n'
import logoUrl from '../assets/logo.png'
import type { VoiceStatus } from '../hooks/useVoice'

// A tiny floating dictation pill: the SwarmMind mark and the live audio line,
// nothing else.
//
// Dictation happens while you're watching a *terminal*, not the top bar, so the
// control wants to sit next to whatever you're looking at — which only works if
// it's small enough to leave anywhere without covering your work. Everything a
// bigger panel would spell out (state, target pane, last transcript) lives in
// the tooltip instead, so no information is lost, it's just not always on
// screen. State itself reads from colour and motion: dim and still when idle,
// accent-lit with a moving waveform when it's hearing you.
//
// Purely presentational — SwarmVoice owns the single recorder and passes state
// down, so the pill and the TopBar button can never disagree.

// Deliberately close to the size of the TopBar button it stands in for.
// Width is an estimate for first placement only — the real box is measured
// before clamping, so it doesn't have to be exact.
const WIDGET_HEIGHT = 30
const WIDGET_SIZE = { width: 82, height: WIDGET_HEIGHT }
// The pill's ends are semicircles of this radius. The logo is drawn concentric
// with the left-hand one — same centre, smaller radius — so the round mark
// nests into the round cap instead of floating in a straight-edged gap.
const CAP_RADIUS = WIDGET_HEIGHT / 2
const ORB_SIZE = 20
const ORB_INSET = CAP_RADIUS - ORB_SIZE / 2
// Pointer travel (px) that turns a click into a drag. Below this the pill is
// being pressed, not moved — without it, the tiny wobble in a real click would
// swallow every attempt to start dictation.
const DRAG_THRESHOLD = 4

function collectLeaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(collectLeaves)
}

export function VoiceWidget({
  status,
  modelProgress,
  lastTranscript,
  error,
  onToggle,
  onClose,
}: {
  status: VoiceStatus
  modelProgress: number
  lastTranscript: string
  error: string | null
  onToggle: () => void
  onClose: () => void
}) {
  const t = useT()
  const pos = useWorkspaceStore(s => s.voiceWidgetPos)
  const setPos = useWorkspaceStore(s => s.setVoiceWidgetPos)
  const activePaneId = useWorkspaceStore(s => s.activePaneId)
  const rootPane = useWorkspaceStore(s => s.rootPane)
  const boxRef = useRef<HTMLButtonElement>(null)
  const [dragging, setDragging] = useState(false)

  const isRecording = status === 'recording'
  const isTranscribing = status === 'transcribing'
  const isLoading = status === 'model-loading'
  const isError = status === 'error'
  const isBusy = isTranscribing || isLoading

  // Place on first render, and keep the pill on screen when the window is
  // resized or a saved position no longer fits — otherwise it can end up
  // permanently off-edge and unreachable.
  useLayoutEffect(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const size = boxRef.current?.getBoundingClientRect() ?? WIDGET_SIZE
    if (!pos) {
      setPos(defaultPosition(size, viewport))
      return
    }
    const clamped = clampToViewport(pos, size, viewport)
    if (clamped.x !== pos.x || clamped.y !== pos.y) setPos(clamped)
  }, [pos, setPos])

  useEffect(() => {
    const onResize = () => {
      const current = useWorkspaceStore.getState().voiceWidgetPos
      if (!current) return
      const size = boxRef.current?.getBoundingClientRect() ?? WIDGET_SIZE
      setPos(clampToViewport(current, size, { width: window.innerWidth, height: window.innerHeight }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setPos])

  // The whole pill is both the drag handle and the button — it's too small to
  // carry a separate grip. A press only becomes a drag once the pointer has
  // travelled past the threshold; anything shorter toggles dictation on release.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const box = boxRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    const grab: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const size = { width: rect.width, height: rect.height }
    const origin = { x: e.clientX, y: e.clientY }
    let moved = false

    const move = (ev: PointerEvent) => {
      if (!moved &&
          Math.abs(ev.clientX - origin.x) < DRAG_THRESHOLD &&
          Math.abs(ev.clientY - origin.y) < DRAG_THRESHOLD) return
      if (!moved) { moved = true; setDragging(true) }
      setPos(dragPosition(
        { x: ev.clientX, y: ev.clientY },
        grab,
        size,
        { width: window.innerWidth, height: window.innerHeight },
      ))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (moved) setDragging(false)
      else onToggle()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [setPos, onToggle])

  // Where the dictated text lands, and what the pill is doing — the detail a
  // larger panel would show inline.
  const targetLeaf = collectLeaves(rootPane).find(l => l.id === activePaneId)
  const target = targetLeaf
    ? (targetLeaf.title?.trim() || targetLeaf.agentId || t('voiceWidget.targetPane'))
    : null

  const statusLine = isLoading
    ? `${t('voice.button.loading')}${modelProgress > 0 ? ` ${modelProgress}%` : ''}`
    : isTranscribing ? t('voice.button.transcribing')
    : isRecording ? t('voiceWidget.listening')
    : isError ? (error ?? t('voice.tooltip.error'))
    : t('voiceWidget.ready')

  const tooltip = [
    statusLine + (target ? ` ${t('voiceWidget.target', { pane: target })}` : ''),
    lastTranscript ? `“${lastTranscript}”` : '',
    t('voiceWidget.hint'),
  ].filter(Boolean).join('\n')

  const accent = isRecording ? 'var(--accent)'
    : isError ? 'var(--error)'
    : isBusy ? 'var(--text-secondary)'
    : 'var(--text-muted)'

  return (
    <button
      ref={boxRef}
      aria-label={t('voiceWidget.title')}
      title={tooltip}
      onPointerDown={onPointerDown}
      // Right-click dismisses it — the pill has no room for a close button, and
      // this mirrors the right-click that opened it from the TopBar.
      onContextMenu={e => { e.preventDefault(); onClose() }}
      style={{
        position: 'fixed',
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
        display: 'flex', alignItems: 'center', gap: 9,
        height: WIDGET_HEIGHT,
        // Left padding is what makes the orb concentric with the cap; the right
        // side keeps a normal inset so the waveform isn't jammed into the curve.
        padding: `0 14px 0 ${ORB_INSET}px`,
        borderRadius: CAP_RADIUS,
        border: `1px solid ${isRecording ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: isRecording ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
        color: accent,
        boxShadow: isRecording ? '0 4px 20px var(--accent-glow)' : 'var(--shadow-md)',
        cursor: dragging ? 'grabbing' : 'grab',
        zIndex: 4000,
        userSelect: 'none',
        transition: dragging ? 'none' : 'border-color 150ms, background 150ms, color 150ms, box-shadow 150ms',
      }}
    >
      {/* The brand orb caps the left end. While the model loads or a clip is
          transcribing it wears the same rotating conic ring as the SwarmAgent
          orbs — the bars are still in those states, so this is the only signal
          that work is happening. */}
      <span
        className={`voice-orb${isBusy ? ' is-busy' : ''}`}
        style={{
          width: ORB_SIZE, height: ORB_SIZE,
          // Dim the mark while idle so the lit state reads as "listening".
          opacity: isRecording || isBusy ? 1 : 0.7,
          transition: 'opacity 150ms',
        }}
      >
        <img src={logoUrl} alt="" draggable={false} />
      </span>
      <WaveformBars active={isRecording} minScale={0.15} />
    </button>
  )
}
