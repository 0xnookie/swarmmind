import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useWorkspaceStore } from '../store/workspace'
import { monoFontStack, ANSI_DEFAULT, TERM_ANSI_KEYS, termAnsiVar } from '../appearance'
import { useT } from '../i18n'
import '@xterm/xterm/css/xterm.css'

// The "connect account" terminal: an overlay that runs an agent CLI's own login
// flow (browser OAuth) against an isolated profile dir. Deliberately NOT a pane —
// it's a transient utility terminal with no workspace, scrollback persistence, or
// activity tracking, so it talks to the generic pty IPC directly rather than
// going through usePty.

interface LoginTerminalProps {
  agentId: string
  agentLabel: string
  accountId: string
  profileDir: string
  onClose: () => void
}

export function LoginTerminal({ agentId, agentLabel, accountId, profileDir, onClose }: LoginTerminalProps) {
  const t = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const paneId = `login:${accountId}`
  const [exited, setExited] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const cs = getComputedStyle(document.documentElement)
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
    const ansi: Record<string, string> = {}
    for (const k of TERM_ANSI_KEYS) ansi[k] = v(termAnsiVar(k), ANSI_DEFAULT[k])

    const term = new Terminal({
      theme: {
        ...ANSI_DEFAULT,
        ...ansi,
        background: v('--bg-terminal', '#121110'),
        foreground: v('--text-primary', '#ece7e0'),
        cursor: v('--accent', '#d4845a'),
      },
      fontSize: useWorkspaceStore.getState().terminalFontSize,
      fontFamily: monoFontStack(useWorkspaceStore.getState().monoFont),
      cursorBlink: true,
      scrollback: 2000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    const offOutput = window.swarmmind.onPtyOutput((id, data) => {
      if (id === paneId) term.write(data)
    })
    const offExit = window.swarmmind.onPtyExit((id) => {
      if (id === paneId) setExited(true)
    })
    const dataSub = term.onData(data => window.swarmmind.ptyInput(paneId, data))

    const shellStyle = useWorkspaceStore.getState().shellStyle
    window.swarmmind.ptyCreateLogin(paneId, agentId, profileDir, shellStyle, term.cols, term.rows)
      .then(res => { if (res?.error) setError(res.error) })
      .catch(err => setError(String(err)))

    const onResize = () => {
      fit.fit()
      window.swarmmind.ptyResize(paneId, term.cols, term.rows)
    }
    window.addEventListener('resize', onResize)
    // Initial size after first fit.
    window.swarmmind.ptyResize(paneId, term.cols, term.rows)
    term.focus()

    return () => {
      window.removeEventListener('resize', onResize)
      offOutput()
      offExit()
      dataSub.dispose()
      term.dispose()
      // Kill silently: closing the overlay ends the login session.
      window.swarmmind.ptyKill(paneId, true).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, agentId, profileDir])

  return (
    <div style={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={styles.modal} role="dialog" aria-modal="true" aria-label={t('login.title', { agent: agentLabel })}>
        <div style={styles.header}>
          <div style={{ minWidth: 0 }}>
            <h3 style={styles.title}>{t('login.title', { agent: agentLabel })}</h3>
            <p style={styles.hint}>{exited ? t('login.exited') : t('login.hint')}</p>
          </div>
          <button style={styles.doneBtn} onClick={onClose}>
            {t('login.done')}
          </button>
        </div>
        {error
          ? <div style={styles.error}>{error}</div>
          : <div ref={containerRef} style={styles.term} />}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2100, // above the settings modal (2000)
  },
  modal: {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    width: 680,
    maxWidth: '90vw',
    height: 460,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  title: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  hint: { fontSize: 11, color: 'var(--text-dim)', marginTop: 2 },
  doneBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--accent-fg)',
    padding: '6px 16px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    flexShrink: 0,
  },
  term: { flex: 1, minHeight: 0, padding: '6px 0 0 8px', background: 'var(--bg-terminal)' },
  error: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--warning)',
    fontSize: 12,
    padding: 20,
    textAlign: 'center',
  },
}
