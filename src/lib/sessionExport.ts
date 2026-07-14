// ── Session export (pure) ────────────────────────────────────────────────────
//
// Turns the swarm event log (memory/events.ts rows, as delivered to the
// renderer) into shareable artifacts: a self-contained HTML report and a
// Markdown digest. "Self-contained" is a hard requirement — the HTML embeds all
// CSS inline, references no external fonts/scripts/images, and escapes every
// payload-derived string, so the file can be mailed/committed/opened anywhere.
//
// Dependency-free on purpose (no React/Electron imports) so it strip-and-runs
// in tests/lib-units.mts. The impure part (save dialog + file write) lives in
// electron/ipc/events.ts (`export:saveSession`).

export interface ExportEvent {
  id: string
  ts: number
  type: string
  agent_id: string | null
  pane_id: string | null
  payload: Record<string, unknown> | null
}

export interface SessionMeta {
  workspaceName: string
  exportedAt: number
}

export interface SessionStats {
  total: number
  startTs: number | null
  endTs: number | null
  durationMs: number
  byType: Record<string, number>
  /** Agents in first-seen order — the fixed categorical order for colours. */
  agents: string[]
  byAgent: Record<string, number>
  totalCostUsd: number
  totalTokens: number
  /** Unique changed file paths, first-seen order. */
  filesChanged: string[]
  tasksCreated: number
  tasksCompleted: number
  messages: number
  checkpoints: number
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const str = (d: Record<string, unknown> | null, k: string, fallback = '?'): string => {
  const v = d?.[k]
  return v === undefined || v === null ? fallback : String(v)
}

// Plain-English one-liner per event. The in-app timeline localises via i18n;
// the export is a shareable artifact, so it stays English (the lingua franca of
// bug reports and PR descriptions) and must not depend on the i18n layer.
export function summarizeEvent(ev: ExportEvent): string {
  const d = ev.payload
  switch (ev.type) {
    case 'memory_write':   return `wrote memory "${str(d, 'key')}" (${str(d, 'type', 'context')})`
    case 'task_create':    return `created task "${str(d, 'title')}"` + (d?.assigned_agent ? ` → @${str(d, 'assigned_agent')}` : '')
    case 'task_update':    return `task "${str(d, 'title')}" → ${str(d, 'status')}`
    case 'task_note':      return `noted progress on "${str(d, 'title')}"`
    case 'message':        return `message ${str(d, 'from')} → ${str(d, 'to')}: ${str(d, 'body', '').slice(0, 120)}`
    case 'agent_spawn':    return d?.resume ? 'resumed session' : 'spawned'
    case 'agent_exit':     return d?.exitCode !== undefined ? `exited (code ${str(d, 'exitCode')})` : 'exited'
    case 'agent_question': return 'asked for input'
    case 'dispatch':       return `dispatched "${str(d, 'title')}"`
    case 'synthesis':      return `synthesized ${str(d, 'results', '0')} result(s)`
    case 'cost': {
      const usd = Number(d?.usd ?? 0).toFixed(4)
      return d?.tokens ? `$${usd} (${Number(d.tokens).toLocaleString('en-US')} tokens)` : `$${usd}`
    }
    case 'file_changed':   return `changed ${str(d, 'path')}`
    case 'contention':     return `contention on ${str(d, 'path')}` + (Array.isArray(d?.agents) && d.agents.length ? ` (${d.agents.join(', ')})` : '')
    case 'file_intent':    return Array.isArray(d?.paths) ? `intends to touch ${d.paths.length} file(s)` : 'declared file intent'
    case 'checkpoint':     return d?.trigger === 'restore' ? `rewound to "${str(d, 'label')}"` : `checkpoint "${str(d, 'label')}" (${str(d, 'trigger', 'manual')})`
    case 'review':         return d?.verdict === 'assigned' ? `reviewing "${str(d, 'title')}"` : `review ${str(d, 'verdict')}: "${str(d, 'title')}"`
    default:               return ev.type
  }
}

export function buildSessionStats(events: ExportEvent[]): SessionStats {
  const byType: Record<string, number> = {}
  const byAgent: Record<string, number> = {}
  const agents: string[] = []
  const filesChanged: string[] = []
  const seenFiles = new Set<string>()
  let totalCostUsd = 0
  let totalTokens = 0
  let tasksCreated = 0
  let tasksCompleted = 0
  let messages = 0
  let checkpoints = 0
  let startTs: number | null = null
  let endTs: number | null = null

  for (const ev of events) {
    byType[ev.type] = (byType[ev.type] ?? 0) + 1
    if (ev.agent_id) {
      if (!(ev.agent_id in byAgent)) agents.push(ev.agent_id)
      byAgent[ev.agent_id] = (byAgent[ev.agent_id] ?? 0) + 1
    }
    if (startTs === null || ev.ts < startTs) startTs = ev.ts
    if (endTs === null || ev.ts > endTs) endTs = ev.ts
    const d = ev.payload
    switch (ev.type) {
      case 'cost':
        totalCostUsd += Number(d?.usd ?? 0) || 0
        totalTokens += Number(d?.tokens ?? 0) || 0
        break
      case 'task_create': tasksCreated++; break
      case 'task_update': if (d?.status === 'done') tasksCompleted++; break
      case 'message': messages++; break
      case 'checkpoint': checkpoints++; break
      case 'file_changed': {
        const p = typeof d?.path === 'string' ? d.path : null
        if (p && !seenFiles.has(p)) { seenFiles.add(p); filesChanged.push(p) }
        break
      }
    }
  }

  return {
    total: events.length,
    startTs,
    endTs,
    durationMs: startTs !== null && endTs !== null ? endTs - startTs : 0,
    byType,
    agents,
    byAgent,
    totalCostUsd,
    totalTokens,
    filesChanged,
    tasksCreated,
    tasksCompleted,
    messages,
    checkpoints,
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// Auto-compact figures for stat tiles: 1,284 / 12.9K / 4.2M.
export function compactNumber(n: number): string {
  if (!isFinite(n)) return '0'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toLocaleString('en-US')
}

// A filename-safe base for the exported file (no dialog will accept `"<>|`…).
export function exportFileBase(workspaceName: string, exportedAt: number): string {
  const d = new Date(exportedAt)
  const pad = (x: number) => String(x).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const name = workspaceName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  return `swarm-session-${name}-${date}`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Agent identity colours: the app's fixed brand colours for the known CLIs,
// then a fixed-order fallback wheel for anything else (never cycled per render
// — assignment is by first-seen order, so the same log always colours the same).
const AGENT_BRAND: Record<string, string> = {
  claude: '#c084fc',
  codex: '#34d399',
  cursor: '#60a5fa',
  windsurf: '#fb923c',
  kilo: '#fbbf24',
  opencode: '#f472b6',
  cline: '#a78bfa',
}
const FALLBACK_WHEEL = ['#38bdf8', '#4ade80', '#f87171', '#e8b04a', '#9d8cff', '#5bc8af']

export function agentPalette(agents: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  let next = 0
  for (const a of agents) {
    out[a] = AGENT_BRAND[a] ?? FALLBACK_WHEEL[next++ % FALLBACK_WHEEL.length]
  }
  return out
}

const TYPE_GLYPH: Record<string, string> = {
  memory_write: '◆', task_create: '＋', task_update: '↻', task_note: '✎',
  message: '✉', agent_spawn: '⏻', agent_exit: '⏹', agent_question: '?',
  dispatch: '→', synthesis: '∑', cost: '$', file_changed: '✦',
  contention: '⚠', file_intent: '⊡', checkpoint: '📍', review: '⚖',
}

interface Tile { label: string; value: string }

function buildTiles(stats: SessionStats): Tile[] {
  const tiles: Tile[] = [
    { label: 'Events', value: compactNumber(stats.total) },
    { label: 'Duration', value: formatDuration(stats.durationMs) },
    { label: 'Agents', value: compactNumber(stats.agents.length) },
  ]
  if (stats.tasksCreated || stats.tasksCompleted) {
    tiles.push({ label: 'Tasks done', value: `${stats.tasksCompleted}/${stats.tasksCreated}` })
  }
  if (stats.filesChanged.length) tiles.push({ label: 'Files touched', value: compactNumber(stats.filesChanged.length) })
  if (stats.messages) tiles.push({ label: 'Messages', value: compactNumber(stats.messages) })
  if (stats.checkpoints) tiles.push({ label: 'Checkpoints', value: compactNumber(stats.checkpoints) })
  if (stats.totalCostUsd > 0) tiles.push({ label: 'Est. spend', value: `$${stats.totalCostUsd.toFixed(2)}` })
  return tiles
}

export function renderSessionMarkdown(events: ExportEvent[], meta: SessionMeta): string {
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const stats = buildSessionStats(sorted)
  const lines: string[] = []
  lines.push(`# Swarm session — ${meta.workspaceName}`)
  lines.push('')
  const range = stats.startTs !== null
    ? `${fmtDate(stats.startTs)} ${fmtTime(stats.startTs)} → ${fmtDate(stats.endTs!)} ${fmtTime(stats.endTs!)}`
    : 'no events'
  lines.push(`Exported ${fmtDate(meta.exportedAt)} · ${range} · generated by SwarmMind`)
  lines.push('')
  for (const tile of buildTiles(stats)) lines.push(`- **${tile.label}:** ${tile.value}`)
  if (stats.agents.length) lines.push(`- **Participants:** ${stats.agents.join(', ')}`)
  lines.push('')
  if (stats.filesChanged.length) {
    lines.push('## Files touched')
    lines.push('')
    for (const p of stats.filesChanged) lines.push(`- \`${p}\``)
    lines.push('')
  }
  lines.push('## Timeline')
  lines.push('')
  let lastDay = ''
  for (const ev of sorted) {
    const day = fmtDate(ev.ts)
    if (day !== lastDay) { lines.push(`### ${day}`); lines.push(''); lastDay = day }
    const who = ev.agent_id ? `**${ev.agent_id}** ` : ''
    lines.push(`- \`${fmtTime(ev.ts)}\` ${who}${summarizeEvent(ev)} _(${ev.type})_`)
  }
  lines.push('')
  return lines.join('\n')
}

export function renderSessionHtml(events: ExportEvent[], meta: SessionMeta): string {
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const stats = buildSessionStats(sorted)
  const palette = agentPalette(stats.agents)
  const title = `Swarm session — ${meta.workspaceName}`
  const range = stats.startTs !== null
    ? `${fmtDate(stats.startTs)} ${fmtTime(stats.startTs)} → ${fmtDate(stats.endTs!)} ${fmtTime(stats.endTs!)}`
    : 'no events'

  const tilesHtml = buildTiles(stats).map(tile => `
      <div class="tile">
        <div class="tile-label">${escapeHtml(tile.label)}</div>
        <div class="tile-value">${escapeHtml(tile.value)}</div>
      </div>`).join('')

  // Identity is never colour-alone: the dot carries the hue, the name is text.
  const legendHtml = stats.agents.map(a => `
      <span class="agent"><span class="dot" style="background:${palette[a]}"></span>${escapeHtml(a)}<span class="agent-n">${stats.byAgent[a]}</span></span>`).join('')

  const rows: string[] = []
  let lastDay = ''
  for (const ev of sorted) {
    const day = fmtDate(ev.ts)
    if (day !== lastDay) {
      rows.push(`<div class="day">${escapeHtml(day)}</div>`)
      lastDay = day
    }
    const color = ev.agent_id ? palette[ev.agent_id] ?? 'var(--muted)' : 'var(--muted)'
    const glyph = TYPE_GLYPH[ev.type] ?? '•'
    rows.push(`
      <div class="row">
        <span class="time">${fmtTime(ev.ts)}</span>
        <span class="glyph" style="color:${color}">${escapeHtml(glyph)}</span>
        <span class="body">${ev.agent_id ? `<span class="who"><span class="dot" style="background:${color}"></span>${escapeHtml(ev.agent_id)}</span> ` : ''}<span class="sum">${escapeHtml(summarizeEvent(ev))}</span></span>
        <span class="type">${escapeHtml(ev.type.replace(/_/g, ' '))}</span>
      </div>`)
  }

  const filesHtml = stats.filesChanged.length
    ? `<h2>Files touched</h2><ul class="files">${stats.filesChanged.map(p => `<li><code>${escapeHtml(p)}</code></li>`).join('')}</ul>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #161412; --panel: #1c1a18; --elevated: #222019;
    --border: #2e2b24; --border-strong: #3a362e;
    --ink: #ece7e0; --ink-2: #a89e94; --muted: #6b6259;
    --accent: #d4845a;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
    padding: 32px 16px 64px;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  header { margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 600; }
  .sub { color: var(--ink-2); font-size: 13px; margin-top: 4px; }
  .brand { color: var(--accent); font-weight: 600; }
  .tiles { display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0 8px; }
  .tile {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 16px; min-width: 108px;
  }
  .tile-label { font-size: 11px; color: var(--ink-2); }
  .tile-value { font-size: 22px; font-weight: 600; margin-top: 2px; }
  .agents { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0 4px; }
  .agent { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-2); }
  .agent-n { color: var(--muted); font-size: 11px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  h2 { font-size: 14px; font-weight: 600; margin: 28px 0 10px; color: var(--ink); }
  .files { list-style: none; }
  .files li { padding: 2px 0; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: var(--ink-2); background: var(--elevated); padding: 1px 6px; border-radius: 4px; }
  .feed { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); overflow: hidden; margin-top: 10px; }
  .day { padding: 8px 16px; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); background: var(--elevated); border-bottom: 1px solid var(--border); }
  .row { display: flex; gap: 10px; align-items: baseline; padding: 7px 16px; border-bottom: 1px solid var(--border); }
  .row:last-child { border-bottom: none; }
  .time { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; color: var(--muted); flex-shrink: 0; }
  .glyph { width: 16px; text-align: center; flex-shrink: 0; font-weight: 700; }
  .body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .who { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; font-size: 13px; }
  .sum { color: var(--ink-2); }
  .type { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); flex-shrink: 0; }
  footer { margin-top: 24px; color: var(--muted); font-size: 12px; }
  @media print { body { background: #fff; color: #1c1a18; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="sub">${escapeHtml(range)} · exported ${escapeHtml(fmtDate(meta.exportedAt))} by <span class="brand">SwarmMind</span></div>
  </header>
  <div class="tiles">${tilesHtml}</div>
  ${stats.agents.length ? `<div class="agents">${legendHtml}</div>` : ''}
  ${filesHtml}
  <h2>Timeline · ${stats.total} event${stats.total === 1 ? '' : 's'}</h2>
  <div class="feed">${rows.join('') || '<div class="row"><span class="sum">No events recorded.</span></div>'}</div>
  <footer>Generated by SwarmMind — every entry is a real event from the swarm's append-only log.</footer>
</div>
</body>
</html>
`
}
