import React from 'react'

// Shared renderer for raw `git diff` output: per-line +/− colouring, hunk and
// header dimming. Extracted from WorktreeReview so every surface that shows a
// git diff (worktree review, Changes panel drill-down, review-gate card) reads
// the same. Cheap and dependency-free — for word-level diffs of *proposed*
// changes (not git output) use DiffRows/lineDiff instead.
export function UnifiedDiff({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre style={preStyle}>
      {lines.map((ln, i) => {
        let color = 'var(--text-secondary)'
        let bg = 'transparent'
        if (ln.startsWith('+') && !ln.startsWith('+++')) { color = '#7ee787'; bg = 'rgba(46,160,67,0.10)' }
        else if (ln.startsWith('-') && !ln.startsWith('---')) { color = '#ff7b72'; bg = 'rgba(248,81,73,0.10)' }
        else if (ln.startsWith('@@')) color = '#79c0ff'
        else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('+++') || ln.startsWith('---')) color = 'var(--text-muted)'
        return <div key={i} style={{ color, background: bg, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{ln || ' '}</div>
      })}
    </pre>
  )
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '8px 12px',
  fontSize: 11.5,
  lineHeight: 1.5,
  fontFamily: 'var(--font-mono, monospace)',
}
