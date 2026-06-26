// Dependency-free line diff (LCS), used by the Composer to preview a proposed
// file rewrite against the current file. Extracted into its own pure module so
// it can be unit-tested without pulling in React/CodeMirror.

export interface DiffLine {
  t: 'ctx' | 'add' | 'del'
  s: string
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split('\n') : []
  const b = newText.length ? newText.split('\n') : []
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ t: 'ctx', s: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: 'del', s: a[i++] })
    } else {
      out.push({ t: 'add', s: b[j++] })
    }
  }
  while (i < m) out.push({ t: 'del', s: a[i++] })
  while (j < n) out.push({ t: 'add', s: b[j++] })
  return out
}

// ---- Intra-line word diff (Composer "what changed within this line") --------
// A modified line shows up as a paired del/add in lineDiff; this refines such a
// pair down to the tokens that actually changed, so the preview can dim the
// unchanged parts and highlight only the edited words (like Cursor's diffs).

export interface WordSeg {
  t: 'same' | 'del' | 'add'
  s: string
}

// Split a line into stable tokens: identifier/number runs, whitespace runs, and
// single punctuation chars — so "foo(bar)" diffs at "foo" / "(" / "bar" / ")".
function tokenize(line: string): string[] {
  return line.match(/\w+|\s+|[^\w\s]/g) ?? []
}

/**
 * Token-level LCS between two lines, with consecutive same-type tokens merged
 * into one segment. Render the OLD line from the `same`+`del` segments and the
 * NEW line from the `same`+`add` segments (both stay in order).
 */
export function wordDiff(oldLine: string, newLine: string): WordSeg[] {
  const a = tokenize(oldLine)
  const b = tokenize(newLine)
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const raw: WordSeg[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) raw.push({ t: 'same', s: a[i++] }), j++
    else if (dp[i + 1][j] >= dp[i][j + 1]) raw.push({ t: 'del', s: a[i++] })
    else raw.push({ t: 'add', s: b[j++] })
  }
  while (i < m) raw.push({ t: 'del', s: a[i++] })
  while (j < n) raw.push({ t: 'add', s: b[j++] })
  // Coalesce adjacent same-type tokens for compact rendering.
  const out: WordSeg[] = []
  for (const seg of raw) {
    const last = out[out.length - 1]
    if (last && last.t === seg.t) last.s += seg.s
    else out.push({ ...seg })
  }
  return out
}
