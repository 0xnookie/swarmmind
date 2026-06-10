import React, { useEffect, useState } from 'react'
import { useT } from '../i18n'

// A small banner shown when an update finished downloading (offer restart) or
// while one is downloading. Stays silent for checking/none/available/error —
// the main process logs errors; background checks shouldn't nag the user.
export function UpdateBanner() {
  const t = useT()
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => window.swarmmind.onUpdateStatus(setStatus), [])

  if (status?.state === 'ready') {
    return (
      <div style={styles.banner} role="status">
        <span style={styles.text}>{t('update.ready', { version: status.version ?? '' })}</span>
        <button style={styles.primary} onClick={() => window.swarmmind.updateInstall()}>
          {t('update.restart')}
        </button>
        <button style={styles.dismiss} onClick={() => setStatus(null)} aria-label={t('update.dismiss')}>
          ×
        </button>
      </div>
    )
  }

  if (status?.state === 'downloading') {
    return (
      <div style={styles.banner} role="status">
        <span style={styles.text}>{t('update.downloading', { percent: status.percent ?? 0 })}</span>
      </div>
    )
  }

  return null
}

const styles: Record<string, React.CSSProperties> = {
  banner: {
    position: 'fixed',
    bottom: 16,
    right: 16,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--accent)',
    borderRadius: 8,
    padding: '10px 12px',
    boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
    fontSize: 13,
  },
  text: { whiteSpace: 'nowrap' },
  primary: {
    background: 'var(--accent)',
    color: '#1a1816',
    border: 'none',
    borderRadius: 6,
    padding: '5px 12px',
    cursor: 'pointer',
    fontWeight: 600,
  },
  dismiss: {
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    cursor: 'pointer',
    fontSize: 16,
    lineHeight: 1,
    padding: '0 2px',
  },
}
