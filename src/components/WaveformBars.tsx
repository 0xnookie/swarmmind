import React, { useEffect, useRef } from 'react'
import { readAudioLevels, BAR_COUNT } from '../hooks/useVoice'

// The live mic waveform, shared by every surface that shows one (the TopBar
// voice button, the floating voice widget, SwarmAgent's chat and its desktop
// widget) — previously four near-identical copies.
//
// It renders itself. Rather than taking levels as a prop (which meant the
// owning component re-rendered on every animation frame just to move five
// bars), it runs its own rAF while active, reads the shared level buffer that
// `useVoice`'s analyser writes, and mutates the bars' `transform` directly.
// React renders once when recording starts and once when it stops; the
// animation in between never touches the virtual DOM.

export function WaveformBars({
  active,
  className,
  pulseAnimation = 'voice-bar-pulse',
  minScale = 0.18,
}: {
  // Whether audio is actually being captured. Idle bars run a CSS pulse instead
  // of a rAF, so nothing is scheduled when there's nothing to show.
  active: boolean
  // Set when the host provides its own bar styling (SwarmAgent surfaces);
  // omitted for the inline-styled TopBar/voice-widget rendering.
  className?: string
  pulseAnimation?: string
  minScale?: number
}) {
  const barsRef = useRef<(HTMLElement | null)[]>([])

  useEffect(() => {
    if (!active) {
      // Hand the bars back to the CSS pulse.
      for (const bar of barsRef.current) {
        if (bar) { bar.style.transform = ''; bar.style.animation = '' }
      }
      return
    }
    let raf = 0
    const tick = () => {
      const levels = readAudioLevels()
      for (let i = 0; i < barsRef.current.length; i++) {
        const bar = barsRef.current[i]
        if (!bar) continue
        bar.style.animation = 'none'
        bar.style.transform = `scaleY(${Math.max(minScale, levels[i] ?? 0)})`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, minScale])

  const idleStyle = (i: number): React.CSSProperties => ({
    transition: 'transform 55ms ease-out',
    animation: active ? 'none' : `${pulseAnimation} 0.55s ease-in-out ${i * 0.11}s infinite alternate`,
  })

  if (className) {
    return (
      <span className={className} aria-hidden>
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <i key={i} ref={el => { barsRef.current[i] = el }} style={idleStyle(i)} />
        ))}
      </span>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 14, flexShrink: 0 }} aria-hidden>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <div
          key={i}
          ref={el => { barsRef.current[i] = el }}
          style={{
            width: 3, height: 12, background: 'currentColor', borderRadius: 2,
            transformOrigin: 'center', ...idleStyle(i),
          }}
        />
      ))}
    </div>
  )
}
