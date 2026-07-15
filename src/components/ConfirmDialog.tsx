import React, { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useT } from '../i18n'

// ── App-styled replacement for window.confirm ─────────────────────────────────
// window.confirm renders a native OS dialog that ignores the app's theme. This
// module provides a promise-based drop-in: `await confirmDialog({ body })`
// resolves true/false. The single <ConfirmDialogHost /> mounted in App.tsx
// renders whatever confirmation is pending, styled like the rest of the app.

export interface ConfirmOptions {
  /** Dialog heading. Defaults to t('confirm.title'). */
  title?: string
  /** Message body. Strings render with newlines preserved. */
  body: React.ReactNode
  /** Confirm button label. Defaults to t('common.confirm'). */
  confirmLabel?: string
  /** Cancel button label. Defaults to t('common.cancel'). */
  cancelLabel?: string
  /** Destructive action → red confirm button instead of accent. */
  danger?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

const useConfirmStore = create<{ pending: PendingConfirm | null }>(() => ({
  pending: null,
}))

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // A newly requested dialog replaces (and cancels) any one still open.
    useConfirmStore.getState().pending?.resolve(false)
    useConfirmStore.setState({ pending: { ...opts, resolve } })
  })
}

export function ConfirmDialogHost() {
  const t = useT()
  const pending = useConfirmStore((s) => s.pending)
  const [hoverConfirm, setHoverConfirm] = useState(false)
  const [hoverCancel, setHoverCancel] = useState(false)

  const settle = (ok: boolean) => {
    setHoverConfirm(false)
    setHoverCancel(false)
    pending?.resolve(ok)
    useConfirmStore.setState({ pending: null })
  }

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        pending.resolve(false)
        useConfirmStore.setState({ pending: null })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending])

  if (!pending) return null

  const danger = pending.danger ?? false
  const confirmBorder = danger ? 'var(--error)' : 'var(--accent)'
  const confirmIdleColor = danger ? 'var(--error)' : 'var(--accent)'
  const confirmHoverBg = danger ? 'var(--error)' : 'var(--accent)'
  const confirmHoverColor = danger ? '#fff' : 'var(--accent-fg)'

  return (
    <div
      onClick={() => settle(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380, maxWidth: 'calc(100vw - 48px)',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 10, padding: 20, boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          {pending.title ?? t('confirm.title')}
        </div>
        <div
          style={{
            fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5,
            whiteSpace: typeof pending.body === 'string' ? 'pre-wrap' : undefined,
            maxHeight: '50vh', overflowY: 'auto',
          }}
        >
          {pending.body}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={() => settle(false)}
            onMouseEnter={() => setHoverCancel(true)}
            onMouseLeave={() => setHoverCancel(false)}
            style={{
              padding: '7px 14px', fontSize: 13, fontFamily: 'inherit', borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--border)',
              background: hoverCancel ? 'var(--bg-elevated-2)' : 'transparent',
              color: 'var(--text-secondary)',
            }}
          >
            {pending.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            autoFocus
            onClick={() => settle(true)}
            onMouseEnter={() => setHoverConfirm(true)}
            onMouseLeave={() => setHoverConfirm(false)}
            style={{
              padding: '7px 14px', fontSize: 13, fontFamily: 'inherit', fontWeight: 600, borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${confirmBorder}`,
              background: hoverConfirm ? confirmHoverBg : 'transparent',
              color: hoverConfirm ? confirmHoverColor : confirmIdleColor,
            }}
          >
            {pending.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
