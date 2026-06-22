import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, isAbsolute } from 'path'
import { tmpdir } from 'os'
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'

const execFileAsync = promisify(execFile)

// All worktrees for a workspace live under {root}/.swarmmind/worktrees/<dir>.
// .swarmmind already holds memory.db / scrollback, so it's expected to be
// git-ignored; we additionally add it to .git/info/exclude (see ensureExcluded)
// so a freshly cloned repo never shows the worktrees as untracked.
const WORKTREES_SUBDIR = join('.swarmmind', 'worktrees')

export interface WorktreeInfo {
  path: string
  branch: string
}

// Run git in `root`, returning trimmed stdout. Throws on non-zero exit.
async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trim()
}

// Like git(), but with an overlaid environment — used to point GIT_INDEX_FILE at
// a throwaway index so we can stage a working-tree snapshot without disturbing
// the user's real index.
async function gitEnv(root: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, ...env },
  })
  return stdout.trim()
}

export async function isRepo(root: string): Promise<boolean> {
  try {
    const out = await git(root, ['rev-parse', '--is-inside-work-tree'])
    return out === 'true'
  } catch {
    return false
  }
}

// Turn an arbitrary hint into a valid git branch name (minus the swarmmind/
// prefix the caller adds). Git forbids spaces and a set of special characters;
// we collapse anything outside [a-z0-9-_] to a single dash.
function sanitizeRef(hint: string): string {
  const cleaned = hint
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'pane'
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

// Append `.swarmmind/` to the repo's shared exclude file once, so the worktrees
// directory never pollutes `git status` in the main working tree.
async function ensureExcluded(root: string): Promise<void> {
  try {
    const commonDir = await git(root, ['rev-parse', '--git-common-dir'])
    const gitDir = isAbsolute(commonDir) ? commonDir : join(root, commonDir)
    const excludePath = join(gitDir, 'info', 'exclude')
    let current = ''
    if (existsSync(excludePath)) current = readFileSync(excludePath, 'utf-8')
    if (!current.split(/\r?\n/).some(l => l.trim() === '.swarmmind/')) {
      const prefix = current.length && !current.endsWith('\n') ? '\n' : ''
      appendFileSync(excludePath, `${prefix}.swarmmind/\n`)
    }
  } catch { /* best-effort; a user .gitignore is the fallback */ }
}

// Create (or resolve, if it already exists) an isolated worktree for a pane.
// Idempotent: on resume the persisted path already exists and is returned as-is.
export async function createWorktree(root: string, paneId: string, branchHint?: string): Promise<WorktreeInfo> {
  if (!(await isRepo(root))) throw new Error('Workspace is not a git repository')

  const slug = sanitizeRef(branchHint || `pane-${paneId.slice(0, 8)}`)
  const branch = `swarmmind/${slug}`
  const dirName = `${slug}-${paneId.slice(0, 8)}`
  const worktreePath = join(root, WORKTREES_SUBDIR, dirName)

  await ensureExcluded(root)

  // Already materialised (e.g. session resume) — reuse it.
  if (existsSync(join(worktreePath, '.git'))) return { path: worktreePath, branch }

  const parent = join(root, WORKTREES_SUBDIR)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })

  if (await branchExists(root, branch)) {
    // Branch survived a previous worktree removal — re-check it out.
    await git(root, ['worktree', 'add', worktreePath, branch])
  } else {
    await git(root, ['worktree', 'add', '-b', branch, worktreePath])
  }
  return { path: worktreePath, branch }
}

// Remove a pane's worktree. Uses --force so uncommitted scratch files don't block
// removal; the branch is kept by default so committed work is never lost.
export async function removeWorktree(
  root: string,
  worktreePath: string,
  branch?: string,
  deleteBranch = false
): Promise<void> {
  if (existsSync(worktreePath)) {
    await git(root, ['worktree', 'remove', worktreePath, '--force'])
  } else {
    // Path gone but git may still track it — prune the stale registration.
    await git(root, ['worktree', 'prune'])
  }
  if (deleteBranch && branch) {
    try { await git(root, ['branch', '-D', branch]) } catch { /* unmerged / missing */ }
  }
}

// ── Diff / review / merge ───────────────────────────────────────────────────
// The base for a worktree's review is whatever branch the *main* checkout is on
// — i.e. "what would I be merging this into." Diffs run from inside the worktree
// with a single ref, so they include both committed branch work and the agent's
// uncommitted changes (the common case, since agents don't always commit).

export interface WorktreeFileChange {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

export interface WorktreeDiffStat {
  base: string
  ahead: number   // commits on the branch not on base
  behind: number  // commits on base not on the branch
  hasUncommitted: boolean
  files: WorktreeFileChange[]
}

export async function getBaseBranch(root: string): Promise<string> {
  try {
    return await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return 'HEAD'
  }
}

export async function worktreeDiffStat(root: string, worktreePath: string, baseRef?: string): Promise<WorktreeDiffStat> {
  const base = baseRef || (await getBaseBranch(root))

  // Per-file add/del counts including uncommitted changes (diff <ref> compares
  // the ref to the working tree).
  let files: WorktreeFileChange[] = []
  try {
    const numstat = await git(worktreePath, ['diff', '--numstat', base])
    files = numstat
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const [add, del, ...rest] = line.split('\t')
        const path = rest.join('\t')
        const binary = add === '-' || del === '-'
        return { path, additions: binary ? 0 : Number(add) || 0, deletions: binary ? 0 : Number(del) || 0, binary }
      })
  } catch { /* base unresolvable / not a repo — leave empty */ }

  let ahead = 0
  let behind = 0
  try {
    // Run from the worktree so HEAD is the branch's HEAD. left = behind (commits
    // on base not on branch), right = ahead (commits on branch not on base).
    const counts = await git(worktreePath, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
    const [b, a] = counts.split(/\s+/).map(n => Number(n) || 0)
    behind = b
    ahead = a
  } catch { /* unrelated histories, etc. */ }

  let hasUncommitted = false
  try {
    hasUncommitted = (await git(worktreePath, ['status', '--porcelain'])).length > 0
  } catch { /* ignore */ }

  return { base, ahead, behind, hasUncommitted, files }
}

// Full unified diff (optionally scoped to one file) of the worktree vs base.
export async function worktreeDiff(root: string, worktreePath: string, file?: string, baseRef?: string): Promise<string> {
  const base = baseRef || (await getBaseBranch(root))
  const args = ['diff', base]
  if (file) args.push('--', file)
  try {
    return await git(worktreePath, args)
  } catch (err) {
    return err instanceof Error ? `# diff failed: ${err.message}` : '# diff failed'
  }
}

// Stage everything and commit inside the worktree, so uncommitted agent work can
// be merged. Returns the new commit's short hash, or null if there was nothing
// to commit.
export async function worktreeCommit(worktreePath: string, message: string): Promise<string | null> {
  await git(worktreePath, ['add', '-A'])
  const status = await git(worktreePath, ['status', '--porcelain'])
  if (!status) return null
  await git(worktreePath, ['commit', '-m', message || 'SwarmMind: commit worktree changes'])
  return git(worktreePath, ['rev-parse', '--short', 'HEAD'])
}

// Commit only the given files (selective staging), so a reviewer can land part of
// an agent's work and leave the rest. Empty/omitted `files` falls back to a full
// commit. Stages exactly the listed paths (including deletions, via `add -A --`)
// then commits only the staged index. Returns the new short hash, or null if
// nothing of the selection was actually staged.
export async function worktreeCommitFiles(worktreePath: string, message: string, files: string[]): Promise<string | null> {
  if (!files || files.length === 0) return worktreeCommit(worktreePath, message)
  await git(worktreePath, ['add', '-A', '--', ...files])
  const staged = await git(worktreePath, ['diff', '--cached', '--name-only'])
  if (!staged.trim()) return null
  await git(worktreePath, ['commit', '-m', message || 'SwarmMind: commit selected changes'])
  return git(worktreePath, ['rev-parse', '--short', 'HEAD'])
}

// Merge a worktree's branch into the main checkout's current branch. Only
// committed work is merged. On conflict the merge is aborted so the main
// checkout is left clean, and the conflict is reported for the user to resolve
// in their own tools.
export async function mergeBranch(root: string, branch: string): Promise<{ ok: true; message: string } | { ok: false; conflict: boolean; error: string }> {
  try {
    const out = await git(root, ['merge', '--no-edit', branch])
    return { ok: true, message: out || `Merged ${branch}` }
  } catch (err) {
    // git writes conflict details to stdout (and a summary to stderr); the
    // rejection's own message often omits both, so combine all three.
    const e = err as { message?: string; stdout?: string; stderr?: string }
    const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim()
    const conflict = /conflict/i.test(combined)
    try { await git(root, ['merge', '--abort']) } catch { /* nothing to abort */ }
    return { ok: false, conflict, error: combined || 'merge failed' }
  }
}

export async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
  if (!(await isRepo(root))) return []
  try {
    const out = await git(root, ['worktree', 'list', '--porcelain'])
    const result: WorktreeInfo[] = []
    let path = ''
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('branch ')) {
        const branch = line.slice('branch '.length).replace('refs/heads/', '')
        if (path) result.push({ path, branch })
      }
    }
    return result
  } catch {
    return []
  }
}

// ── Checkpoints & Rewind ──────────────────────────────────────────────────────
// A checkpoint snapshots the *entire* workspace — the main checkout plus every
// SwarmMind worktree — without disturbing anyone's working tree, so a multi-agent
// run can be rewound wholesale. The technique (validated plumbing):
//   1. stage the working tree (tracked + untracked, respecting .gitignore) into a
//      throwaway index via GIT_INDEX_FILE → `git write-tree` → a tree object;
//   2. `git commit-tree` that tree (parented on HEAD) → a commit object;
//   3. pin it under refs/swarmmind/checkpoints/<id>-<n> so GC can't reclaim it.
// Restore resets index+worktree to the commit's tree and `git clean`s strays
// (ignored files like .swarmmind survive, so memory/db/scrollback are untouched).

export interface CheckpointTree {
  // The git working directory this entry snapshots (main root or a worktree).
  path: string
  // The snapshot commit (its tree is the captured working-tree state).
  commit: string
  // HEAD at snapshot time (null in an unborn-branch repo), for display.
  head: string | null
}

// Snapshot one git working directory. Returns null when it isn't a working tree.
async function snapshotOne(gitCwd: string, refName: string): Promise<CheckpointTree | null> {
  if (!existsSync(gitCwd)) return null
  let head: string | null = null
  try { head = await git(gitCwd, ['rev-parse', 'HEAD']) } catch { head = null }

  const tmpIndex = join(tmpdir(), `sm-ckpt-${randomUUID()}.idx`)
  try {
    if (head) await gitEnv(gitCwd, ['read-tree', head], { GIT_INDEX_FILE: tmpIndex })
    await gitEnv(gitCwd, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex })
    const tree = await gitEnv(gitCwd, ['write-tree'], { GIT_INDEX_FILE: tmpIndex })
    const commitArgs = head
      ? ['commit-tree', tree, '-p', head, '-m', 'swarmmind-checkpoint']
      : ['commit-tree', tree, '-m', 'swarmmind-checkpoint']
    const commit = await git(gitCwd, commitArgs)
    // Pin against GC. Refs live in the main repo's ref store (shared by worktrees).
    try { await git(gitCwd, ['update-ref', refName, commit]) } catch { /* best-effort pin */ }
    return { path: gitCwd, commit, head }
  } catch {
    return null
  } finally {
    try { rmSync(tmpIndex, { force: true }) } catch { /* ignore */ }
  }
}

// Snapshot the whole workspace. `id` scopes the pinning refs so a checkpoint can
// be dropped wholesale later. Returns the per-directory snapshot commits to
// persist; empty if the workspace isn't a git repo.
export async function snapshotWorkspace(root: string, id: string): Promise<CheckpointTree[]> {
  if (!(await isRepo(root))) return []
  // Always snapshot the main checkout; add any SwarmMind-managed worktree (they
  // live under .swarmmind/worktrees). Normalise separators for the substring test.
  const dirs = [root]
  for (const wt of await listWorktrees(root)) {
    const norm = wt.path.replace(/\\/g, '/')
    if (wt.path !== root && norm.includes('.swarmmind/worktrees')) dirs.push(wt.path)
  }
  const trees: CheckpointTree[] = []
  let n = 0
  for (const dir of dirs) {
    const snap = await snapshotOne(dir, `refs/swarmmind/checkpoints/${id}-${n}`)
    if (snap) { trees.push(snap); n++ }
  }
  return trees
}

// Restore a workspace to a checkpoint: reset each captured working tree to its
// snapshot commit and clear strays. Destructive by design (that's a rewind);
// callers should snapshot current state first as a safety net.
export async function restoreWorkspace(trees: CheckpointTree[]): Promise<{ restored: number; errors: string[] }> {
  const errors: string[] = []
  let restored = 0
  for (const t of trees) {
    if (!existsSync(t.path)) { errors.push(`${t.path}: gone`); continue }
    try {
      await git(t.path, ['read-tree', '-u', '--reset', t.commit])
      await git(t.path, ['clean', '-fdq'])  // respects .gitignore → keeps .swarmmind
      restored++
    } catch (err) {
      errors.push(`${t.path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { restored, errors }
}

// Delete a checkpoint's pinning refs so its commits become collectable.
export async function dropCheckpointRefs(root: string, id: string, count: number): Promise<void> {
  for (let n = 0; n < count; n++) {
    try { await git(root, ['update-ref', '-d', `refs/swarmmind/checkpoints/${id}-${n}`]) } catch { /* already gone */ }
  }
}
