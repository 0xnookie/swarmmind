import * as pty from 'node-pty'
import { BrowserWindow, Notification } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { type AgentId } from '../memory/queries'
import { readAgentConfig } from './agent-config'
import { getMcpPort, getMcpToken } from '../mcp/server'
import { eventEmit } from '../memory/events'
import { startPaneWatcher, stopPaneWatcher, stopAllWatchers } from './file-watcher'

export type PtyStatus = 'idle' | 'running' | 'exited'
export type ShellStyle = 'powershell' | 'cmd' | 'bash'

export function resolveSpawn(cmd: string, shellStyle: ShellStyle): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    switch (shellStyle) {
      case 'powershell':
        return { file: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', cmd] }
      case 'cmd':
        return { file: 'cmd.exe', args: ['/k', cmd] }
      case 'bash':
        return { file: 'bash.exe', args: ['-i', '-c', cmd] }
    }
  }
  // Non-Windows: run through a shell so quoted args and paths with spaces in
  // `cmd` survive (a naive whitespace split would mangle them).
  return { file: process.env.SHELL || '/bin/sh', args: ['-c', cmd] }
}

// Bare interactive shell (no agent command) — used to give an idle pane a real
// working prompt in its cwd, like a normal Linux/macOS terminal.
export function resolveShellSpawn(shellStyle: ShellStyle): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    switch (shellStyle) {
      case 'powershell': return { file: 'powershell.exe', args: ['-NoLogo'] }
      case 'cmd':        return { file: 'cmd.exe', args: [] }
      case 'bash':       return { file: 'bash.exe', args: ['-i'] }
    }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-i'] }
}

interface PtyEntry {
  process: pty.IPty
  status: PtyStatus
  // Set when the process is being killed to make room for a replacement (e.g.
  // spawning an agent over an idle shell). Suppresses the pty:exit event so the
  // renderer doesn't treat it as the process ending and respawn a shell.
  replaced: boolean
  // For coding-agent ptys (not bare shells): activity tracking so we can tell the
  // renderer when an agent is working vs has gone quiet (finished / awaiting input).
  agentId?: AgentId
  activity?: 'working' | 'waiting'
  idleTimer?: ReturnType<typeof setTimeout>
  // True once the user (or a broadcast) has sent input to this agent. We don't
  // fire the "waiting for input" OS notification before this — a freshly spawned
  // agent sitting at its prompt hasn't been given any work to wait on yet.
  hadInput?: boolean
  // Rolling tail of recent terminal output, ANSI-stripped. When the agent goes
  // quiet we scan this to decide whether it's *asking a question* (notify) vs
  // just finishing a turn (stay silent). Capped to the last screenful-ish.
  recentOutput?: string
  // The active workspace this pane belongs to, captured at spawn. Lets the pty
  // manager log swarm events (spawn/exit/question/cost) attributed to the pane.
  workspaceId?: string
  // Last cumulative cost (USD) parsed from this agent's output, so we only emit a
  // `cost` event when the figure actually advances.
  lastCostUsd?: number
}

// ── Cost parsing ─────────────────────────────────────────────────────────────
// Best-effort: many coding CLIs print a running spend figure (Claude Code's
// `/cost`, status lines, end-of-turn summaries). We scan the ANSI-stripped tail
// for the *last* cost figure and treat it as the session's cumulative total.
// Conservative on purpose — a bare "$5" in code shouldn't register, so we only
// accept amounts attached to the word "cost" or written with cents.
const COST_PATTERNS: RegExp[] = [
  /total cost:?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/gi,
  /\bcost:?\s*\$\s*([0-9]+(?:\.[0-9]+)?)/gi,
  /\$\s?([0-9]+\.[0-9]{2,})\b/g,
]

function parseCostUsd(text: string): number | null {
  const tail = text.slice(-2000)
  let best: number | null = null
  for (const re of COST_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(tail)) !== null) {
      const v = parseFloat(m[1])
      if (Number.isFinite(v)) best = v // keep the last (most recent) match
    }
    if (best !== null) break // prefer the more specific patterns first
  }
  return best
}

function parseTokens(text: string): number | null {
  const m = /([0-9][0-9,]{2,})\s*tokens/i.exec(text.slice(-2000))
  if (!m) return null
  const v = parseInt(m[1].replace(/,/g, ''), 10)
  return Number.isFinite(v) ? v : null
}

// ── Question detection ──────────────────────────────────────────────────────
// An agent going quiet doesn't mean it needs you — it usually just finished its
// turn. We only want to interrupt with a notification when it's actually waiting
// on an answer: a permission prompt, a y/n, or a selection menu. These patterns
// match the interactive prompts Claude Code (and most CLIs) draw at the bottom
// of the screen when they're blocked on the user.
const QUESTION_PATTERNS: RegExp[] = [
  /\bdo you want\b/i,
  /\bwould you like\b/i,
  /\bdo you wish to\b/i,
  /\b(proceed|continue|overwrite|confirm|replace)\?/i,
  /\bare you sure\b/i,
  /\bpress enter to (continue|confirm)/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\[y\/N\]/,
  /\[Y\/n\]/,
  /\(yes\/no\)/i,
  /❯\s*\d+\.\s/,   // selection menu: arrow + numbered choice (Claude permission dialogs)
]

// Strip ANSI/VT escape sequences so the regexes match the visible text only.
const ANSI_RE = /[][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-Za-ln-~]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

function looksLikeQuestion(recent: string): boolean {
  // Only inspect the tail: an interactive prompt is the last thing the agent
  // draws, so a question from earlier in the session that's already been answered
  // won't linger and cause a false notification.
  const tail = recent.slice(-1200)
  return QUESTION_PATTERNS.some(re => re.test(tail))
}

const processes = new Map<string, PtyEntry>()

// How long an agent's output must stay silent before we treat it as "waiting".
// Configurable via the `agentIdleMs` app setting (Settings → General).
let agentIdleMs = 4000
export function setAgentIdleMs(ms: number): void {
  if (Number.isFinite(ms) && ms >= 500) agentIdleMs = ms
}

// ── Agent launch configuration ────────────────────────────────────────────────

const AGENT_DEFAULTS: Record<AgentId, { cmd: string; args: string[] }> = {
  claude:    { cmd: 'claude',    args: [] },
  codex:     { cmd: 'codex',     args: [] },
  cursor:    { cmd: 'cursor',    args: ['.'] },
  windsurf:  { cmd: 'windsurf',  args: ['.'] },
  kilo:      { cmd: 'kilo',      args: [] },
  opencode:  { cmd: 'opencode',  args: [] },
  cline:     { cmd: 'cline',     args: [] }
}

// Args that replace an agent's default args to resume its most recent
// conversation in the cwd. Agents absent from this map have no conversational
// resume (e.g. cursor/windsurf launch an IDE), so they fall back to a fresh
// relaunch. These invocations are best-effort and may need adjusting as the
// individual CLIs evolve.
const AGENT_RESUME_ARGS: Partial<Record<AgentId, string[]>> = {
  claude:    ['--continue'],
  codex:     ['resume', '--last'],
  opencode:  ['--continue']
}

// Compute the launch args for an agent.
//
// Claude Code supports a caller-chosen session id, which lets each pane own a
// distinct conversation: we start fresh with `--session-id <id>` and later
// resume exactly that pane's session with `--resume <id>`. Both are
// non-interactive (no session picker), so resume is fully automatic.
//
// Other agents have no per-session id we control here, so on resume we fall back
// to their "continue last conversation" invocation (AGENT_RESUME_ARGS); agents
// absent from that map relaunch fresh.
function buildLaunchArgs(agentId: AgentId, resume: boolean, sessionId: string | undefined, defaultArgs: string[]): string[] {
  if (agentId === 'claude' && sessionId) {
    return resume ? ['--resume', sessionId] : ['--session-id', sessionId]
  }
  if (resume && AGENT_RESUME_ARGS[agentId]) return [...AGENT_RESUME_ARGS[agentId]!]
  return [...defaultArgs]
}

function injectMcpConfig(agentId: AgentId, cwd: string, mcpUrl: string): void {
  const sseUrl = `${mcpUrl}/mcp/sse?token=${getMcpToken()}`

  if (agentId === 'claude') {
    const claudeDir = join(cwd, '.claude')
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true })
    const settingsPath = join(claudeDir, 'settings.json')
    let settings: Record<string, unknown> = {}
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* ignore */ }
    }
    const mcpServers = (settings.mcpServers as Record<string, unknown>) ?? {}
    mcpServers['swarmmind'] = { type: 'sse', url: sseUrl }
    settings.mcpServers = mcpServers
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  }

  if (agentId === 'opencode') {
    const dir = join(cwd, '.opencode')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const cfgPath = join(dir, 'config.json')
    let cfg: Record<string, unknown> = {}
    if (existsSync(cfgPath)) {
      try { cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) } catch { /* ignore */ }
    }
    const mcpServers = (cfg.mcpServers as Record<string, unknown>) ?? {}
    mcpServers['swarmmind'] = { type: 'sse', url: sseUrl }
    cfg.mcpServers = mcpServers
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  }

  // Cursor/Windsurf use a global MCP config in user home
  if (agentId === 'cursor' || agentId === 'windsurf') {
    const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
    const appName = agentId === 'cursor' ? 'Cursor' : 'Windsurf'
    const cfgDir = join(home, '.config', appName, 'User')
    const settingsPath = join(cfgDir, 'settings.json')
    if (existsSync(cfgDir)) {
      let settings: Record<string, unknown> = {}
      if (existsSync(settingsPath)) {
        try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* ignore */ }
      }
      const key = `${agentId}.mcp.servers` as string
      settings[key] = { swarmmind: { url: sseUrl } }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Wire a freshly spawned pty's I/O to the renderer and register it. When
// `agentId` is set (coding agent, not a bare shell) we also track activity and
// emit `pty:state` ('working'/'waiting'), notifying the OS when an agent goes
// quiet while the window is unfocused.
function attachPty(paneId: string, ptyProcess: pty.IPty, win: BrowserWindow, agentId?: AgentId, workspaceId?: string): void {
  const entry: PtyEntry = { process: ptyProcess, status: 'running', replaced: false, agentId, workspaceId }

  const setState = (state: 'working' | 'waiting') => {
    if (entry.activity === state) return
    entry.activity = state
    if (!win.isDestroyed()) win.webContents.send('pty:state', paneId, state)
    // Going quiet alone isn't worth interrupting the user over — that's just the
    // agent finishing a turn. Only raise a notification when it's actually
    // blocked on an answer (permission prompt, y/n, selection menu).
    if (state === 'waiting' && entry.hadInput && looksLikeQuestion(entry.recentOutput ?? '')) {
      // Surface it in the in-app notification center (bell) regardless of focus.
      if (!win.isDestroyed()) win.webContents.send('pty:attention', paneId)
      // Log it to the swarm timeline so "needs you" moments are reviewable later.
      if (entry.workspaceId) {
        eventEmit(entry.workspaceId, 'agent_question', { agentId: entry.agentId, paneId })
      }
      // Only pop an OS notification when the window isn't focused.
      if (!win.isDestroyed() && !win.isFocused() && Notification.isSupported()) {
        try {
          new Notification({ title: 'SwarmMind', body: `${agentId ?? 'An agent'} is asking for your input` }).show()
        } catch { /* ignore */ }
      }
    }
  }

  ptyProcess.onData((data) => {
    if (!win.isDestroyed()) win.webContents.send('pty:output', paneId, data)
    if (entry.agentId) {
      // Keep a rolling, ANSI-stripped tail of output so we can tell a question
      // prompt from an ordinary finished turn when the agent goes quiet.
      entry.recentOutput = ((entry.recentOutput ?? '') + stripAnsi(data)).slice(-4000)
      setState('working')
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
      entry.idleTimer = setTimeout(() => setState('waiting'), agentIdleMs)
      // Cost meter: emit a `cost` event whenever the parsed cumulative spend
      // advances. Cheap to run per chunk since it only scans the tail.
      if (entry.workspaceId) {
        const usd = parseCostUsd(entry.recentOutput)
        if (usd !== null && usd > (entry.lastCostUsd ?? -1) + 1e-9) {
          entry.lastCostUsd = usd
          eventEmit(entry.workspaceId, 'cost', {
            agentId: entry.agentId,
            paneId,
            payload: { usd, tokens: parseTokens(entry.recentOutput) ?? undefined },
          })
        }
      }
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    entry.status = 'exited'
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    if (entry.replaced) return  // silently replaced — don't notify the renderer
    if (entry.agentId && entry.workspaceId) {
      eventEmit(entry.workspaceId, 'agent_exit', { agentId: entry.agentId, paneId, payload: { exitCode } })
    }
    stopPaneWatcher(paneId)
    if (!win.isDestroyed()) win.webContents.send('pty:exit', paneId, exitCode)
  })

  processes.set(paneId, entry)
}

// Spawn a plain interactive shell in `cwd` (no coding agent). Gives an idle pane
// a real, typeable prompt showing the working directory.
export function ptyCreateShell(
  paneId: string,
  cwd: string,
  win: BrowserWindow,
  shellStyle: ShellStyle,
  cols = 120,
  rows = 30
): void {
  ptyKill(paneId, true)

  const { file, args } = resolveShellSpawn(shellStyle)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }

  const ptyProcess = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: env as Record<string, string>
  })

  attachPty(paneId, ptyProcess, win)
}

export function ptyCreate(
  paneId: string,
  agentId: AgentId,
  workspaceId: string,
  cwd: string,
  win: BrowserWindow,
  shellStyle: ShellStyle,
  taskContext?: string,
  cols = 120,
  rows = 30,
  resume = false,
  sessionId?: string
): void {
  // Replace any existing process (e.g. the idle shell) without emitting an exit.
  ptyKill(paneId, true)

  const port = getMcpPort()
  const mcpUrl = `http://127.0.0.1:${port ?? 57400}`

  injectMcpConfig(agentId, cwd, mcpUrl)

  const storedConfig = readAgentConfig(workspaceId, agentId)
  const defaults = AGENT_DEFAULTS[agentId]
  const baseCmd = storedConfig.executablePath ?? defaults.cmd
  const baseArgs = buildLaunchArgs(agentId, resume, sessionId, defaults.args)
  const allArgs = [...baseArgs, ...(storedConfig.extraFlags ?? [])]
  const fullCmd = [baseCmd, ...allArgs].join(' ')
  const { file: spawnFile, args: spawnArgs } = resolveSpawn(fullCmd, shellStyle)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    SWARMMIND_MCP_URL: mcpUrl,
    SWARMMIND_MCP_TOKEN: getMcpToken(),
    KILOCODE_MCP_URL: mcpUrl,
    CODEX_MCP_URL: mcpUrl,
    CLINE_MCP_URL: mcpUrl,
    ...(storedConfig.apiKey
      ? agentId === 'claude'
        ? { ANTHROPIC_API_KEY: storedConfig.apiKey }
        : agentId === 'codex' || agentId === 'cursor' || agentId === 'windsurf'
        ? { OPENAI_API_KEY: storedConfig.apiKey }
        : { API_KEY: storedConfig.apiKey }
      : {}),
    ...(storedConfig.env ?? {})
  }

  const ptyProcess = pty.spawn(spawnFile, spawnArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: env as Record<string, string>
  })

  // If spawned from a task card, write task context to MCP then show hint
  if (taskContext) {
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.send('pty:output', paneId,
          `\x1b[2m[Task context available via MCP: memory_read("current_task") or task_list()]\x1b[0m\r\n\r\n`
        )
      }
    }, 300)
  }

  attachPty(paneId, ptyProcess, win, agentId, workspaceId)
  eventEmit(workspaceId, 'agent_spawn', { agentId, paneId, payload: { resume } })
  // Watch this agent's working directory for the shared-world-model / contention
  // surface. Best-effort; degrades to no awareness if the FS can't be watched.
  startPaneWatcher(paneId, cwd, workspaceId, agentId)
}

export function ptyInput(paneId: string, data: string): void {
  const entry = processes.get(paneId)
  if (!entry) return
  // Any non-empty input means the agent now has work to respond to, so a
  // subsequent quiet period is a genuine "waiting for input" worth notifying.
  if (entry.agentId && data.length > 0) entry.hadInput = true
  entry.process.write(data)
}

export function ptyResize(paneId: string, cols: number, rows: number): void {
  const entry = processes.get(paneId)
  if (entry && entry.status === 'running') entry.process.resize(cols, rows)
}

export function ptyKill(paneId: string, silent = false): void {
  const entry = processes.get(paneId)
  if (entry) {
    if (silent) entry.replaced = true  // suppress the pty:exit event for this kill
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    try { entry.process.kill() } catch { /* already dead */ }
    processes.delete(paneId)
  }
  stopPaneWatcher(paneId)
}

export function ptyStatus(paneId: string): PtyStatus {
  return processes.get(paneId)?.status ?? 'idle'
}

// Kill silently: suppress pty:exit so the renderer doesn't react (respawn a
// shell / clear the persisted agentRunning flag). Used on app quit and on
// workspace switch — in both cases the saved layout's resume flags must survive.
export function killAll(): void {
  for (const paneId of processes.keys()) ptyKill(paneId, true)
  stopAllWatchers()
}
