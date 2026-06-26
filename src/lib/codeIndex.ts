// Persistent workspace-wide semantic index. Chunks every text/code file, embeds
// the chunks once (on-device, via embed.ts), and persists the vectors to
// {root}/.swarmmind/vector-index.json so retrieval can rank the WHOLE repo by
// meaning — not just files that happen to grep-match the query terms. This is the
// impure runtime (fs + embeddings); the math it relies on is pure and unit-tested
// (chunk.ts, retrieval.ts::rankByEmbedding/dedupeByPath).

import { chunkText } from './chunk'
import { embedTexts } from './embed'
import { rankByEmbedding, dedupeByPath, type RankedDoc } from './retrieval'

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

// Code/text extensions worth indexing. Mirrors the spirit of the @-mention index.
const INDEXABLE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'json', 'css', 'scss', 'less',
  'html', 'md', 'mdx', 'py', 'rs', 'go', 'java', 'kt', 'rb', 'php', 'c', 'h', 'cpp',
  'hpp', 'cs', 'swift', 'sh', 'yml', 'yaml', 'toml', 'sql', 'vue', 'svelte', 'txt',
])

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

function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i === -1 ? '' : path.slice(i + 1).toLowerCase()
}

/**
 * Build (or rebuild) the semantic index for a workspace and persist it. Bounded
 * by the MAX_* caps. `onProgress(done,total)` reports embedding progress. Throws
 * if embeddings are unavailable (callers fall back to lexical retrieval).
 */
export async function buildIndex(
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
