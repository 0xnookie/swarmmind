import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import type { AgentId, ShellStyle } from '../store/workspace'
import { useWorkspaceStore } from '../store/workspace'
import { monoFontStack, ANSI_DEFAULT, TERM_ANSI_KEYS, termAnsiVar } from '../appearance'

// Fixed semantic ANSI palette — these don't change with the theme. The
// background/foreground/cursor/selection colours are read live from the CSS
// variables so the terminal tracks the active appearance.
// Read the appearance-driven terminal colours from the document root CSS vars.
// Both the foreground/background set and the 16-colour ANSI palette are theme
// vars published by applyAppearance(), so themes (incl. light ones) restyle the
// terminal without any hardcoded palette here.
function readTermTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  const ansi: Record<string, string> = {}
  for (const k of TERM_ANSI_KEYS) ansi[k] = v(termAnsiVar(k), ANSI_DEFAULT[k])
  return {
    background: v('--bg-terminal', '#121110'),
    foreground: v('--text-primary', '#ece7e0'),
    cursor: v('--accent', '#d4845a'),
    cursorAccent: v('--bg-terminal', '#121110'),
    selectionBackground: v('--accent-glow', 'rgba(212,132,90,0.28)'),
    ...ansi,
  }
}

// Raw PTY output cache — keyed by paneId, survives component unmount/remount
// so terminal content is preserved when switching workspaces.
const rawOutputCache = new Map<string, string>()
const MAX_CACHE_BYTES = 102_400 // 100 KB per pane

function appendToCache(paneId: string, data: string): void {
  const current = rawOutputCache.get(paneId) ?? ''
  const next = current + data
  rawOutputCache.set(paneId, next.length > MAX_CACHE_BYTES ? next.slice(-MAX_CACHE_BYTES) : next)
}

// Debounced persistence of a pane's scrollback to disk so it survives an app
// restart (handled in the main process under the workspace's .swarmmind dir).
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleScrollbackSave(paneId: string): void {
  const existing = saveTimers.get(paneId)
  if (existing) clearTimeout(existing)
  saveTimers.set(paneId, setTimeout(() => {
    saveTimers.delete(paneId)
    const data = rawOutputCache.get(paneId)
    if (data != null) window.swarmmind.scrollbackSave(paneId, data).catch(() => {})
  }, 2500))
}

// Strip ANSI escape / control sequences so piped terminal text is readable.
// Covers CSI (colours/cursor), OSC (window title), and carriage returns.
// Built via RegExp from string escapes so the source stays pure ASCII.
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp('\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\r', 'g')
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

interface UsePtyOptions {
  // Called when the pane's process exits. When provided, the caller fully owns
  // the exit reaction (e.g. respawning a shell); the default "[process exited]"
  // line and status update are skipped.
  onExit?: (code: number) => void
}

export function usePty(paneId: string, containerRef: React.RefObject<HTMLDivElement>, opts?: UsePtyOptions) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const setPtyStatus = useWorkspaceStore(s => s.setPtyStatus)
  const terminalFontSize = useWorkspaceStore(s => s.terminalFontSize)
  const terminalCursorBlink = useWorkspaceStore(s => s.terminalCursorBlink)
  const monoFont = useWorkspaceStore(s => s.monoFont)
  const appearanceVersion = useWorkspaceStore(s => s.appearanceVersion)
  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts })

  useEffect(() => {
    if (!containerRef.current) return

    // Read display prefs at creation time from the store so a freshly-opened
    // pane honours the user's saved font size / cursor settings. Live changes
    // are applied by the effect below without recreating the terminal.
    const { terminalFontSize: initialFontSize, terminalCursorBlink: initialBlink, monoFont: initialMono } =
      useWorkspaceStore.getState()

    const term = new Terminal({
      theme: { ...ANSI_DEFAULT, ...readTermTheme() },
      fontSize: initialFontSize,
      fontFamily: monoFontStack(initialMono),
      fontWeight: '400',
      lineHeight: 1.15,
      cursorBlink: initialBlink,
      cursorStyle: 'block',
      scrollback: 5000,
      allowTransparency: false,
      overviewRulerWidth: 0
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    const searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.loadAddon(searchAddon)
    searchAddonRef.current = searchAddon
    term.open(containerRef.current)

    // Fit immediately after open so term.cols/rows reflect the actual container
    // dimensions right away — before any ResizeObserver or timer fires.
    // Without this, xterm defaults to 80×24 until the first async fit runs,
    // which causes the PTY to be spawned with wrong dimensions if auto-spawn
    // fires before the ResizeObserver RAF (~16 ms) completes.
    try { fitAddon.fit() } catch { /* ignore: container may have zero size on first paint */ }

    // Replay cached output from previous mount (e.g. after workspace switch).
    // If there's no in-memory cache, restore persisted scrollback from a prior
    // app session (a fresh agent spawn clears it again, so this only surfaces for
    // panes that aren't immediately re-spawned).
    const cached = rawOutputCache.get(paneId)
    if (cached) {
      term.write(cached)
    } else {
      window.swarmmind.scrollbackLoad(paneId).then(saved => {
        if (saved && !rawOutputCache.get(paneId) && termRef.current === term) {
          term.write(saved)
          rawOutputCache.set(paneId, saved)
        }
      }).catch(() => {})
    }

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Send keystrokes to PTY
    const inputDispose = term.onData(data => {
      window.swarmmind.ptyInput(paneId, data)
    })

    // Receive PTY output
    const unsubOutput = window.swarmmind.onPtyOutput((id, data) => {
      if (id === paneId) {
        term.write(data)
        appendToCache(paneId, data)
        scheduleScrollbackSave(paneId)
      }
    })

    // Track PTY exit
    const unsubExit = window.swarmmind.onPtyExit((id, code) => {
      if (id !== paneId) return
      if (optsRef.current?.onExit) {
        optsRef.current.onExit(code)
      } else {
        setPtyStatus(paneId, 'exited')
        term.writeln(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m`)
      }
    })

    let rafHandle = 0

    const doFit = () => {
      try {
        fitAddon.fit()
        window.swarmmind.ptyResize(paneId, term.cols, term.rows)
      } catch { /* ignore resize errors during unmount */ }
    }

    // Resize terminal when container changes. RAF defers to after layout paint.
    // Cancel any previously queued RAF so we never call fit() on a disposed terminal.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafHandle)
      rafHandle = requestAnimationFrame(doFit)
    })
    observer.observe(containerRef.current)

    // Retries cover: (a) font not yet loaded at initial observation, (b) flex
    // layout still settling. 100 ms is the most critical; 300 ms and 600 ms
    // are safety nets. fonts.ready fires once all @font-face rules are done.
    const t1 = setTimeout(doFit, 100)
    const t2 = setTimeout(doFit, 300)
    const t3 = setTimeout(doFit, 600)
    document.fonts.ready.then(doFit)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(t3)
      cancelAnimationFrame(rafHandle)
      inputDispose.dispose()
      unsubOutput()
      unsubExit()
      observer.disconnect()
      try { term.dispose() } catch { /* xterm can throw during disposal if a resize was in-flight */ }
      termRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
    }
  }, [paneId])

  // Apply display-preference changes live without tearing down the terminal.
  // Font-size changes the cell metrics, so we re-fit and push the new dims to
  // the PTY; cursor-blink takes effect immediately.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = terminalFontSize
    term.options.cursorBlink = terminalCursorBlink
    term.options.fontFamily = monoFontStack(monoFont)
    // appearanceVersion is in the dep list so theme/accent changes re-read the
    // CSS variables; the read happens after the new vars are applied.
    term.options.theme = { ...ANSI_DEFAULT, ...readTermTheme() }
    const h = requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit()
        window.swarmmind.ptyResize(paneId, term.cols, term.rows)
      } catch { /* ignore if container not yet sized */ }
    })
    return () => cancelAnimationFrame(h)
  }, [terminalFontSize, terminalCursorBlink, monoFont, appearanceVersion, paneId])

  const findNext = useCallback((q: string) => { try { searchAddonRef.current?.findNext(q) } catch { /* ignore */ } }, [])
  const findPrevious = useCallback((q: string) => { try { searchAddonRef.current?.findPrevious(q) } catch { /* ignore */ } }, [])
  const clearSearch = useCallback(() => { try { searchAddonRef.current?.clearDecorations() } catch { /* ignore */ } }, [])

  const spawn = useCallback(async (agentId: AgentId, cwd: string, shellStyle: ShellStyle = 'powershell', taskContext?: string, resume = false, sessionId?: string, workspaceId?: string) => {
    rawOutputCache.delete(paneId)
    termRef.current?.clear()
    termRef.current?.writeln(`\x1b[2m[${resume ? 'resuming' : 'spawning'} ${agentId} in ${cwd}]\x1b[0m\r\n`)
    const cols = termRef.current?.cols ?? 120
    const rows = termRef.current?.rows ?? 30
    const result = await window.swarmmind.ptyCreate(paneId, agentId, cwd, shellStyle, taskContext, cols, rows, resume, sessionId, workspaceId)
    if (result?.error) {
      termRef.current?.writeln(`\x1b[31m[error: ${result.error}]\x1b[0m`)
    }
  }, [paneId])

  const kill = useCallback(async () => {
    await window.swarmmind.ptyKill(paneId)
  }, [paneId])

  const clear = useCallback(() => {
    rawOutputCache.delete(paneId)
    termRef.current?.clear()
  }, [paneId])

  const fit = useCallback(() => {
    try { fitAddonRef.current?.fit() } catch { /* ignore if container not yet sized */ }
  }, [])

  // Move keyboard focus into this pane's terminal. Used when a fullscreen tab
  // becomes visible so typing lands in the newly-shown pane without a click.
  const focus = useCallback(() => {
    try { termRef.current?.focus() } catch { /* terminal may be mid-dispose */ }
  }, [])

  // Spawn a plain interactive shell in `cwd` (no agent). Output is appended
  // below whatever is already on screen — like a normal terminal prompt — so a
  // shell that follows an exited agent doesn't wipe the agent's final output.
  const spawnShell = useCallback(async (cwd: string, shellStyle: ShellStyle = 'powershell') => {
    const cols = termRef.current?.cols ?? 120
    const rows = termRef.current?.rows ?? 30
    const result = await window.swarmmind.ptyCreateShell(paneId, cwd, shellStyle, cols, rows)
    if (result?.error) {
      termRef.current?.writeln(`\x1b[31m[shell error: ${result.error}]\x1b[0m`)
    }
  }, [paneId])

  // Inject text as if the user typed it (used by skill drag-and-drop, broadcast)
  const injectText = useCallback((text: string) => {
    window.swarmmind.ptyInput(paneId, text)
  }, [paneId])

  // Write a dimmed status line to the terminal display (not to the process
  // input) — used for worktree setup notices and similar.
  const writeNotice = useCallback((msg: string) => {
    termRef.current?.writeln(`\x1b[2m[${msg}]\x1b[0m`)
  }, [])

  // Current text selection in this pane's terminal (empty string if none).
  const getSelection = useCallback(() => termRef.current?.getSelection() ?? '', [])

  // Recent terminal output for this pane, ANSI-stripped, trimmed to maxChars.
  const getRecentOutput = useCallback((maxChars = 4000) => {
    const raw = rawOutputCache.get(paneId) ?? ''
    const text = stripAnsi(raw).replace(/\n{3,}/g, '\n\n').trimEnd()
    return text.length > maxChars ? text.slice(-maxChars) : text
  }, [paneId])

  return { spawn, spawnShell, kill, clear, fit, focus, injectText, writeNotice, getSelection, getRecentOutput, findNext, findPrevious, clearSearch }
}
