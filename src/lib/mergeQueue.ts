// Pure logic for the merge queue UI (MergeQueue.tsx): ordering, the summary the
// header reads from, which branches are actually landable, and the prompt used
// when a conflict is handed to an agent instead of a human.
//
// The verdicts themselves come from the main process (git-manager's cumulative
// `merge-tree` simulation). This module never talks to git — it only decides
// what the user is offered once the verdicts are in, which is exactly the part
// worth asserting offline.

/** Mirrors electron/lib/mergeTree.ts's MergeVerdict (kept local so this module
 *  imports nothing and strips-and-runs in the test runner). */
export type QueueVerdict = 'clean' | 'conflict' | 'empty' | 'error'

export interface QueueRow {
  branch: string
  verdict: QueueVerdict
  conflicts: string[]
  ahead: number
  error?: string
}

/**
 * Move one entry within an ordered list, returning a new array.
 *
 * Out-of-range indices return the list unchanged rather than clamping: a drag
 * that ends outside the queue means "no reorder", and clamping would silently
 * move the row somewhere the user didn't drop it.
 */
export function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...list]
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export interface QueueSummary {
  clean: number
  conflict: number
  empty: number
  error: number
  /** Distinct files implicated in at least one conflict. */
  conflictedFiles: string[]
}

export function summarizeQueue(rows: readonly QueueRow[]): QueueSummary {
  const files = new Set<string>()
  let clean = 0, conflict = 0, empty = 0, error = 0
  for (const r of rows) {
    if (r.verdict === 'clean') clean++
    else if (r.verdict === 'conflict') { conflict++; r.conflicts.forEach(f => files.add(f)) }
    else if (r.verdict === 'empty') empty++
    else error++
  }
  return { clean, conflict, empty, error, conflictedFiles: [...files].sort() }
}

/**
 * The branches "Merge clean" would actually land, in queue order.
 *
 * Only `clean` rows qualify, and the order is preserved because the simulation
 * that produced those verdicts was itself cumulative and ordered: a row marked
 * clean means "clean *after* the clean rows above it landed". Reordering or
 * filtering differently at merge time would land a sequence nobody previewed.
 */
export function landableBranches(rows: readonly QueueRow[]): string[] {
  return rows.filter(r => r.verdict === 'clean').map(r => r.branch)
}

/** Is running the queue worth offering at all? */
export function canRunQueue(rows: readonly QueueRow[]): boolean {
  return landableBranches(rows).length > 0
}

const MAX_PROMPT_FILES = 12

/**
 * Turn a conflicting queue row into a task an agent can pick up.
 *
 * The instruction is deliberately specific about *where* the work happens — in
 * the branch's own worktree, rebasing/merging base into it — because the
 * alternative (resolving in the main checkout) would drag a half-merged state
 * into the tree every other agent is reading from.
 */
export function buildConflictTaskPrompt(
  row: QueueRow,
  base: string,
): { title: string; description: string } {
  const shown = row.conflicts.slice(0, MAX_PROMPT_FILES)
  const more = row.conflicts.length - shown.length
  const fileList = shown.length
    ? shown.join(', ') + (more > 0 ? ` (+${more} more)` : '')
    : '(git did not name the files)'
  return {
    title: `Resolve merge conflicts: ${row.branch} → ${base}`,
    description:
      `Branch "${row.branch}" does not merge cleanly into "${base}". Conflicting files: ${fileList}. ` +
      `Work inside that branch's own worktree — do NOT resolve this in the main checkout. ` +
      `Merge "${base}" into "${row.branch}", resolve every conflict so both sides' intent survives, ` +
      `make sure the project still builds, and commit the resolution on "${row.branch}". ` +
      `Do not merge into "${base}" yourself; the queue does that once the branch is clean.`,
  }
}
