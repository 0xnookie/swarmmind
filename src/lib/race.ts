// ── Race mode (pure) ─────────────────────────────────────────────────────────
//
// Best-of-N, at agent granularity: give the *same* task to two or three agents
// at once, each in its own git worktree, then compare what they produced and
// keep one. Sampling several attempts and picking the best is standard practice
// inside a model; SwarmMind is in the unusual position of being able to do it
// across whole agents — Claude Code, Codex and a local model can attempt the
// same change simultaneously because the pane model already isolates them.
//
// This module is the decision logic: who is allowed to enter a race, what each
// racer is told, which files the attempts disagree on, and exactly what happens
// to the losing branches when a winner is picked. The impure shell (PTY
// injection, git calls, dialogs) lives in RacePanel.tsx.
//
// Dependency-free so it strip-and-runs in tests/lib-units.mts.

export interface RacePane {
  paneId: string
  agentId: string | null
  title: string
  /** Materialised worktree branch — absent means the pane isn't isolated. */
  branch: string | null
  worktreePath: string | null
  running: boolean
}

export type IneligibleReason = 'not-running' | 'no-worktree'

export interface Eligibility {
  eligible: RacePane[]
  ineligible: { pane: RacePane; reason: IneligibleReason }[]
}

/**
 * Who can race.
 *
 * The worktree requirement is the load-bearing one and it is not a nicety: two
 * agents told to attempt the same change in the same checkout would write over
 * each other's files, and the "comparison" at the end would be one incoherent
 * mixture of both attempts rather than two things to choose between. A pane
 * without an isolated branch is therefore excluded rather than silently
 * included — and the reason is reported so the user can fix it, since "my pane
 * isn't in the list" is otherwise unexplainable.
 */
export function raceEligibility(panes: readonly RacePane[]): Eligibility {
  const eligible: RacePane[] = []
  const ineligible: { pane: RacePane; reason: IneligibleReason }[] = []
  for (const p of panes) {
    if (!p.running) ineligible.push({ pane: p, reason: 'not-running' })
    else if (!p.branch || !p.worktreePath) ineligible.push({ pane: p, reason: 'no-worktree' })
    else eligible.push(p)
  }
  return { eligible, ineligible }
}

/** A race needs a field. One attempt is just a dispatch. */
export function canStartRace(selectedPaneIds: readonly string[], goal: string): boolean {
  return new Set(selectedPaneIds).size >= 2 && goal.trim().length > 0
}

/**
 * What each racer is told.
 *
 * Three instructions carry weight. Racers must **not** coordinate — the whole
 * value of N attempts is that they're independent, and agents sharing a memory
 * server will happily converge on one plan if not told otherwise. They must stay
 * in their own worktree, or they'd trample the comparison. And they must
 * **commit**, because an uncommitted attempt can't be diffed against base as a
 * branch and can't be merged when it wins.
 */
export function buildRacePrompt(goal: string, attempt: number, total: number): string {
  return (
    `[SwarmMind race ${attempt}/${total}] You are one of ${total} agents independently attempting the SAME task. ` +
    `Work ONLY inside your own git worktree — do not touch the main checkout, and do not coordinate with the other agents ` +
    `(no send_message, no shared memory for this task): independent attempts are the point. ` +
    `Solve it your own way, then COMMIT your work on your branch so it can be compared and merged. TASK: ${goal.trim()}`
  )
}

export interface AttemptStat {
  files: string[]
  additions: number
  deletions: number
}

export type AttemptState = 'waiting' | 'working' | 'ready' | 'gone'

/**
 * What an attempt's card shows.
 *
 * 'ready' is driven by *changed files*, not by the pane going idle: an agent can
 * fall quiet mid-thought, and an attempt with no diff is nothing to compare
 * whatever its pane is doing.
 */
export function attemptState(i: { running: boolean; working: boolean; stat: AttemptStat | undefined }): AttemptState {
  if (!i.running) return 'gone'
  if (i.stat && i.stat.files.length > 0) return 'ready'
  return i.working ? 'working' : 'waiting'
}

/** Total lines moved — the one-number size of an attempt. */
export function churn(stat: AttemptStat | undefined): number {
  return stat ? stat.additions + stat.deletions : 0
}

/**
 * Files that more than one attempt touched, most-contested first.
 *
 * This is where the attempts actually disagree, and it's the first thing worth
 * reading in a comparison: a file only one agent touched is a difference in
 * approach, while a file all three rewrote is the crux of the task.
 */
export function contestedFiles(attempts: readonly { paneId: string; stat: AttemptStat | undefined }[]): { path: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const a of attempts) {
    // Per attempt, count a path once even if it somehow appears twice.
    for (const p of new Set(a.stat?.files ?? [])) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
}

export interface WinnerPlan {
  /** Branch to merge into base. */
  keep: { paneId: string; branch: string; worktreePath: string }
  /** Attempts to tear down — worktree removed and branch deleted. */
  discard: { paneId: string; branch: string; worktreePath: string }[]
}

/**
 * Picking a winner: merge one branch, drop the rest.
 *
 * Returns null when the winner isn't in the race — the caller must not fall back
 * to "discard everything", which is what a lenient implementation of this would
 * quietly do the first time a pane closed mid-race.
 */
export function planWinner(attempts: readonly RacePane[], winnerPaneId: string): WinnerPlan | null {
  const usable = attempts.filter(
    (a): a is RacePane & { branch: string; worktreePath: string } => !!a.branch && !!a.worktreePath,
  )
  const winner = usable.find(a => a.paneId === winnerPaneId)
  if (!winner) return null
  return {
    keep: { paneId: winner.paneId, branch: winner.branch, worktreePath: winner.worktreePath },
    discard: usable
      .filter(a => a.paneId !== winnerPaneId)
      .map(a => ({ paneId: a.paneId, branch: a.branch, worktreePath: a.worktreePath })),
  }
}
