// Persistent workspace-wide semantic index. Chunks every text/code file, embeds
// the chunks once (on-device, via embed.ts), and persists the vectors to
// {root}/.swarmmind/vector-index.json so retrieval can rank the WHOLE repo by
// meaning — not just files that happen to grep-match the query terms. This is the
// impure runtime (fs + embeddings); the math it relies on is pure and unit-tested
// (chunk.ts, retrieval.ts::rankByEmbedding/dedupeByPath).

import { chunkText } from './chunk'
import { embedTexts } from './embed'
import { rankByEmbedding, dedupeByPath, type RankedDoc } from './retrieval'
import { INDEXABLE, extOf as extOfPath, isIndexablePath, planIncrementalUpdate, mergeIndexEntries } from './indexUpdate'

const INDEX_VERSION = 1
const INDEX_MODEL = 'Xenova/all-MiniLM-L6-v2'
const INDEX_REL = '.swarmmind/vector-index.json'

// Bound the work so a huge repo can't run for ages or write a giant file.
const MAX_FILES = 600
const MAX_CHUNKS = 1500
const MAX_FILE_BYTES = 120_000
const CHUNK_MAX_LINES = 40
const CHUNK_OVERLAP = 8
const EMBED_BATCH = 16

export interface IndexChunk {
  path: string
  startLine: number
  endLine: number
  vector: number[]
}

interface PersistedIndex {
  version: number
  model: string
  builtAt: number
  entries: IndexChunk[]
}

export interface IndexStats {
  files: number
  chunks: number
}

const extOf = extOfPath

// Build and incremental-update both rewrite the persisted file; serialize them
// so a debounced update can never clobber a concurrent full rebuild.
let indexLock: Promise<unknown> = Promise.resolve()
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexLock.then(fn)
  indexLock = run.catch(() => undefined)
  return run
}

/**
 * Build (or rebuild) the semantic index for a workspace and persist it. Bounded
 * by the MAX_* caps. `onProgress(done,total)` reports embedding progress. Throws
 * if embeddings are unavailable (callers fall back to lexical retrieval).
 */
export function buildIndex(
  rootPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<IndexStats> {
  return withIndexLock(() => buildIndexInner(rootPath, onProgress))
}

async function buildIndexInner(
  rootPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<IndexStats> {
  const rootFwd = rootPath.replace(/\\/g, '/')
  const all = await window.swarmmind.fsListFiles(rootPath, 6000)
  const files = all.map((f) => f.replace(/\\/g, '/')).filter((f) => INDEXABLE.has(extOf(f))).slice(0, MAX_FILES)

  // Collect chunks across files up to the global cap.
  const pending: { path: string; startLine: number; endLine: number; text: string }[] = []
  for (const rel of files) {
    if (pending.length >= MAX_CHUNKS) break
    let content: string
    try {
      content = await window.swarmmind.fsReadFile(`${rootFwd}/${rel}`)
    } catch {
      continue
    }
    if (content.length > MAX_FILE_BYTES) content = content.slice(0, MAX_FILE_BYTES)
    for (const c of chunkText(content, CHUNK_MAX_LINES, CHUNK_OVERLAP)) {
      if (pending.length >= MAX_CHUNKS) break
      pending.push({ path: rel, ...c })
    }
  }

  // Embed in batches so progress advances and memory stays bounded.
  const entries: IndexChunk[] = []
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH)
    const vectors = await embedTexts(batch.map((b) => b.text))
    batch.forEach((b, j) => {
      entries.push({ path: b.path, startLine: b.startLine, endLine: b.endLine, vector: vectors[j] })
    })
    onProgress?.(Math.min(i + EMBED_BATCH, pending.length), pending.length)
  }

  const payload: PersistedIndex = { version: INDEX_VERSION, model: INDEX_MODEL, builtAt: Date.now(), entries }
  await window.swarmmind.fsWriteFile(`${rootFwd}/${INDEX_REL}`, JSON.stringify(payload))

  const indexedFiles = new Set(entries.map((e) => e.path)).size
  return { files: indexedFiles, chunks: entries.length }
}

/** Load a persisted index, or null when none exists / it's stale / unreadable. */
export async function loadIndex(rootPath: string): Promise<IndexChunk[] | null> {
  const rootFwd = rootPath.replace(/\\/g, '/')
  try {
    const txt = await window.swarmmind.fsReadFile(`${rootFwd}/${INDEX_REL}`)
    const parsed = JSON.parse(txt) as PersistedIndex
    if (parsed.version !== INDEX_VERSION || parsed.model !== INDEX_MODEL) return null
    if (!Array.isArray(parsed.entries)) return null
    return parsed.entries
  } catch {
    return null
  }
}

/**
 * Rank the index's files by semantic similarity to `query`. Embeds the query,
 * scores every chunk (rankByEmbedding), then collapses to one row per file
 * keeping its best chunk (dedupeByPath). Returns [] if the index is empty.
 */
export async function queryIndex(entries: IndexChunk[], query: string, k = 8): Promise<RankedDoc[]> {
  if (entries.length === 0) return []
  const [queryVec] = await embedTexts([query])
  const perChunk = rankByEmbedding(
    queryVec,
    entries.map((e) => ({ path: e.path, vector: e.vector })),
    entries.length,
    0.15, // drop very weak chunk matches
  )
  return dedupeByPath(perChunk, k)
}

// ── Incremental freshness ─────────────────────────────────────────────────────
// The full build is a manual button, so the index goes stale the moment an agent
// edits a file. `noteFileChanged` (fed from the Phase-2 file-watcher's
// `file_changed` swarm events, see App.tsx) queues touched paths and, after a
// quiet period, re-embeds just those files and rewrites the persisted index —
// retrieval stays fresh while the swarm works. No-ops entirely when no index has
// been built (the user hasn't opted in) and stays best-effort throughout.
// Note: watcher paths are relative to the *pane's* working directory; we re-read
// the main checkout's copy, which is what the root-scoped index represents.

const FLUSH_QUIET_MS = 5_000
const MAX_FILES_PER_FLUSH = 24

const dirtyByRoot = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> | null }>()

/** Queue a changed workspace-relative path for incremental re-embedding. */
export function noteFileChanged(rootPath: string, relPath: string): void {
  if (!isIndexablePath(relPath)) return
  let entry = dirtyByRoot.get(rootPath)
  if (!entry) {
    entry = { paths: new Set(), timer: null }
    dirtyByRoot.set(rootPath, entry)
  }
  entry.paths.add(relPath.replace(/\\/g, '/'))
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    const batch = planIncrementalUpdate(entry.paths, MAX_FILES_PER_FLUSH)
    entry.paths.clear()
    if (batch.length) {
      updateIndexForFiles(rootPath, batch).catch(() => { /* best-effort freshness */ })
    }
  }, FLUSH_QUIET_MS)
}

/**
 * Re-embed the given files and merge them into the persisted index. Returns the
 * updated stats, or null when no (valid) index exists — incremental updates only
 * run once the user has built one. Unreadable/deleted files simply have their
 * stale chunks dropped.
 */
export function updateIndexForFiles(rootPath: string, relPaths: string[]): Promise<IndexStats | null> {
  return withIndexLock(async () => {
    const entries = await loadIndex(rootPath)
    if (!entries) return null
    const rootFwd = rootPath.replace(/\\/g, '/')
    let merged = entries
    for (const rel of relPaths) {
      let fresh: IndexChunk[] = []
      try {
        let content = await window.swarmmind.fsReadFile(`${rootFwd}/${rel}`)
        if (content.length > MAX_FILE_BYTES) content = content.slice(0, MAX_FILE_BYTES)
        const chunks = chunkText(content, CHUNK_MAX_LINES, CHUNK_OVERLAP)
        const vectors = await embedTexts(chunks.map((c) => c.text))
        fresh = chunks.map((c, i) => ({ path: rel, startLine: c.startLine, endLine: c.endLine, vector: vectors[i] }))
      } catch {
        // Deleted or unreadable — fall through with fresh = [] to drop its entries.
      }
      merged = mergeIndexEntries(merged, rel, fresh, MAX_CHUNKS)
    }
    const payload: PersistedIndex = { version: INDEX_VERSION, model: INDEX_MODEL, builtAt: Date.now(), entries: merged }
    await window.swarmmind.fsWriteFile(`${rootFwd}/${INDEX_REL}`, JSON.stringify(payload))
    return { files: new Set(merged.map((e) => e.path)).size, chunks: merged.length }
  })
}
