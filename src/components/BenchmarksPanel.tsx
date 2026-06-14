import React, { useMemo, useState } from 'react'
import { useT, type TranslationKey } from '../i18n'
import {
  BENCHMARK_SNAPSHOT,
  BENCHMARK_SOURCE_URL,
  type BenchmarkSnapshot,
  type CodingAgentRow,
  type ModelRow,
} from '../data/benchmarks'
import { BenchmarkBars, type BarItem } from './BenchmarkBars'

type View = 'bars' | 'table'

// Stable colours for the three coding-agent evaluations (shared across bars).
const EVAL_COLORS = { deepSWE: '#60a5fa', terminalBench: '#34d399', sweAtlasQnA: '#a78bfa' }
// Token-composition colours (input / cached input / output).
const TOKEN_COLORS = { input: '#60a5fa', cached: '#34d399', output: '#fbbf24' }
const BAR_ACCENT = 'var(--accent)'

// A fixed palette so each row keeps a stable colour across the table and chart.
const PALETTE = [
  '#e8956b', '#60a5fa', '#34d399', '#a78bfa', '#fbbf24',
  '#f87171', '#22d3ee', '#f472b6', '#a3e635', '#fb923c',
]
const colorAt = (i: number) => PALETTE[i % PALETTE.length]

// Compact token formatter: 90000 → "90k", 1200000 → "1.2M".
const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

// ── Bar-chart metrics ─────────────────────────────────────────────────────────
// The agents tab is the harness comparison: each row is a harness+model combo,
// and the metric picker re-projects them across performance / cost / time / token
// usage / turns. Models compare on intelligence and price.
type AgentMetric = 'performance' | 'index' | 'cpt' | 'time' | 'tokens' | 'turns'
type ModelMetric = 'intelligence' | 'priceOut' | 'priceIn'
const AGENT_METRICS: AgentMetric[] = ['performance', 'index', 'cpt', 'time', 'tokens', 'turns']
const MODEL_METRICS: ModelMetric[] = ['intelligence', 'priceOut', 'priceIn']
const METRIC_LABEL: Record<AgentMetric | ModelMetric, TranslationKey> = {
  performance: 'benchmarks.metric.performance',
  index: 'benchmarks.metric.index',
  cpt: 'benchmarks.metric.cpt',
  time: 'benchmarks.metric.time',
  tokens: 'benchmarks.metric.tokens',
  turns: 'benchmarks.metric.turns',
  intelligence: 'benchmarks.metric.intelligence',
  priceOut: 'benchmarks.metric.priceOut',
  priceIn: 'benchmarks.metric.priceIn',
}
// One-line explanation shown under the chart for the selected metric.
const METRIC_DESC: Record<AgentMetric | ModelMetric, TranslationKey> = {
  performance: 'benchmarks.desc.performance',
  index: 'benchmarks.desc.index',
  cpt: 'benchmarks.desc.cpt',
  time: 'benchmarks.desc.time',
  tokens: 'benchmarks.desc.tokens',
  turns: 'benchmarks.desc.turns',
  intelligence: 'benchmarks.desc.intelligence',
  priceOut: 'benchmarks.desc.priceOut',
  priceIn: 'benchmarks.desc.priceIn',
}

interface BarsConfig {
  items: BarItem[]
  maxValue: number
  valueFormat?: (n: number) => string
  primaryFormat?: (n: number) => string
  legend?: { label: string; color: string }[]
  lowerIsBetter?: boolean
}

// ── Coding Agent Benchmarks ───────────────────────────────────────────────────
//
// A center overlay that surfaces Artificial Analysis' Coding Agent Index so the
// user can see which agent/model is strongest by performance, cost per task, or
// the composite index. Renders the bundled snapshot instantly (offline); the
// Refresh button attempts a best-effort live pull via the main process. Two
// tabs: the coding-agent leaderboard and a general model leaderboard.

type Tab = 'agents' | 'models'
type SortDir = 'asc' | 'desc'

// A column descriptor: the i18n header key, the row field, and whether higher is
// "better" (drives the default sort direction + the best-row highlight).
interface Column<Row> {
  key: keyof Row
  label: TranslationKey
  higherIsBetter: boolean
  format?: (v: number) => string
  align?: 'left' | 'right'
  desc?: TranslationKey // shown as the header tooltip so users know what it means
}

const AGENT_COLUMNS: Column<CodingAgentRow>[] = [
  { key: 'name', label: 'benchmarks.col.agent', higherIsBetter: false, align: 'left' },
  { key: 'model', label: 'benchmarks.col.model', higherIsBetter: false, align: 'left' },
  { key: 'index', label: 'benchmarks.col.index', higherIsBetter: true, format: v => v.toFixed(1), desc: 'benchmarks.desc.index' },
  { key: 'cpt', label: 'benchmarks.col.cpt', higherIsBetter: false, format: v => `$${v.toFixed(2)}`, desc: 'benchmarks.desc.cpt' },
  { key: 'timePerTask', label: 'benchmarks.col.timePerTask', higherIsBetter: false, format: v => `${v}s`, desc: 'benchmarks.desc.time' },
  { key: 'turns', label: 'benchmarks.col.turns', higherIsBetter: false, format: v => v.toFixed(0), desc: 'benchmarks.desc.turns' },
  { key: 'deepSWE', label: 'benchmarks.col.deepSWE', higherIsBetter: true, format: v => `${v}%`, desc: 'benchmarks.desc.deepSWE' },
  { key: 'terminalBench', label: 'benchmarks.col.terminalBench', higherIsBetter: true, format: v => `${v}%`, desc: 'benchmarks.desc.terminalBench' },
  { key: 'sweAtlasQnA', label: 'benchmarks.col.sweAtlasQnA', higherIsBetter: true, format: v => `${v}%`, desc: 'benchmarks.desc.sweAtlasQnA' },
]

const MODEL_COLUMNS: Column<ModelRow>[] = [
  { key: 'name', label: 'benchmarks.col.model', higherIsBetter: false, align: 'left' },
  { key: 'creator', label: 'benchmarks.col.creator', higherIsBetter: false, align: 'left' },
  { key: 'intelligence', label: 'benchmarks.col.intelligence', higherIsBetter: true, format: v => v.toFixed(0), desc: 'benchmarks.desc.intelligence' },
  { key: 'priceIn', label: 'benchmarks.col.priceIn', higherIsBetter: false, format: v => `$${v.toFixed(2)}`, desc: 'benchmarks.desc.priceIn' },
  { key: 'priceOut', label: 'benchmarks.col.priceOut', higherIsBetter: false, format: v => `$${v.toFixed(2)}`, desc: 'benchmarks.desc.priceOut' },
]

function LeaderTable<Row>({
  rows, columns, defaultSort,
}: { rows: Row[]; columns: Column<Row>[]; defaultSort: keyof Row }) {
  const t = useT()
  const [sortKey, setSortKey] = useState<keyof Row>(defaultSort)
  const [dir, setDir] = useState<SortDir>('desc')

  const activeCol = columns.find(c => c.key === sortKey)

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      let cmp: number
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
      else cmp = String(av).localeCompare(String(bv))
      return dir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [rows, sortKey, dir])

  // The single "best" value for the active numeric column, used to highlight the
  // leader regardless of sort direction.
  const bestValue = useMemo(() => {
    if (!activeCol || typeof sorted[0]?.[sortKey] !== 'number') return null
    const vals = sorted.map(r => r[sortKey] as number)
    return activeCol.higherIsBetter ? Math.max(...vals) : Math.min(...vals)
  }, [sorted, sortKey, activeCol])

  const onHeader = (col: Column<Row>) => {
    if (col.key === sortKey) setDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(col.key); setDir(col.higherIsBetter ? 'desc' : 'asc') }
  }

  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            {columns.map(col => {
              const active = col.key === sortKey
              return (
                <th
                  key={String(col.key)}
                  onClick={() => onHeader(col)}
                  style={{
                    ...styles.th,
                    textAlign: col.align ?? 'right',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                  title={col.desc ? `${t(col.desc)} · ${t('benchmarks.sortHint')}` : t('benchmarks.sortHint')}
                >
                  {t(col.label)}{active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i} style={styles.tr}>
              {columns.map(col => {
                const v = row[col.key]
                const isNum = typeof v === 'number'
                const isBest = isNum && col.key === sortKey && bestValue != null && v === bestValue
                return (
                  <td
                    key={String(col.key)}
                    style={{
                      ...styles.td,
                      textAlign: col.align ?? 'right',
                      fontVariantNumeric: isNum ? 'tabular-nums' : undefined,
                      color: isBest ? 'var(--accent)' : col.align === 'left' ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontWeight: isBest || col.key === 'name' ? 600 : 400,
                    }}
                  >
                    {isNum && col.format ? col.format(v as number) : String(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Info glyph for the "About these benchmarks" toggle — a clean stroked circle-i
// that inherits the button colour, matching the TopBar icon style.
function IconInfo() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

// A single term + definition row in the "About these benchmarks" panel.
function Term({ term, def }: { term: string; def: string }) {
  return (
    <div style={styles.term}>
      <span style={styles.termName}>{term}</span>
      <span style={styles.termDef}>{def}</span>
    </div>
  )
}

export function BenchmarksPanel() {
  const t = useT()
  const [tab, setTab] = useState<Tab>('agents')
  const [view, setView] = useState<View>('bars')
  const [agentMetric, setAgentMetric] = useState<AgentMetric>('performance')
  const [modelMetric, setModelMetric] = useState<ModelMetric>('intelligence')
  const [data, setData] = useState<BenchmarkSnapshot>(BENCHMARK_SNAPSHOT)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState(false)
  const [showInfo, setShowInfo] = useState(false)

  const activeMetric: AgentMetric | ModelMetric = tab === 'agents' ? agentMetric : modelMetric

  // Re-project the rows into bar items for the selected metric. Single-value
  // metrics (cost/time/turns/price) rank lower-is-better; performance/tokens use
  // grouped segments with a legend.
  const barConfig: BarsConfig = useMemo(() => {
    const max = (vals: number[]) => Math.max(1, ...vals)
    if (tab === 'agents') {
      const A = data.agents
      const meta = (a: CodingAgentRow) => ({ label: a.name, sub: a.model })
      const single = (get: (a: CodingAgentRow) => number, label: TranslationKey, color = BAR_ACCENT) =>
        A.map(a => ({ ...meta(a), primary: get(a), segments: [{ label: t(label), value: get(a), color }] }))
      switch (agentMetric) {
        case 'performance':
          return {
            items: A.map(a => ({
              ...meta(a), primary: a.index,
              segments: [
                { label: t('benchmarks.col.deepSWE'), value: a.deepSWE, color: EVAL_COLORS.deepSWE },
                { label: t('benchmarks.col.terminalBench'), value: a.terminalBench, color: EVAL_COLORS.terminalBench },
                { label: t('benchmarks.col.sweAtlasQnA'), value: a.sweAtlasQnA, color: EVAL_COLORS.sweAtlasQnA },
              ],
            })),
            maxValue: 100, valueFormat: n => `${n}%`, primaryFormat: n => n.toFixed(1),
            legend: [
              { label: t('benchmarks.col.deepSWE'), color: EVAL_COLORS.deepSWE },
              { label: t('benchmarks.col.terminalBench'), color: EVAL_COLORS.terminalBench },
              { label: t('benchmarks.col.sweAtlasQnA'), color: EVAL_COLORS.sweAtlasQnA },
            ],
          }
        case 'index':
          return { items: single(a => a.index, 'benchmarks.col.index'), maxValue: 100, valueFormat: n => n.toFixed(1), primaryFormat: n => n.toFixed(1) }
        case 'cpt':
          return { items: single(a => a.cpt, 'benchmarks.col.cpt'), maxValue: max(A.map(a => a.cpt)), valueFormat: n => `$${n.toFixed(2)}`, primaryFormat: n => `$${n.toFixed(2)}`, lowerIsBetter: true }
        case 'time':
          return { items: single(a => a.timePerTask, 'benchmarks.col.timePerTask'), maxValue: max(A.map(a => a.timePerTask)), valueFormat: n => `${n}s`, primaryFormat: n => `${n}s`, lowerIsBetter: true }
        case 'turns':
          return { items: single(a => a.turns, 'benchmarks.col.turns'), maxValue: max(A.map(a => a.turns)), valueFormat: n => n.toFixed(0), primaryFormat: n => n.toFixed(0), lowerIsBetter: true }
        case 'tokens':
          return {
            items: A.map(a => ({
              ...meta(a), primary: a.inputTokens + a.cachedTokens + a.outputTokens,
              segments: [
                { label: t('benchmarks.tok.input'), value: a.inputTokens, color: TOKEN_COLORS.input },
                { label: t('benchmarks.tok.cached'), value: a.cachedTokens, color: TOKEN_COLORS.cached },
                { label: t('benchmarks.tok.output'), value: a.outputTokens, color: TOKEN_COLORS.output },
              ],
            })),
            maxValue: max(A.map(a => a.inputTokens + a.cachedTokens + a.outputTokens)),
            valueFormat: fmtTokens, primaryFormat: fmtTokens, lowerIsBetter: true,
            legend: [
              { label: t('benchmarks.tok.input'), color: TOKEN_COLORS.input },
              { label: t('benchmarks.tok.cached'), color: TOKEN_COLORS.cached },
              { label: t('benchmarks.tok.output'), color: TOKEN_COLORS.output },
            ],
          }
      }
    }
    const M = data.models
    const singleM = (get: (m: ModelRow) => number, label: TranslationKey) =>
      M.map((m, i) => ({ label: m.name, sub: m.creator, primary: get(m), segments: [{ label: t(label), value: get(m), color: colorAt(i) }] }))
    switch (modelMetric) {
      case 'priceOut':
        return { items: singleM(m => m.priceOut, 'benchmarks.col.priceOut'), maxValue: max(M.map(m => m.priceOut)), valueFormat: n => `$${n.toFixed(2)}`, primaryFormat: n => `$${n.toFixed(2)}`, lowerIsBetter: true }
      case 'priceIn':
        return { items: singleM(m => m.priceIn, 'benchmarks.col.priceIn'), maxValue: max(M.map(m => m.priceIn)), valueFormat: n => `$${n.toFixed(2)}`, primaryFormat: n => `$${n.toFixed(2)}`, lowerIsBetter: true }
      case 'intelligence':
      default:
        return { items: singleM(m => m.intelligence, 'benchmarks.col.intelligence'), maxValue: 100, valueFormat: n => n.toFixed(0), primaryFormat: n => n.toFixed(0) }
    }
  }, [tab, agentMetric, modelMetric, data, t])

  const refresh = async () => {
    setRefreshing(true); setRefreshError(false)
    try {
      const res = await window.swarmmind.fetchBenchmarks()
      if (res && 'error' in res) {
        setRefreshError(true)
      } else if (res && Array.isArray(res.agents) && res.agents.length > 0) {
        // Live pull only returns agents; keep the bundled models list.
        setData(d => ({
          ...res,
          models: res.models.length > 0 ? res.models : d.models,
        }))
      } else {
        setRefreshError(true)
      }
    } catch {
      setRefreshError(true)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>{t('benchmarks.title')}</span>
        <div style={styles.tabStrip}>
          <button style={{ ...styles.tab, ...(tab === 'agents' ? styles.tabActive : {}) }} onClick={() => setTab('agents')}>
            {t('benchmarks.tab.agents')}
          </button>
          <button style={{ ...styles.tab, ...(tab === 'models' ? styles.tabActive : {}) }} onClick={() => setTab('models')}>
            {t('benchmarks.tab.models')}
          </button>
        </div>
        <div style={styles.viewToggle}>
          <button style={{ ...styles.segBtn, ...(view === 'bars' ? styles.segActive : {}) }} onClick={() => setView('bars')}>
            {t('benchmarks.view.bars')}
          </button>
          <button style={{ ...styles.segBtn, ...(view === 'table' ? styles.segActive : {}) }} onClick={() => setView('table')}>
            {t('benchmarks.view.table')}
          </button>
        </div>
        {view === 'bars' && (
          <select
            value={tab === 'agents' ? agentMetric : modelMetric}
            onChange={e => tab === 'agents'
              ? setAgentMetric(e.target.value as AgentMetric)
              : setModelMetric(e.target.value as ModelMetric)}
            style={styles.select}
            aria-label={t('benchmarks.metricLabel')}
          >
            {(tab === 'agents' ? AGENT_METRICS : MODEL_METRICS).map(m => (
              <option key={m} value={m}>{t(METRIC_LABEL[m])}</option>
            ))}
          </select>
        )}
        <div style={{ flex: 1 }} />
        <span style={styles.asOf}>{t('benchmarks.dataAsOf', { date: data.updatedAt })}</span>
        <button onClick={refresh} disabled={refreshing} style={styles.refreshBtn}>
          {refreshing ? t('benchmarks.refreshing') : t('benchmarks.refresh')}
        </button>
        <a
          href={BENCHMARK_SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          style={styles.link}
          onClick={(e) => { e.preventDefault(); window.open(BENCHMARK_SOURCE_URL, '_blank') }}
        >
          {t('benchmarks.viewOnAA')} ↗
        </a>
        <button
          onClick={() => setShowInfo(v => !v)}
          style={{ ...styles.infoBtn, ...(showInfo ? styles.infoBtnActive : {}) }}
          title={showInfo ? t('benchmarks.about.hide') : t('benchmarks.about.show')}
          aria-label={showInfo ? t('benchmarks.about.hide') : t('benchmarks.about.show')}
        >
          <IconInfo />
        </button>
      </div>

      {showInfo && (
        <div style={styles.about}>
          <p style={styles.aboutIntro}>{t('benchmarks.about.intro')}</p>
          <div style={styles.aboutGrid}>
            <div style={styles.aboutCol}>
              <div style={styles.aboutHeading}>{t('benchmarks.about.evalsHeading')}</div>
              <Term term={t('benchmarks.col.index')} def={t('benchmarks.desc.index')} />
              <Term term={t('benchmarks.col.deepSWE')} def={t('benchmarks.desc.deepSWE')} />
              <Term term={t('benchmarks.col.terminalBench')} def={t('benchmarks.desc.terminalBench')} />
              <Term term={t('benchmarks.col.sweAtlasQnA')} def={t('benchmarks.desc.sweAtlasQnA')} />
            </div>
            <div style={styles.aboutCol}>
              <div style={styles.aboutHeading}>{t('benchmarks.about.efficiencyHeading')}</div>
              <Term term={t('benchmarks.col.cpt')} def={t('benchmarks.desc.cpt')} />
              <Term term={t('benchmarks.col.timePerTask')} def={t('benchmarks.desc.time')} />
              <Term term={t('benchmarks.metric.tokens')} def={t('benchmarks.desc.tokens')} />
              <Term term={t('benchmarks.col.turns')} def={t('benchmarks.desc.turns')} />
            </div>
            <div style={styles.aboutCol}>
              <div style={styles.aboutHeading}>{t('benchmarks.about.modelsHeading')}</div>
              <Term term={t('benchmarks.col.intelligence')} def={t('benchmarks.desc.intelligence')} />
              <Term term={t('benchmarks.col.priceIn')} def={t('benchmarks.desc.priceIn')} />
              <Term term={t('benchmarks.col.priceOut')} def={t('benchmarks.desc.priceOut')} />
            </div>
          </div>
        </div>
      )}

      {refreshError && <div style={styles.warn}>{t('benchmarks.refreshFailed')}</div>}
      {data.provisional && <div style={styles.note}>{t('benchmarks.provisional')}</div>}

      <div style={styles.body}>
        {view === 'bars' ? (
          <>
            <div style={styles.caption}>{t(METRIC_DESC[activeMetric])}</div>
            <BenchmarkBars {...barConfig} />
          </>
        ) : tab === 'agents' ? (
          <LeaderTable rows={data.agents} columns={AGENT_COLUMNS} defaultSort="index" />
        ) : (
          <LeaderTable rows={data.models} columns={MODEL_COLUMNS} defaultSort="intelligence" />
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' },
  title: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  tabStrip: { display: 'flex', gap: 4 },
  tab: {
    background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6,
    color: 'var(--text-muted)', padding: '4px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 500,
    transition: 'border-color 120ms, color 120ms, background 120ms',
  },
  tabActive: { background: 'var(--accent-subtle, var(--bg-elevated))', borderColor: 'var(--accent)', color: 'var(--accent)' },
  viewToggle: { display: 'flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' },
  segBtn: {
    background: 'transparent', border: 'none', color: 'var(--text-muted)', padding: '4px 12px',
    cursor: 'pointer', fontSize: 12, fontWeight: 500, transition: 'background 120ms, color 120ms',
  },
  segActive: { background: 'var(--bg-elevated)', color: 'var(--text-primary)' },
  select: {
    fontSize: 12, fontWeight: 500, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)',
  },
  asOf: { fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' },
  refreshBtn: {
    fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)', whiteSpace: 'nowrap',
  },
  link: { fontSize: 12, color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap' },
  infoBtn: {
    width: 24, height: 24, borderRadius: 6, cursor: 'pointer', fontSize: 13, lineHeight: 1,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-strong)',
  },
  infoBtnActive: { background: 'var(--accent-subtle, var(--bg-elevated))', borderColor: 'var(--accent)', color: 'var(--accent)' },
  about: { margin: '10px 16px 0', padding: '12px 14px', borderRadius: 8, background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)' },
  aboutIntro: { margin: '0 0 10px', fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' },
  aboutGrid: { display: 'flex', flexWrap: 'wrap', gap: 18 },
  aboutCol: { flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 7 },
  aboutHeading: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', marginBottom: 2 },
  term: { display: 'flex', flexDirection: 'column', gap: 1 },
  termName: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' },
  termDef: { fontSize: 11, lineHeight: 1.45, color: 'var(--text-muted)' },
  caption: { padding: '0 18px 8px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 },
  warn: { margin: '8px 16px 0', padding: '8px 10px', borderRadius: 6, fontSize: 12, color: 'var(--danger, #e5484d)', background: 'color-mix(in srgb, var(--danger, #e5484d) 12%, transparent)' },
  note: { margin: '8px 16px 0', padding: '8px 10px', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-elevated)' },
  body: { flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 0' },
  tableWrap: { padding: '0 8px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    position: 'sticky', top: 0, background: 'var(--bg-base)', padding: '8px 12px', fontSize: 11,
    fontWeight: 600, cursor: 'pointer', userSelect: 'none', borderBottom: '1px solid var(--border-strong)', whiteSpace: 'nowrap',
  },
  tr: { borderBottom: '1px solid var(--border-subtle)' },
  td: { padding: '9px 12px', whiteSpace: 'nowrap' },
}
