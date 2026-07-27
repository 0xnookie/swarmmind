import React, { useState } from 'react'

// The TopBar's icon button — the shared look for every square icon control up
// there (sidebar toggle, canvas, code view, board, voice, …).
//
// It lives in its own module rather than inside TopBar so that components the
// TopBar *renders* can use it too without importing TopBar back (SwarmVoice
// does exactly that). Anything that hand-rolls its own button up here drifts:
// a different radius or a stray border is immediately visible next to the rest.

export interface IconBtnProps {
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
  style?: React.CSSProperties
  // Longer hover text when the accessible name isn't the whole story (e.g. the
  // voice button, which reports live dictation state). Defaults to `label`.
  title?: string
  // Set when the button toggles something that stays open, so assistive tech
  // reports the state rather than just the action.
  pressed?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}

export function IconBtn({
  label, onClick, active, disabled, children, style, title, pressed, onContextMenu,
}: IconBtnProps) {
  const [hovered, setHovered] = useState(false)
  const showActive = !disabled && (active || hovered)

  const baseStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    color: disabled ? 'var(--text-dim)' : showActive ? 'var(--text-secondary)' : 'var(--text-muted)',
    background: showActive ? 'var(--bg-elevated)' : 'transparent',
    opacity: disabled ? 0.4 : 1,
    transition: 'background 150ms ease-out, color 150ms ease-out',
    position: 'relative',
    ...style,
  }

  return (
    <button
      aria-label={label}
      title={title ?? label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      style={baseStyle}
      onClick={onClick}
      onContextMenu={onContextMenu}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  )
}
