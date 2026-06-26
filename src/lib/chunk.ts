// Split a source file into overlapping line windows for embedding — the unit a
// semantic codebase index stores and retrieves. Overlap keeps a construct that
// straddles a window boundary findable from either side. Pure and dependency-free
// (unit-tested); the index that embeds and persists these chunks is codeIndex.ts.

export interface Chunk {
  /** 1-based first line of the window (inclusive). */
  startLine: number
  /** 1-based last line of the window (inclusive). */
  endLine: number
  text: string
}

/**
 * Break `content` into windows of up to `maxLines`, each overlapping the previous
 * by `overlap` lines. Blank-only chunks are dropped. Returns [] for empty input.
 * `overlap` is clamped to < maxLines so the window always advances.
 */
export function chunkText(content: string, maxLines = 40, overlap = 8): Chunk[] {
  if (!content.trim()) return []
  const lines = content.split('\n')
  const step = Math.max(1, maxLines - Math.max(0, Math.min(overlap, maxLines - 1)))
  const out: Chunk[] = []
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + maxLines, lines.length)
    const text = lines.slice(start, end).join('\n')
    if (text.trim()) {
      out.push({ startLine: start + 1, endLine: end, text })
    }
    if (end >= lines.length) break
  }
  return out
}
