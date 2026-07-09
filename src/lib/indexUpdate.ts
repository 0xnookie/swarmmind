// Pure logic for keeping the persistent semantic index (codeIndex.ts) fresh as
// files change: which paths are worth re-embedding, and how freshly embedded
// chunks replace a file's stale entries without blowing the global cap.
// Dependency-free so it strips-and-runs in the unit tests; the impure runtime
// (fs reads, embeddings, debounce timer) lives in codeIndex.ts.

// Code/text extensions worth indexing. Single source of truth — codeIndex.ts
// imports these for the full build too.
export const INDEXABLE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'json', 'css', 'scss', 'less',
  'html', 'md', 'mdx', 'py', 'rs', 'go', 'java', 'kt', 'rb', 'php', 'c', 'h', 'cpp',
  'hpp', 'cs', 'swift', 'sh', 'yml', 'yaml', 'toml', 'sql', 'vue', 'svelte', 'txt',
])

// Never worth (re-)embedding: deps, VCS, build output, our own state dir.
const SKIP_RE = /(^|\/)(node_modules|\.git|\.swarmmind|dist|out|build|\.next|\.cache|\.turbo|coverage|__pycache__|\.venv|target)(\/|$)/

export function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i === -1 ? '' : path.slice(i + 1).toLowerCase()
}

/** True when a (workspace-relative) path should live in the semantic index. */
export function isIndexablePath(rel: string): boolean {
  const fwd = rel.replace(/\\/g, '/')
  if (!fwd || fwd.length > 500) return false
  if (SKIP_RE.test(fwd)) return false
  return INDEXABLE.has(extOf(fwd))
}

/**
 * Normalize, filter and cap a batch of changed paths for one incremental
 * update pass. Dedupes (a burst of saves to one file re-embeds it once) and
 * keeps only indexable paths, preserving first-seen order.
 */
export function planIncrementalUpdate(paths: Iterable<string>, max = 24): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    const fwd = raw.replace(/\\/g, '/')
    if (seen.has(fwd)) continue
    seen.add(fwd)
    if (!isIndexablePath(fwd)) continue
    out.push(fwd)
    if (out.length >= max) break
  }
  return out
}

export interface MergeableChunk {
  path: string
  startLine: number
  endLine: number
  vector: number[]
}

/**
 * Replace one file's chunks in the index with freshly embedded ones. A deleted
 * file passes `fresh: []`, which simply drops its stale entries. When the cap
 * would be exceeded, the oldest entries of *other* files are trimmed (the array
 * is append-ordered, so the front is the stalest) — the fresh chunks always
 * survive in full.
 */
export function mergeIndexEntries<T extends MergeableChunk>(
  entries: T[],
  path: string,
  fresh: T[],
  maxChunks = 1500,
): T[] {
  const kept = entries.filter((e) => e.path !== path)
  const room = Math.max(0, maxChunks - fresh.length)
  const trimmed = kept.length > room ? kept.slice(kept.length - room) : kept
  return [...trimmed, ...fresh]
}
