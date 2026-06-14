// ── Coding-agent benchmark data ─────────────────────────────────────────────
// A curated snapshot of Artificial Analysis' Coding Agent Index leaderboard,
// bundled so the Benchmarks overlay always renders offline. The numbers in
// `coding-agent-benchmarks.json` are PROVISIONAL (`provisional: true`) and must
// be transcribed from the live AA page — https://artificialanalysis.ai/agents/coding-agents
// — which is JavaScript-rendered and not machine-fetchable at build time. Verify
// and refresh them each release. At runtime the overlay's "Refresh" button can
// pull live data via the `benchmarks:fetch` IPC (best-effort).

import snapshot from './coding-agent-benchmarks.json'

// One row of the Coding Agent Index leaderboard: a harness + model combination
// scored across the three AA evaluations plus pooled efficiency metrics.
export interface CodingAgentRow {
  name: string          // agent / harness, e.g. "Claude Code"
  model: string         // model powering the harness, e.g. "Claude Opus 4.8"
  index: number         // Artificial Analysis Coding Agent Index (composite)
  cpt: number           // cost per task, USD
  timePerTask: number   // seconds per task
  deepSWE: number       // DeepSWE score, %
  terminalBench: number // Terminal-Bench v2 score, %
  sweAtlasQnA: number   // SWE-Atlas-QnA score, %
  inputTokens: number   // mean input tokens per task
  cachedTokens: number  // mean cached input tokens per task
  outputTokens: number  // mean output tokens per task
  turns: number         // mean agent turns / iterations per task
}

// One row of the general model leaderboard (Intelligence Index + price/token).
export interface ModelRow {
  name: string         // model, e.g. "Claude Opus 4.8"
  creator: string      // e.g. "Anthropic"
  intelligence: number // Artificial Analysis Intelligence Index
  priceIn: number      // USD per 1M input tokens
  priceOut: number     // USD per 1M output tokens
}

export interface BenchmarkSnapshot {
  updatedAt: string      // ISO date the snapshot was last verified
  provisional?: boolean  // true when the bundled numbers haven't been confirmed live
  source: string         // canonical leaderboard URL
  agents: CodingAgentRow[]
  models: ModelRow[]
}

export const BENCHMARK_SNAPSHOT = snapshot as BenchmarkSnapshot

// Canonical leaderboard URL, reused by the "View on Artificial Analysis" link.
export const BENCHMARK_SOURCE_URL = BENCHMARK_SNAPSHOT.source
