import React from 'react'

// ── Benchmark bar chart ───────────────────────────────────────────────────────
//
// A dependency-free horizontal bar chart echoing Artificial Analysis' per-metric
// breakdown. Rows are ranked by their `primary` value (best on top); each row
// shows one or more coloured segments as grouped bars. Built with plain flex/DOM
// (crisper than SVG for bars, and trivially responsive).

export interface BarSegment {
  label: string
  value: number
  color: string
}
export interface BarItem {
  label: string
  sub?: string
  primary: number // drives ranking + shown next to the label
  segments: BarSegment[]
}

interface Props {
  items: BarItem[]
  maxValue: number
  valueFormat?: (n: number) => string
  primaryFormat?: (n: number) => string
  legend?: { label: string; color: string }[]
  // When true, lower `primary` is better: rank ascending (best on top) and
  // highlight the minimum. Used for cost / time / token / turn metrics.
  lowerIsBetter?: boolean
}

export function BenchmarkBars({ items, maxValue, valueFormat, primaryFormat, legend, lowerIsBetter }: Props) {
  const fmt = valueFormat ?? ((n: number) => n.toFixed(0))
  const fmtP = primaryFormat ?? fmt
  const ranked = [...items].sort((a, b) => (lowerIsBetter ? a.primary - b.primary : b.primary - a.primary))
  const best = ranked[0]?.primary // best is always on top after the sort above

  return (
    <div style={styles.wrap}>
      {legend && legend.length > 1 && (
        <div style={styles.legend}>
          {legend.map(l => (
            <span key={l.label} style={styles.legendItem}>
              <span style={{ ...styles.swatch, background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}

      {ranked.map((item, i) => (
        <div key={i} style={styles.row}>
          <div style={styles.labelCell}>
            <span style={styles.label}>{item.label}</span>
            {item.sub && <span style={styles.sub}>{item.sub}</span>}
          </div>
          <div style={styles.barsCell}>
            {item.segments.map((seg, j) => (
              <div key={j} style={styles.track} title={`${seg.label}: ${fmt(seg.value)}`}>
                <div
                  style={{
                    ...styles.bar,
                    width: `${Math.max(0, Math.min(100, (seg.value / maxValue) * 100))}%`,
                    background: seg.color,
                  }}
                >
                  <span style={styles.barValue}>{fmt(seg.value)}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ ...styles.primary, color: item.primary === best ? 'var(--accent)' : 'var(--text-secondary)' }}>
            {fmtP(item.primary)}
          </div>
        </div>
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 },
  legend: { display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 4 },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' },
  swatch: { width: 10, height: 10, borderRadius: 2, display: 'inline-block' },
  row: { display: 'flex', alignItems: 'center', gap: 12 },
  labelCell: { width: 150, flexShrink: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.2 },
  label: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  sub: { fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  barsCell: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  track: { width: '100%', height: 16, background: 'var(--bg-elevated)', borderRadius: 4, overflow: 'hidden' },
  bar: { height: '100%', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minWidth: 26, transition: 'width 200ms ease-out' },
  barValue: { fontSize: 10, fontWeight: 600, color: 'rgba(0,0,0,0.65)', padding: '0 6px', fontVariantNumeric: 'tabular-nums' },
  primary: { width: 52, flexShrink: 0, textAlign: 'right', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
}
