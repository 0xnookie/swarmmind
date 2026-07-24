/**
 * Pure scheduling logic for SwarmMind's recurring prompt loops (the runner is
 * `src/hooks/useLoops.ts`). Extracted per CLAUDE.md so the "when does a loop
 * next run" decision — the part with the subtle, hard-to-observe bug potential
 * (a wrong choice only shows up 30 minutes later) — is unit-tested rather than
 * only exercised by a live timer.
 *
 * The important invariant these encode: a loop that is *due* but whose target
 * pane isn't running yet must keep retrying promptly, NOT get pushed a whole
 * interval into the future. Otherwise a loop armed to run immediately (which is
 * what creating, resuming, or restoring a loop does — all set `nextRunAt` to
 * "now") silently slips a full interval whenever its pane is a moment late to
 * come online, e.g. during app restart / session resume. That is the
 * "a 30-minute loop only starts after 30 minutes" report.
 */

export interface LoopSchedule {
  enabled: boolean
  /** Epoch ms of the next scheduled run, or null when never scheduled. */
  nextRunAt: number | null
  /** Interval between runs, in seconds. */
  intervalSec: number
}

export type LoopAction =
  | 'skip'   // disabled, or scheduled for later — do nothing this tick
  | 'run'    // due and a live target exists — fire now
  | 'wait'   // due but no live target yet — leave it due and re-check next tick

/**
 * Is the loop enabled and due to fire at `now`?
 *
 * A null `nextRunAt` counts as "due now" so a freshly created / resumed /
 * restored loop runs on the very next tick — this is what makes the first run
 * immediate rather than one interval away.
 */
export function isLoopDue(loop: LoopSchedule, now: number): boolean {
  if (!loop.enabled) return false
  return loop.nextRunAt == null || now >= loop.nextRunAt
}

/**
 * The single per-tick decision for one loop. `hasLiveTarget` is whether any of
 * its target panes is currently running (resolved impurely by the caller).
 *
 * Crucially, the no-target case returns `wait`, not a reschedule: the loop
 * stays due and is retried on the next (1s) tick, so it fires the instant its
 * pane comes online instead of slipping a whole interval.
 */
export function decideLoopAction(loop: LoopSchedule, hasLiveTarget: boolean, now: number): LoopAction {
  if (!isLoopDue(loop, now)) return 'skip'
  return hasLiveTarget ? 'run' : 'wait'
}

/** Next-run time after a successful run: exactly one interval out. */
export function nextRunAfter(now: number, intervalSec: number): number {
  return now + Math.max(1, intervalSec) * 1000
}
