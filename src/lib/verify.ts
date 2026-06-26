// Control logic for the Composer's verify→fix loop (the safe, human-in-the-loop
// core of "agent-mode iteration"): after applying AI changes, run one of the
// workspace's OWN npm scripts (typecheck/test/lint/build) and, on failure, feed a
// concise error summary back to the model to self-correct. This module is pure —
// it parses the available scripts, picks a sensible default, and condenses raw
// command output into a feedback summary. Actually running the script is the
// constrained `verify:run` IPC (npm scripts only, execFile, no shell). Unit-tested.

// Scripts that make sense as a "verify" step, best first. Used to pick a default
// and to order the picker.
const VERIFY_PRIORITY = ['typecheck', 'tsc', 'check', 'test', 'lint', 'build']

/** Parse the `scripts` map out of a package.json text; [] on any parse error. */
export function parseScripts(pkgJsonText: string): string[] {
  try {
    const pkg = JSON.parse(pkgJsonText) as { scripts?: Record<string, unknown> }
    if (!pkg.scripts || typeof pkg.scripts !== 'object') return []
    return Object.keys(pkg.scripts).filter((k) => typeof pkg.scripts![k] === 'string')
  } catch {
    return []
  }
}

/** Order scripts with verify-ish ones first, preserving the rest. */
export function orderVerifyScripts(scripts: string[]): string[] {
  const rank = (s: string) => {
    const i = VERIFY_PRIORITY.indexOf(s.toLowerCase())
    return i === -1 ? VERIFY_PRIORITY.length : i
  }
  return [...scripts].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** The best default verify script, or null when none of the priorities exist. */
export function pickVerifyScript(scripts: string[]): string | null {
  for (const pref of VERIFY_PRIORITY) {
    const hit = scripts.find((s) => s.toLowerCase() === pref)
    if (hit) return hit
  }
  return null
}

/**
 * A script name is safe to pass to the runner only if it matches this strict
 * charset. On Windows `npm` is `npm.cmd`, which Node can only spawn via a shell —
 * so the script name must not be able to carry shell metacharacters even though
 * it's also checked against the package's declared scripts (a malicious cloned
 * repo could declare a script key containing metacharacters). Defense-in-depth.
 */
export function isSafeScriptName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && /^[A-Za-z0-9:_-]+$/.test(name)
}

export interface RunOutcome {
  code: number
  stdout: string
  stderr: string
}

/** A non-zero exit code means the verify step failed. */
export function isFailure(outcome: RunOutcome): boolean {
  return outcome.code !== 0
}

/**
 * Decide the next step of the autonomous verify→fix loop. `round` is the number
 * of fix attempts already made; `maxRounds` caps them. Returns 'pass' when the
 * last run succeeded, 'retry' to attempt another fix, or 'exhausted' when the cap
 * is hit without success — keeping the loop bounded and unable to spin forever.
 */
export function verifyLoopStatus(round: number, maxRounds: number, ok: boolean): 'pass' | 'retry' | 'exhausted' {
  if (ok) return 'pass'
  if (round >= maxRounds) return 'exhausted'
  return 'retry'
}

/**
 * Condense raw command output into a compact summary to feed back to the model.
 * Prefers lines that look like errors (TS####, "error", "failed", file:line:col),
 * falling back to the tail of the combined output. Bounded to `maxLines`.
 */
export function summarizeFailure(outcome: RunOutcome, maxLines = 40): string {
  const combined = `${outcome.stdout}\n${outcome.stderr}`
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0)

  const errorLike = combined.filter((l) =>
    /\berror\b|\bfailed\b|\bTS\d{3,}\b|^\s*✖|\)\s*$|:\d+:\d+/i.test(l),
  )
  const chosen = (errorLike.length > 0 ? errorLike : combined.slice(-maxLines)).slice(0, maxLines)
  return chosen.join('\n')
}

/**
 * Build the follow-up instruction that re-runs the Composer with the failure as
 * context, so the model fixes its own change. `original` is the user's first
 * instruction; `script` is what was run; `summary` is summarizeFailure output.
 */
export function buildFixInstruction(original: string, script: string, summary: string): string {
  return (
    `${original}\n\n` +
    `The previous change was applied but \`npm run ${script}\` then failed. ` +
    `Fix the errors below. Return the corrected full file contents for every file that needs to change.\n\n` +
    `--- ${script} output ---\n${summary}`
  )
}
