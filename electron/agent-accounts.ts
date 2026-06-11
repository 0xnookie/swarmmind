import { app } from 'electron'
import { join, sep } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'
import { getAppState, setAppState, type AgentId } from '../memory/queries'
import { encryptSecret, decryptSecret } from './secrets'

// ── Global agent accounts ───────────────────────────────────────────────────────
// A user can connect multiple accounts per agent (e.g. several Claude or OpenAI
// logins) and switch between them — handy when one account hits a usage limit.
//
// Unlike per-workspace agent_configs (which live in a repo's memory.db and carry
// launch-override trust concerns), accounts are GLOBAL: you connect them once and
// they're available in every workspace. They're stored in app.db (userData) under
// the `agentAccounts` app_state key, so a cloned/untrusted repo can never carry
// them. Each account holds only credential/runtime data — never executablePath/
// extraFlags — so there's no spawn-command injection surface and no signature
// needed.
//
// Two kinds of account:
//  • CLI-login (preferred): `profileDir` points at an isolated config dir under
//    userData/agent-profiles/. "Connect" runs the agent CLI's own login flow
//    (browser OAuth) with its config env var (CLAUDE_CONFIG_DIR / CODEX_HOME /
//    XDG_DATA_HOME) redirected there, so the credential lands in that dir and
//    the account is just "spawn with this env var". No API key ever touches us.
//  • API key (advanced fallback): the key is encrypted at rest via Electron
//    safeStorage. The renderer always sees decrypted keys (listAccounts) and
//    sends them back in plaintext (saveAccounts), which re-encrypts.

export interface AgentAccount {
  id: string
  label: string
  // CLI-login accounts: the isolated config dir holding this login's credential.
  profileDir?: string
  apiKey?: string
  model?: string
  env?: Record<string, string>
}

// Agents whose CLIs support a redirectable config dir + an own login flow.
// `loginArgs` is the argv that triggers the login (empty = the bare CLI; a fresh
// config dir makes Claude Code run its onboarding, which includes login). These
// are best-effort and may need adjusting as the individual CLIs evolve — same
// caveat as AGENT_RESUME_ARGS in pty-manager.
export const PROFILE_LOGIN: Partial<Record<AgentId, { envVar: string; loginArgs: string[] }>> = {
  claude:   { envVar: 'CLAUDE_CONFIG_DIR', loginArgs: [] },
  codex:    { envVar: 'CODEX_HOME',        loginArgs: ['login'] },
  opencode: { envVar: 'XDG_DATA_HOME',     loginArgs: ['auth', 'login'] },
}

// The env that routes an agent CLI at an account's profile dir. Empty for API-key
// accounts and for agents without profile support.
export function profileEnv(agentId: AgentId, account: AgentAccount | null): Record<string, string> {
  const sup = PROFILE_LOGIN[agentId]
  if (!sup || !account?.profileDir) return {}
  return { [sup.envVar]: account.profileDir }
}

// The combined profile env of every agent's ACTIVE account — injected into every
// terminal SwarmMind starts (plain shells included), so typing `claude`/`codex`/…
// by hand also connects with the active account, not just auto-spawned panes.
// Note XDG_DATA_HOME (opencode) is a generic XDG var, so other XDG-aware tools
// run in such a shell would see it too — acceptable, and a non-issue on Windows.
export function allProfileEnv(): Record<string, string> {
  const blob = readBlob()
  const env: Record<string, string> = {}
  for (const agentId of Object.keys(PROFILE_LOGIN) as AgentId[]) {
    const st = blob[agentId]
    if (!st || st.accounts.length === 0) continue
    const acc = st.accounts.find(a => a.id === st.activeId) ?? st.accounts[0]
    Object.assign(env, profileEnv(agentId, acc))
  }
  return env
}

function profilesRoot(): string {
  return join(app.getPath('userData'), 'agent-profiles')
}

export interface AgentAccountState {
  accounts: AgentAccount[]
  activeId?: string
}

type AccountsBlob = Record<string, AgentAccountState>

const STATE_KEY = 'agentAccounts'

function readBlob(): AccountsBlob {
  const raw = getAppState(STATE_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as AccountsBlob
  } catch {
    return {}
  }
}

function writeBlob(blob: AccountsBlob): void {
  setAppState(STATE_KEY, JSON.stringify(blob))
}

function decryptAccount(a: AgentAccount): AgentAccount {
  return a.apiKey ? { ...a, apiKey: decryptSecret(a.apiKey) } : a
}

function encryptAccount(a: AgentAccount): AgentAccount {
  return a.apiKey ? { ...a, apiKey: encryptSecret(a.apiKey) } : a
}

// Renderer-facing: the agent's accounts with decrypted keys + the active id.
export function listAccounts(agentId: AgentId): AgentAccountState {
  const st = readBlob()[agentId]
  if (!st) return { accounts: [] }
  return { accounts: st.accounts.map(decryptAccount), activeId: st.activeId }
}

// Create a fresh CLI-login account: an empty profile dir the agent's login flow
// will write its credential into. Persisted immediately (the login writes to disk
// straight away, so deferring to the Settings Save button would orphan it).
// Becomes the active account when it's the agent's first.
export function createProfileAccount(agentId: AgentId, label: string): AgentAccount {
  const id = randomUUID()
  const dir = join(profilesRoot(), agentId, id)
  mkdirSync(dir, { recursive: true })
  const account: AgentAccount = { id, label, profileDir: dir }
  const blob = readBlob()
  const st = blob[agentId] ?? { accounts: [] }
  st.accounts = [...st.accounts, account]
  if (!st.activeId) st.activeId = id
  blob[agentId] = st
  writeBlob(blob)
  return account
}

// Delete a removed account's profile dir (its stored login credential) from disk.
// Guarded to paths under our agent-profiles root so a hand-edited blob can never
// turn this into an arbitrary recursive delete.
function cleanupProfileDir(dir: string | undefined): void {
  if (!dir) return
  const root = profilesRoot()
  if (!dir.startsWith(root + sep)) return
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

// Replace the full account list for an agent (plaintext keys in, encrypted out).
// The active id is clamped to a real account so a deleted account can't stay
// "active"; falls back to the first account when the requested one is gone.
// Profile dirs of removed CLI-login accounts are deleted from disk.
export function saveAccounts(agentId: AgentId, accounts: AgentAccount[], activeId?: string): void {
  const blob = readBlob()
  const kept = new Set(accounts.map(a => a.id))
  for (const old of blob[agentId]?.accounts ?? []) {
    if (!kept.has(old.id)) cleanupProfileDir(old.profileDir)
  }
  if (accounts.length === 0) {
    delete blob[agentId]
    writeBlob(blob)
    return
  }
  const active = activeId && kept.has(activeId) ? activeId : accounts[0].id
  blob[agentId] = { accounts: accounts.map(encryptAccount), activeId: active }
  writeBlob(blob)
}

// Switch which account is active for an agent (used by the in-pane quick switcher
// and the Settings radio). No-op if the id isn't one of the agent's accounts.
export function setActiveAccount(agentId: AgentId, accountId: string): void {
  const blob = readBlob()
  const st = blob[agentId]
  if (!st || !st.accounts.some(a => a.id === accountId)) return
  st.activeId = accountId
  writeBlob(blob)
}

// Main-process spawn path: the active account, decrypted, or null when the agent
// has no connected accounts (callers then fall back to the per-workspace config).
export function getActiveAccount(agentId: AgentId): AgentAccount | null {
  const st = readBlob()[agentId]
  if (!st || st.accounts.length === 0) return null
  const acc = st.accounts.find(a => a.id === st.activeId) ?? st.accounts[0]
  return acc ? decryptAccount(acc) : null
}
