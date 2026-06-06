import React, { useRef, useState, useCallback, useEffect } from 'react'
import { useWorkspaceStore } from '../store/workspace'

// Common local dev-server ports, surfaced as one-click presets since the
// built-in browser is mostly used to preview whatever an agent is running.
const DEV_PORTS = [3000, 5173, 8080, 4200, 8000, 5000, 3001, 4321]
const HOME_URL = 'http://localhost:3000'

function normalizeUrl(raw: string): string {
  const t = raw.trim()
  if (!t) return t
  if (/^https?:\/\//i.test(t)) return t
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d+\.\d+\.\d+\.\d+/.test(t)) return 'http://' + t
  // Bare port like ":5173" or "5173"
  if (/^:?\d{2,5}$/.test(t)) return 'http://localhost:' + t.replace(/^:/, '')
  return 'http://' + t
}

// Minimal shape of the methods/events we use off the <webview> element.
type WebviewEl = HTMLElement & {
  src: string
  loadURL: (url: string) => Promise<void>
  reload: () => void
  stop: () => void
  goBack: () => void
  goForward: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  getURL: () => string
  openDevTools: () => void
  closeDevTools: () => void
  isDevToolsOpened: () => boolean
}

export function PreviewPanel() {
  const previewUrl = useWorkspaceStore(s => s.previewUrl)
  const setPreviewUrl = useWorkspaceStore(s => s.setPreviewUrl)

  const webviewRef = useRef<WebviewEl | null>(null)
  const readyRef = useRef(false)
  const focusedRef = useRef(false)
  // The URL the webview first loads. Captured once so React re-renders never
  // reset `src` and retrigger a reload — subsequent navigation goes via loadURL.
  const initialUrlRef = useRef(previewUrl)

  const [inputUrl, setInputUrl] = useState(previewUrl)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const [error, setError] = useState<{ code: number; desc: string; url: string } | null>(null)
  const [portsOpen, setPortsOpen] = useState(false)

  const [width, setWidth] = useState(480)
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)

  // ── Resize ──
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragState.current) return
      const delta = dragState.current.startX - e.clientX
      setWidth(Math.max(280, Math.min(1200, dragState.current.startWidth + delta)))
    }
    const onMouseUp = () => { dragState.current = null; document.body.style.cursor = '' }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // ── Webview event wiring ──
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const syncNav = () => {
      try {
        setCanBack(wv.canGoBack())
        setCanFwd(wv.canGoForward())
      } catch { /* not ready */ }
    }
    const commitUrl = (url: string) => {
      if (!url || url === 'about:blank') return
      setPreviewUrl(url)
      if (!focusedRef.current) setInputUrl(url)
    }

    const onStartLoading = () => { setLoading(true); setError(null) }
    const onStopLoading = () => { setLoading(false); syncNav() }
    const onNavigate = (e: Event) => { commitUrl((e as unknown as { url: string }).url); syncNav() }
    const onNavigateInPage = (e: Event) => {
      const ev = e as unknown as { url: string; isMainFrame?: boolean }
      if (ev.isMainFrame === false) return
      commitUrl(ev.url); syncNav()
    }
    const onTitle = (e: Event) => setTitle((e as unknown as { title: string }).title || '')
    const onReady = () => { readyRef.current = true; syncNav() }
    const onFail = (e: Event) => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame?: boolean }
      // -3 == ERR_ABORTED (e.g. a superseded navigation); ignore. Ignore subframes.
      if (ev.errorCode === -3 || ev.isMainFrame === false) return
      setLoading(false)
      setError({ code: ev.errorCode, desc: ev.errorDescription, url: ev.validatedURL })
    }
    const onDevtoolsOpened = () => setDevtoolsOpen(true)
    const onDevtoolsClosed = () => setDevtoolsOpen(false)

    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigateInPage)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('devtools-opened', onDevtoolsOpened)
    wv.addEventListener('devtools-closed', onDevtoolsClosed)

    return () => {
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigateInPage)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-fail-load', onFail)
      wv.removeEventListener('devtools-opened', onDevtoolsOpened)
      wv.removeEventListener('devtools-closed', onDevtoolsClosed)
    }
  }, [setPreviewUrl])

  // ── Navigation ──
  const navigate = useCallback((rawUrl: string) => {
    const target = normalizeUrl(rawUrl)
    if (!target) return
    setInputUrl(target)
    setPreviewUrl(target)
    setError(null)
    const wv = webviewRef.current
    if (wv && readyRef.current) {
      wv.loadURL(target).catch(() => {})
    } else if (wv) {
      wv.src = target
    }
  }, [setPreviewUrl])

  const handleReloadOrStop = () => {
    const wv = webviewRef.current
    if (!wv) return
    if (loading) wv.stop()
    else wv.reload()
  }

  const toggleDevtools = () => {
    const wv = webviewRef.current
    if (!wv) return
    try {
      if (wv.isDevToolsOpened()) wv.closeDevTools()
      else wv.openDevTools()
    } catch { /* not ready */ }
  }

  // window.open is intercepted by the main window's setWindowOpenHandler, which
  // routes it to shell.openExternal — so this opens the system browser.
  const openExternal = () => { if (inputUrl) window.open(normalizeUrl(inputUrl), '_blank') }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); navigate(inputUrl) }
    else if (e.key === 'Escape') { setInputUrl(previewUrl); (e.target as HTMLInputElement).blur() }
  }

  // Close the ports menu on outside click
  useEffect(() => {
    if (!portsOpen) return
    const close = () => setPortsOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [portsOpen])

  return (
    <div style={{ ...styles.panel, width }}>
      <div
        style={styles.resizeHandle}
        onMouseDown={e => {
          dragState.current = { startX: e.clientX, startWidth: width }
          document.body.style.cursor = 'col-resize'
          e.preventDefault()
        }}
      />

      {/* ── Toolbar ── */}
      <div style={styles.toolbar}>
        <button className="pane-action-btn" aria-label="Back" disabled={!canBack} onClick={() => webviewRef.current?.goBack()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 5-7 7 7 7"/></svg>
        </button>
        <button className="pane-action-btn" aria-label="Forward" disabled={!canFwd} onClick={() => webviewRef.current?.goForward()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        </button>
        <button className="pane-action-btn" aria-label={loading ? 'Stop' : 'Reload'} onClick={handleReloadOrStop}>
          {loading ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          )}
        </button>
        <button className="pane-action-btn" aria-label="Home" onClick={() => navigate(HOME_URL)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        </button>

        <input
          style={styles.urlInput}
          value={inputUrl}
          onChange={e => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={e => { focusedRef.current = true; e.target.select() }}
          onBlur={() => { focusedRef.current = false }}
          spellCheck={false}
          placeholder="localhost:3000"
          aria-label="URL"
        />

        {/* Dev-port presets */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            className="pane-action-btn"
            aria-label="Dev ports"
            title="Local dev ports"
            onClick={e => { e.stopPropagation(); setPortsOpen(o => !o) }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
          </button>
          {portsOpen && (
            <div style={styles.portsMenu} onClick={e => e.stopPropagation()}>
              {DEV_PORTS.map(p => (
                <button
                  key={p}
                  className="preview-port-item"
                  onClick={() => { setPortsOpen(false); navigate('http://localhost:' + p) }}
                >
                  <span className="port-host">localhost:</span><span>{p}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="pane-action-btn" aria-label="Open in browser" title="Open in system browser" onClick={openExternal}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        </button>
        <button
          className="pane-action-btn"
          aria-label="Toggle DevTools"
          title="Toggle DevTools for the page"
          onClick={toggleDevtools}
          style={devtoolsOpen ? { color: 'var(--accent)' } : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>

        {loading && <div className="preview-loadbar" />}
      </div>

      {/* Page title strip */}
      {title && !error && (
        <div style={styles.titleStrip} title={title}>{title}</div>
      )}

      {/* ── Webview + error overlay ── */}
      <div style={styles.viewWrap}>
        {/* @ts-ignore - webview is an Electron custom element */}
        <webview ref={webviewRef as any} src={initialUrlRef.current} style={styles.webview} />

        {error && (
          <div style={styles.errorOverlay}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <div style={styles.errorTitle}>Couldn’t load this page</div>
            <div style={styles.errorUrl}>{error.url || inputUrl}</div>
            <div style={styles.errorDesc}>{error.desc || `Error ${error.code}`}{error.code ? `  ·  ${error.code}` : ''}</div>
            <div style={styles.errorHint}>If this is a local dev server, make sure it’s running.</div>
            <button style={styles.retryBtn} onClick={() => navigate(error.url || inputUrl)}>Retry</button>
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-panel)',
    borderLeft: '1px solid var(--border)',
    overflow: 'hidden',
    position: 'relative',
  },
  resizeHandle: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 5,
    cursor: 'col-resize',
    zIndex: 10,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '6px 8px',
    borderBottom: '1px solid var(--border-subtle)',
    background: 'var(--bg-panel)',
    flexShrink: 0,
    position: 'relative',
  },
  urlInput: {
    flex: 1,
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: 12,
    padding: '5px 11px',
    margin: '0 4px',
    outline: 'none',
    minWidth: 0,
    transition: 'border-color 150ms',
  },
  portsMenu: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-lg)',
    padding: '4px 0',
    zIndex: 1000,
    minWidth: 150,
  },
  titleStrip: {
    flexShrink: 0,
    padding: '3px 12px',
    fontSize: 11,
    color: 'var(--text-muted)',
    background: 'var(--bg-base)',
    borderBottom: '1px solid var(--border-subtle)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  viewWrap: {
    flex: 1,
    position: 'relative',
    minHeight: 0,
    background: 'var(--bg-base)',
  },
  webview: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    border: 'none',
  },
  errorOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 24,
    textAlign: 'center',
    background: 'var(--bg-base)',
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginTop: 6,
  },
  errorUrl: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    wordBreak: 'break-all',
    maxWidth: '90%',
  },
  errorDesc: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  errorHint: {
    fontSize: 11.5,
    color: 'var(--text-dim)',
    marginTop: 2,
  },
  retryBtn: {
    marginTop: 12,
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    border: '1px solid rgba(212,132,90,0.25)',
    borderRadius: 'var(--radius)',
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 18px',
    cursor: 'pointer',
  },
}
