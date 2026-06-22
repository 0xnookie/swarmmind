// A small subsequence fuzzy matcher for the command palette (and anywhere else
// that wants "type a few letters, get the right thing" search). No dependency —
// the algorithm is a single forward pass that scores how tightly the query's
// characters appear, in order, inside the target.
//
// Scoring rewards: consecutive matches, matches at word boundaries / start of
// string, and matches that consume a large fraction of the target. This makes
// "ckp" rank "Checkpoints" above "Create task", and an exact prefix beat a
// scattered match. Returns the matched character indices too, so callers can
// highlight them.

export interface FuzzyResult {
  matched: boolean
  score: number
  indices: number[]
}

const isBoundary = (ch: string): boolean => ch === ' ' || ch === '-' || ch === '_' || ch === '/' || ch === '.'

export function fuzzyMatch(query: string, target: string): FuzzyResult {
  const q = query.trim().toLowerCase()
  if (!q) return { matched: true, score: 0, indices: [] }
  const t = target.toLowerCase()
  const indices: number[] = []
  let score = 0
  let qi = 0
  let prevMatch = -2 // index of the previous matched char (for consecutive bonus)

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    indices.push(ti)
    let charScore = 1
    if (ti === prevMatch + 1) charScore += 5            // consecutive run
    if (ti === 0) charScore += 8                          // very start of string
    else if (isBoundary(t[ti - 1])) charScore += 6        // start of a word
    score += charScore
    prevMatch = ti
    qi++
  }

  if (qi < q.length) return { matched: false, score: 0, indices: [] }

  // Prefer shorter targets (less "noise" around the match) and exact prefixes.
  score += Math.max(0, 12 - (t.length - q.length) * 0.15)
  if (t.startsWith(q)) score += 10
  return { matched: true, score, indices }
}
