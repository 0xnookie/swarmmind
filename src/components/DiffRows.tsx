// Shared unified-diff renderer used by both the multi-file Composer preview and
// the inline-edit (Cmd-K) accept/reject preview. Renders a lineDiff as coloured
// +/− rows and refines each modified line (a del immediately followed by an add)
// into Cursor-style intra-line word highlights via wordDiff. Kept here so the
// two call sites share one implementation.
import React from 'react'
import { wordDiff, type DiffLine, type WordSeg } from '../lib/lineDiff'

const DIFF_ADD_BG = 'rgba(124,186,124,0.12)'
const DIFF_DEL_BG = 'rgba(224,122,122,0.12)'
const DIFF_ADD_FG = '#9fd89f'
const DIFF_DEL_FG = '#e69b9b'
const WORD_ADD_BG = 'rgba(124,186,124,0.32)'
const WORD_DEL_BG = 'rgba(224,122,122,0.32)'

const rowStyle = (bg: string, fg: string): React.CSSProperties => ({
  background: bg,
  color: fg,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
})

// One side of a modified line: emphasise only the tokens that changed, dim the rest.
function renderWordSegs(segs: WordSeg[], side: 'del' | 'add'): React.ReactNode {
  return segs
    .filter((s) => s.t === 'same' || s.t === side)
    .map((s, k) =>
      s.t === 'same' ? (
        <span key={k}>{s.s}</span>
      ) : (
        <span
          key={k}
          style={{ background: side === 'add' ? WORD_ADD_BG : WORD_DEL_BG, borderRadius: '2px' }}
        >
          {s.s}
        </span>
      ),
    )
}

/** Turn a line diff into coloured rows with intra-line word highlighting. */
export function renderDiffRows(diff: DiffLine[]): React.ReactNode[] {
  const rows: React.ReactNode[] = []
  for (let i = 0; i < diff.length; i++) {
    const d = diff[i]
    const next = diff[i + 1]
    if (d.t === 'del' && next && next.t === 'add') {
      const segs = wordDiff(d.s, next.s)
      rows.push(
        <div key={`d${i}`} style={rowStyle(DIFF_DEL_BG, DIFF_DEL_FG)}>
          {'− '}
          {renderWordSegs(segs, 'del')}
        </div>,
      )
      rows.push(
        <div key={`a${i}`} style={rowStyle(DIFF_ADD_BG, DIFF_ADD_FG)}>
          {'+ '}
          {renderWordSegs(segs, 'add')}
        </div>,
      )
      i++ // consumed the paired add line
      continue
    }
    rows.push(
      <div
        key={i}
        style={rowStyle(
          d.t === 'add' ? DIFF_ADD_BG : d.t === 'del' ? DIFF_DEL_BG : 'transparent',
          d.t === 'add' ? DIFF_ADD_FG : d.t === 'del' ? DIFF_DEL_FG : 'var(--text-secondary)',
        )}
      >
        {d.t === 'add' ? '+ ' : d.t === 'del' ? '− ' : '  '}
        {d.s || ' '}
      </div>,
    )
  }
  return rows
}
