import { ipcMain, net } from 'electron'

// ── Coding-agent benchmarks: best-effort live refresh ───────────────────────
//
// The renderer ships a bundled snapshot of Artificial Analysis' Coding Agent
// Index (see src/data/coding-agent-benchmarks.json) and renders that offline.
// This handler is the optional "Refresh" path: it fetches the live AA page from
// the main process (the renderer's CSP blocks artificialanalysis.ai) and tries
// to recover the leaderboard data embedded in the page's Next.js payload.
//
// It is BEST-EFFORT by design. The AA leaderboard is client-rendered and its
// internal data shape is undocumented, so parsing may not find usable rows — in
// which case we return `{ error }` and the UI keeps the bundled snapshot. When
// AA's payload shape is known, tighten `extractRows()` to map it precisely.

const SOURCE_URL = 'https://artificialanalysis.ai/agents/coding-agents'
const FETCH_TIMEOUT_MS = 12_000

interface AgentRow {
  name: string; model: string; index: number; cpt: number
  timePerTask: number; deepSWE: number; terminalBench: number; sweAtlasQnA: number
  inputTokens: number; cachedTokens: number; outputTokens: number; turns: number
}
interface ModelRow {
  name: string; creator: string; intelligence: number; priceIn: number; priceOut: number
}
interface Snapshot {
  updatedAt: string; provisional?: boolean; source: string
  agents: AgentRow[]; models: ModelRow[]
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request(url)
    const timer = setTimeout(() => { req.abort(); reject(new Error('timeout')) }, FETCH_TIMEOUT_MS)
    let body = ''
    req.on('response', (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 400)) {
        clearTimeout(timer); req.abort(); reject(new Error(`HTTP ${res.statusCode}`)); return
      }
      res.on('data', (chunk) => { body += chunk.toString() })
      res.on('end', () => { clearTimeout(timer); resolve(body) })
      res.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
    })
    req.on('error', (e) => { clearTimeout(timer); reject(e) })
    req.end()
  })
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,%\s]/g, ''))
    if (Number.isFinite(n)) return n
  }
  return null
}

// Walk the parsed Next.js payload and recover any object that looks like a
// coding-agent leaderboard row (has a name plus an index/score and a cost).
// Returns [] when nothing plausible is found.
function extractRows(data: unknown): AgentRow[] {
  const out: AgentRow[] = []
  const seen = new Set<unknown>()
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) { node.forEach(visit); return }
    const o = node as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name
      : typeof o.agent === 'string' ? o.agent
      : typeof o.label === 'string' ? o.label : null
    const index = num(o.index ?? o.codingAgentIndex ?? o.score)
    const cpt = num(o.cpt ?? o.costPerTask ?? o.cost)
    if (name && index != null && cpt != null) {
      out.push({
        name,
        model: typeof o.model === 'string' ? o.model : '',
        index,
        cpt,
        timePerTask: num(o.timePerTask ?? o.time) ?? 0,
        deepSWE: num(o.deepSWE ?? o.deepswe) ?? 0,
        terminalBench: num(o.terminalBench ?? o.terminalBenchV2) ?? 0,
        sweAtlasQnA: num(o.sweAtlasQnA ?? o.sweAtlas) ?? 0,
        inputTokens: num(o.inputTokens ?? o.input) ?? 0,
        cachedTokens: num(o.cachedTokens ?? o.cached) ?? 0,
        outputTokens: num(o.outputTokens ?? o.output) ?? 0,
        turns: num(o.turns) ?? 0,
      })
    }
    Object.values(o).forEach(visit)
  }
  visit(data)
  return out
}

async function refresh(): Promise<Snapshot | { error: string }> {
  try {
    const html = await fetchText(SOURCE_URL)
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (!m) return { error: 'no-data' }
    const agents = extractRows(JSON.parse(m[1]))
    if (agents.length === 0) return { error: 'no-rows' }
    return {
      updatedAt: new Date().toISOString().slice(0, 10),
      provisional: false,
      source: SOURCE_URL,
      agents,
      // The model leaderboard lives on a different page; leave it to the
      // bundled snapshot rather than guessing here.
      models: [],
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'fetch-failed' }
  }
}

export function registerBenchmarkHandlers(): void {
  ipcMain.handle('benchmarks:fetch', () => refresh())
}
