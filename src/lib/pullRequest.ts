// Composing the title and body of a pull request from what the swarm actually
// did, so the loop from "agents finished" to "a teammate can review it" doesn't
// pass through a blank textarea.
//
// The body has two halves and they answer different questions. The git half
// (commits, files) is what any PR has. The swarm half is the part only this app
// can write: which agents worked on it, how many tasks, what it cost. That's
// derived from the same event log the Swarm Timeline exports, via the same pure
// `buildSessionStats`, so the PR description and the session report can never
// disagree about a run.
//
// Pure and dependency-free — including of sessionExport: the swarm digest
// arrives as an already-rendered string (`renderSwarmDigest` lives next to the
// stats it reads). Keeping the import list empty is what lets both modules
// strip-and-run in the test runner with no build step, per CLAUDE.md.

export interface PrCommit {
  hash: string
  subject: string
}

export interface PrFile {
  path: string
  additions: number
  deletions: number
}

/** Branch names are machine-shaped; a PR title is read by a person. */
export function humanizeBranch(branch: string): string {
  const leaf = branch.replace(/^swarmmind\//, '').split('/').pop() ?? branch
  const words = leaf.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return branch
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Default PR title.
 *
 * A single commit's subject is almost always the better title — it's what the
 * author already wrote to describe exactly this change. Only when there are
 * several (or none) does the branch name become the best available summary.
 */
export function defaultPrTitle(branch: string, commits: readonly PrCommit[]): string {
  if (commits.length === 1 && commits[0].subject.trim()) return commits[0].subject.trim()
  return humanizeBranch(branch)
}

const MAX_COMMITS = 20
const MAX_FILES = 30

export interface PrBodyInput {
  branch: string
  base: string
  commits: readonly PrCommit[]
  files: readonly PrFile[]
  /** Pane/agent that produced the branch, when known. */
  agent?: string | null
  paneTitle?: string | null
  /**
   * Pre-rendered swarm summary (sessionExport's `renderSwarmDigest`). Empty or
   * omitted renders no section at all — an empty "## Swarm session" heading in
   * someone's pull request is worse than no heading.
   */
  swarmDigest?: string
}

export function buildPrBody(i: PrBodyInput): string {
  const out: string[] = []

  const who = i.paneTitle || i.agent
  out.push(
    who
      ? `Work from SwarmMind pane **${who}** on \`${i.branch}\`, targeting \`${i.base}\`.`
      : `Work from SwarmMind branch \`${i.branch}\`, targeting \`${i.base}\`.`
  )
  out.push('')

  if (i.commits.length) {
    out.push('## Commits')
    out.push('')
    for (const c of i.commits.slice(0, MAX_COMMITS)) out.push(`- \`${c.hash}\` ${c.subject}`)
    if (i.commits.length > MAX_COMMITS) out.push(`- …and ${i.commits.length - MAX_COMMITS} more`)
    out.push('')
  }

  if (i.files.length) {
    const adds = i.files.reduce((s, f) => s + f.additions, 0)
    const dels = i.files.reduce((s, f) => s + f.deletions, 0)
    out.push(`## Files changed (${i.files.length}, +${adds} −${dels})`)
    out.push('')
    for (const f of i.files.slice(0, MAX_FILES)) out.push(`- \`${f.path}\` +${f.additions} −${f.deletions}`)
    if (i.files.length > MAX_FILES) out.push(`- …and ${i.files.length - MAX_FILES} more`)
    out.push('')
  }

  const swarm = (i.swarmDigest ?? '').trim()
  if (swarm) { out.push(swarm); out.push('') }

  out.push('---')
  out.push('')
  out.push('🐝 Opened from [SwarmMind](https://github.com/0xnookie/swarmmind)')
  return out.join('\n')
}
