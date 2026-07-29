import { join } from 'node:path'

/**
 * Pure account-resolution rules for the multi-login agent accounts.
 *
 * The impure parts — reading the encrypted blob out of app.db, touching the
 * filesystem — live in `electron/agent-accounts.ts`. What's here is the logic
 * that decides *which* login a pane runs on, which is where the subtle failures
 * are: a pane silently falling back to the wrong account, or an account that is
 * listed but has no credential behind it.
 */

export interface AccountLike {
  id: string
  profileDir?: string
}

/**
 * Which account a pane spawns with.
 *
 * Order: the pane's own pin → the agent's global default → the first connected
 * account. A pin that no longer resolves (the account was deleted in Settings)
 * deliberately falls through to the default instead of returning nothing —
 * spawning with no credential at all would drop the user into an unexpected
 * login prompt, which is worse than using the account they'd otherwise get.
 */
export function pickAccount<T extends AccountLike>(
  accounts: T[],
  activeId: string | undefined,
  pinnedId?: string | null,
): T | null {
  if (accounts.length === 0) return null
  if (pinnedId) {
    const pinned = accounts.find(a => a.id === pinnedId)
    if (pinned) return pinned
  }
  return accounts.find(a => a.id === activeId) ?? accounts[0]
}

/**
 * Whether switching from one account to another invalidates the pane's
 * resumable conversation.
 *
 * A CLI-login account works by redirecting the agent's config dir, and the
 * conversation for a session id lives *inside* that dir. Resuming it under a
 * different profile therefore can't work — `claude --resume <id>` finds no such
 * session and the launch fails, which is what "switching accounts didn't work"
 * looks like from the outside. Two accounts sharing a config dir (e.g. two
 * API-key accounts, which redirect nothing) keep their sessions.
 */
export function needsFreshSession(from: AccountLike | null | undefined, to: AccountLike | null | undefined): boolean {
  return (from?.profileDir ?? null) !== (to?.profileDir ?? null)
}

/**
 * Files each CLI writes into its config dir once a login completes. Best-effort
 * and name-based, exactly like PROFILE_LOGIN — an agent that isn't listed here
 * simply has no knowable login state.
 */
export const CREDENTIAL_FILES: Record<string, string[]> = {
  claude:   ['.credentials.json', 'credentials.json'],
  codex:    ['auth.json'],
  opencode: [join('opencode', 'auth.json'), 'auth.json'],
}

/** Absolute paths that would prove `profileDir` holds a finished login. */
export function credentialCandidates(agentId: string, profileDir: string): string[] {
  return (CREDENTIAL_FILES[agentId] ?? []).map(f => join(profileDir, f))
}

/**
 * Login state of one account: true = credential found, false = the profile dir
 * exists but holds none (a login that was started and abandoned), null = not
 * knowable, which callers must treat as "fine", never as an error.
 */
export function signedInState(
  agentId: string,
  account: AccountLike,
  exists: (path: string) => boolean,
): boolean | null {
  if (!account.profileDir) return null            // API-key account: the key IS the credential
  const candidates = credentialCandidates(agentId, account.profileDir)
  if (candidates.length === 0) return null        // no marker known for this CLI
  if (!exists(account.profileDir)) return false
  return candidates.some(exists)
}
