import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { getAgentConfig, setAgentConfig, getAppState, setAppState, type AgentConfig, type AgentId } from '../memory/queries'
import { encryptSecret, decryptSecret } from './secrets'

// Thin wrappers over the agent_config queries that transparently encrypt the
// apiKey field at rest (Electron safeStorage / OS keychain). Every code path
// that reads a config for use (the settings IPC and the PTY spawn) goes through
// readAgentConfig so callers always see the plaintext key.

// ── Spawn-override trust ────────────────────────────────────────────────────────
// agent_configs lives in the per-repo workspace DB ({rootPath}/.swarmmind/
// memory.db), so opening a cloned/untrusted repo loads attacker-controllable
// config. The spawn-affecting fields (executablePath/extraFlags/env) flow into
// the launched shell command, so an untrusted value there is a zero-click RCE.
//
// To keep these fields usable when *this* install configured them (Settings UI)
// while rejecting values shipped inside a repo, we sign them with a per-install
// HMAC key kept in app.db (userData) — never in a workspace DB. A cloned repo
// can carry the fields but not a signature that verifies against our key, so the
// spawn path drops them and falls back to safe defaults.

let signingKeyCache: string | null = null
function getSigningKey(): string {
  if (signingKeyCache) return signingKeyCache
  let key = getAppState('agentConfigSigningKey')
  if (!key) {
    key = randomBytes(32).toString('hex')
    setAppState('agentConfigSigningKey', key)
  }
  signingKeyCache = key
  return key
}

// Canonical serialization of the trust-gated fields so the signature is stable
// regardless of property order or undefined-vs-absent.
function canonicalSpawnFields(c: AgentConfig): string {
  return JSON.stringify({
    executablePath: c.executablePath ?? null,
    extraFlags: c.extraFlags && c.extraFlags.length ? c.extraFlags : null,
    env: c.env && Object.keys(c.env).length
      ? Object.fromEntries(Object.entries(c.env).sort(([a], [b]) => a.localeCompare(b)))
      : null,
  })
}

function signSpawnFields(c: AgentConfig): string {
  return createHmac('sha256', getSigningKey()).update(canonicalSpawnFields(c)).digest('hex')
}

function verifySpawnFields(c: AgentConfig, sig: string | undefined): boolean {
  if (!sig) return false
  const expected = signSpawnFields(c)
  if (sig.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  } catch {
    return false
  }
}

function hasSpawnOverrides(c: AgentConfig): boolean {
  return c.executablePath != null
    || (Array.isArray(c.extraFlags) && c.extraFlags.length > 0)
    || (c.env != null && Object.keys(c.env).length > 0)
}

export function readAgentConfig(workspaceId: string, agentId: AgentId): AgentConfig {
  const cfg = getAgentConfig(workspaceId, agentId)
  if (cfg.apiKey) return { ...cfg, apiKey: decryptSecret(cfg.apiKey) }
  return cfg
}

// Like readAgentConfig, but strips the spawn-affecting overrides unless they
// carry a valid signature from this install. Use this — never readAgentConfig —
// on the PTY spawn path so an untrusted workspace config can't dictate the
// launched command. Re-saving the agent in Settings (writeAgentConfig) signs the
// values with our key and makes them trusted again.
export function readAgentConfigForSpawn(workspaceId: string, agentId: AgentId): AgentConfig {
  const { _sig, ...cfg } = readAgentConfig(workspaceId, agentId)
  if (hasSpawnOverrides(cfg) && !verifySpawnFields(cfg, _sig)) {
    console.warn(
      `[security] Ignoring unsigned launch overrides (executablePath/extraFlags/env) for agent "${agentId}" — ` +
      `they came from an untrusted workspace config. Re-save the agent in Settings to trust them.`
    )
    return { ...cfg, executablePath: undefined, extraFlags: undefined, env: undefined }
  }
  return cfg
}

export function writeAgentConfig(workspaceId: string, agentId: AgentId, config: AgentConfig): void {
  // Drop any inbound signature and re-sign with our key, so values saved through
  // this install are trusted by the spawn path.
  const { _sig: _ignored, ...clean } = config
  const signed: AgentConfig = { ...clean, _sig: signSpawnFields(clean) }
  const toStore = signed.apiKey ? { ...signed, apiKey: encryptSecret(signed.apiKey) } : signed
  setAgentConfig(workspaceId, agentId, toStore)
}
