// Lexical relevance ranking (BM25-lite) for "pull the right files automatically"
// — the first, model-free step toward semantic context selection. Given a
// natural-language instruction and a set of candidate documents (e.g. grep
// snippets keyed by file path), rank the documents by relevance so the Composer
// / SwarmAgent can auto-include the files that actually matter instead of relying
// on the user to pick them. Pure and dependency-free: unit-tested directly.

export interface RankDoc {
  path: string
  text: string
}

export interface RankedDoc {
  path: string
  score: number
}

// BM25 free parameters (standard defaults).
const K1 = 1.5
const B = 0.75

// Lowercased word/identifier tokens, with camelCase and snake_case split so a
// query "open composer" matches an `openComposer` identifier. Drops 1-char tokens
// and pure numbers (noise), keeps the rest.
export function tokenize(s: string): string[] {
  const out: string[] = []
  // Split on non-alphanumerics first, then split each chunk on camelCase humps.
  for (const chunk of s.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue
    for (const piece of chunk.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const tok = piece.toLowerCase()
      if (tok.length < 2) continue
      if (/^\d+$/.test(tok)) continue
      out.push(tok)
    }
  }
  return out
}

/**
 * Rank `docs` by BM25 relevance to `query`. Returns at most `k` docs with a
 * positive score, highest first; ties break by shorter path (a closer/root file
 * is usually the better default). Returns [] for an empty query/corpus.
 */
export function rankDocs(query: string, docs: RankDoc[], k = 8): RankedDoc[] {
  const qTerms = Array.from(new Set(tokenize(query)))
  if (qTerms.length === 0 || docs.length === 0) return []

  // Term frequencies per doc + document lengths.
  const docTerms = docs.map((d) => tokenize(d.text))
  const lengths = docTerms.map((t) => t.length)
  const avgdl = lengths.reduce((a, b) => a + b, 0) / docs.length || 1
  const N = docs.length

  // Document frequency per query term.
  const df = new Map<string, number>()
  for (const term of qTerms) {
    let count = 0
    for (const terms of docTerms) {
      if (terms.includes(term)) count++
    }
    df.set(term, count)
  }

  const scored: RankedDoc[] = docs.map((d, i) => {
    const terms = docTerms[i]
    const dl = lengths[i]
    let score = 0
    for (const term of qTerms) {
      const n = df.get(term) ?? 0
      if (n === 0) continue
      let tf = 0
      for (const t of terms) if (t === term) tf++
      if (tf === 0) continue
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / avgdl)))
    }
    return { path: d.path, score }
  })

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, k)
}

// ── Semantic (embedding) ranking ────────────────────────────────────────────
// Pure vector math for the embedding-based retrieval layer. Embedding generation
// itself (transformers.js) is the impure runtime in src/lib/embed.ts; this stays
// pure/testable: given precomputed vectors, score and rank.

export interface VectorDoc {
  path: string
  vector: number[]
}

/** Cosine similarity of two equal-length vectors; 0 for degenerate input. */
export function cosineSim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Rank docs by cosine similarity to `queryVec`. Returns at most `k`, highest
 * first, ties broken by shorter path. `minScore` drops weak matches (default 0).
 */
export function rankByEmbedding(queryVec: number[], docs: VectorDoc[], k = 8, minScore = 0): RankedDoc[] {
  if (queryVec.length === 0 || docs.length === 0) return []
  return docs
    .map((d) => ({ path: d.path, score: cosineSim(queryVec, d.vector) }))
    .filter((r) => r.score > minScore)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, k)
}

/**
 * Collapse chunk-level ranked results to one entry per file, keeping each file's
 * best (highest) chunk score. Used to turn a semantic index's per-chunk hits into
 * a file ranking. Returns top `k`, highest first, ties broken by shorter path.
 */
export function dedupeByPath(ranked: RankedDoc[], k = 8): RankedDoc[] {
  const best = new Map<string, number>()
  for (const r of ranked) {
    const cur = best.get(r.path)
    if (cur === undefined || r.score > cur) best.set(r.path, r.score)
  }
  return Array.from(best.entries())
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, k)
}

/**
 * Reciprocal-rank fusion of two ranked lists (lexical + semantic) into one
 * combined ranking — the standard way to blend a keyword and a vector ranker
 * without having to calibrate their incomparable score scales. A doc's fused
 * score is Σ 1/(rrfK + rank) across the lists it appears in. Returns top `k`.
 */
export function fuseRankings(lists: RankedDoc[][], k = 8, rrfK = 60): RankedDoc[] {
  const fused = new Map<string, number>()
  for (const list of lists) {
    list.forEach((doc, i) => {
      fused.set(doc.path, (fused.get(doc.path) ?? 0) + 1 / (rrfK + i + 1))
    })
  }
  return Array.from(fused.entries())
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, k)
}
