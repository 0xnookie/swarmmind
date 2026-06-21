import React, { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { AGENT_META, AgentIcon } from '../data/agents'
import { useT, type TFunction } from '../i18n'

function relativeTime(ts: number, t: TFunction): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return t('time.justNow')
  if (s < 60) return t('time.secondsAgo', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('time.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgo', { n: h })
  return t('time.daysAgo', { n: Math.floor(h / 24) })
}

function IconBell() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

// Small square action button used inside a notification row.
function RowAction({ label, onClick, children, danger }: {
  label: string
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 24,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 5,
        border: 'none',
        cursor: 'pointer',
        background: hover ? 'var(--bg-base)' : 'transparent',
        color: hover ? (danger ? 'var(--error)' : 'var(--text-secondary)') : 'var(--text-muted)',
        transition: 'background 120ms, color 120ms',
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  )
}

export function NotificationCenter() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const notifications = useWorkspaceStore(s => s.notifications)
  const unreadCount = notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0)

  const markNotificationRead = useWorkspaceStore(s => s.markNotificationRead)
  const markPaneNotificationsRead = useWorkspaceStore(s => s.markPaneNotificationsRead)
  const markAllNotificationsRead = useWorkspaceStore(s => s.markAllNotificationsRead)
  const deleteNotification = useWorkspaceStore(s => s.deleteNotification)
  const clearNotifications = useWorkspaceStore(s => s.clearNotifications)
  const setActivePaneId = useWorkspaceStore(s => s.setActivePaneId)
  const setPaneAttention = useWorkspaceStore(s => s.setPaneAttention)

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const jumpToPane = (paneId: string) => {
    // Make the pane visible: close *every* center overlay (board/graph/timeline/
    // changes/checkpoints/review/benchmarks/loops/files/chat) — otherwise jumping
    // from, say, the timeline left the pane hidden behind it.
    useWorkspaceStore.getState().showTerminals()
    setActivePaneId(paneId)
    markPaneNotificationsRead(paneId)
    setPaneAttention(paneId, null)
    setOpen(false)
    // Defer so any overlay teardown has rendered the pane before we scroll.
    requestAnimationFrame(() => {
      document.getElementById(`pane-${paneId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        aria-label={t('notif.title')}
        title={t('notif.title')}
        onClick={() => setOpen(o => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: 28,
          height: 28,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          border: 'none',
          cursor: 'pointer',
          color: open || hovered ? 'var(--text-secondary)' : 'var(--text-muted)',
          background: open || hovered ? 'var(--bg-elevated)' : 'transparent',
          transition: 'background 150ms ease-out, color 150ms ease-out',
          position: 'relative',
        }}
      >
        <IconBell />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              minWidth: 14,
              height: 14,
              padding: '0 3px',
              borderRadius: 9999,
              background: '#ef4444',
              color: '#fff',
              fontSize: 9,
              fontWeight: 600,
              lineHeight: '14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1.5px solid var(--bg-base)',
            }}
          >
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 34,
            right: 0,
            width: 320,
            maxHeight: 420,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-strong)',
            borderRadius: 8,
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
            zIndex: 1000,
            overflow: 'hidden',
            WebkitAppRegion: 'no-drag',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('notif.title')}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={markAllNotificationsRead}
                disabled={unreadCount === 0}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  fontSize: 11,
                  cursor: unreadCount === 0 ? 'default' : 'pointer',
                  color: unreadCount === 0 ? 'var(--text-dim)' : 'var(--accent)',
                }}
              >
                {t('notif.markAllRead')}
              </button>
              <button
                onClick={clearNotifications}
                disabled={notifications.length === 0}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  fontSize: 11,
                  cursor: notifications.length === 0 ? 'default' : 'pointer',
                  color: notifications.length === 0 ? 'var(--text-dim)' : 'var(--text-muted)',
                }}
              >
                {t('notif.clearAll')}
              </button>
            </div>
          </div>

          {/* List */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {notifications.length === 0 ? (
              <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
                {t('notif.empty')}
              </div>
            ) : (
              notifications.map(n => {
                const meta = n.agentId ? AGENT_META[n.agentId] : null
                const label = n.paneTitle || meta?.label || t('notif.anAgent')
                return (
                  <div
                    key={n.id}
                    onClick={() => jumpToPane(n.paneId)}
                    title={t('notif.jump')}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '10px 12px',
                      borderBottom: '1px solid var(--border-subtle)',
                      cursor: 'pointer',
                      background: n.read ? 'transparent' : 'var(--bg-elevated)',
                    }}
                  >
                    {/* Unread dot / agent colour */}
                    {meta ? (
                      <span style={{ marginTop: 2, flexShrink: 0, opacity: n.read ? 0.45 : 1 }}>
                        <AgentIcon id={meta.id} size={15} title={meta.label} />
                      </span>
                    ) : (
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 9999,
                          marginTop: 5,
                          flexShrink: 0,
                          background: n.read ? 'var(--border-strong)' : 'var(--accent)',
                        }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: n.read ? 400 : 600,
                          color: 'var(--text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {label}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                        {t('notif.waiting')}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
                        {relativeTime(n.timestamp, t)}
                      </div>
                    </div>
                    {/* Row actions */}
                    <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                      <RowAction label={t('notif.jump')} onClick={() => jumpToPane(n.paneId)}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M7 17 17 7" /><path d="M9 7h8v8" />
                        </svg>
                      </RowAction>
                      {!n.read && (
                        <RowAction label={t('notif.markRead')} onClick={() => markNotificationRead(n.id)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        </RowAction>
                      )}
                      <RowAction label={t('common.delete')} danger onClick={() => deleteNotification(n.id)}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
                        </svg>
                      </RowAction>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
