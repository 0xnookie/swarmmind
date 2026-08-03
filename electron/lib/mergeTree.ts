// Parsing for `git merge-tree --write-tree`, the plumbing behind the merge
// queue's pre-flight check.
//
// WHY THIS COMMAND: the whole point of the queue is to answer "would this land
// cleanly?" *without* touching anybody's working tree. `git merge` would have to
// actually merge and then abort, which mutates the main checkout — while agents
// are still writing to it — and leaves a window where a crash strands the user
// mid-merge. `merge-tree` performs the same three-way merge entirely in the
// object database and hands back a tree, so a preview costs nothing and can be
// re-run on every refresh.
//
// Output shape (confirmed against git 2.47):
//
//     <tree oid>
//     <conflicted path>          ← repeated; with --name-only these are bare paths
//     <blank line>
//     Auto-merging f.txt         ← informational messages
//     CONFLICT (content): …
//
// A clean merge prints the tree oid alone. The exit code is the authoritative
// signal — 0 clean, 1 conflicts, >1 the command itself failed — so the section
// split below is only used to *name* the conflicts, never to decide whether
// there were any. That matters because the informational block is free-form
// English that git is allowed to reword between versions.

export interface MergeTreeResult {
  /** Tree oid of the merged result; null when git errored outright. */
  tree: string | null
  /** Paths that could not be auto-merged (empty on a clean merge). */
  conflicts: string[]
  /** Git's own informational block, kept verbatim for the error case. */
  messages: string
}

const OID_RE = /^[0-9a-f]{7,64}$/i

export function parseMergeTree(stdout: string, exitCode: number): MergeTreeResult {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n')
  const first = (lines[0] ?? '').trim()
  const tree = OID_RE.test(first) ? first : null

  // git ran but produced nothing we recognise — treat the whole output as the
  // error message rather than inventing a result.
  if (!tree) return { tree: null, conflicts: [], messages: stdout.trim() }

  if (exitCode === 0) return { tree, conflicts: [], messages: '' }

  const conflicts: string[] = []
  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') break
    conflicts.push(line.trim())
  }
  return {
    tree,
    // Dedupe: a path conflicting in several ways (content + mode) is listed once
    // per reason, which would otherwise inflate the queue's conflict count.
    conflicts: [...new Set(conflicts)],
    messages: lines.slice(i + 1).join('\n').trim(),
  }
}

// ── Queue verdicts ───────────────────────────────────────────────────────────

export type MergeVerdict =
  | 'clean' //     merges without conflicts onto the accumulated head
  | 'conflict' //  needs a human (or an agent) to resolve
  | 'empty' //     nothing to merge — no commits ahead of base
  | 'error' //     git couldn't answer (unrelated histories, bad ref, old git)

/**
 * Verdict for one queue entry. `ahead` short-circuits before git is consulted:
 * a branch with no commits of its own is not a merge that might conflict, it's a
 * row the user should be told to commit first — reporting it as "clean" would
 * imply there was something to land.
 */
export function mergeVerdict(i: { ahead: number; exitCode: number; tree: string | null }): MergeVerdict {
  if (i.ahead <= 0) return 'empty'
  if (i.tree === null || i.exitCode > 1) return 'error'
  return i.exitCode === 0 ? 'clean' : 'conflict'
}

/**
 * Does a clean result advance the simulated head?
 *
 * Only a clean merge does. A conflicting entry is simulated *as if skipped*, so
 * the rows after it answer "what happens if I land the rest" — which is the
 * decision the user actually faces. Advancing on a conflict would mean every
 * subsequent row is measured against a state that can't exist.
 */
export function advancesHead(verdict: MergeVerdict): boolean {
  return verdict === 'clean'
}
