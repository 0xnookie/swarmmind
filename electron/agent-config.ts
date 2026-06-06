import { getAgentConfig, setAgentConfig, type AgentConfig, type AgentId } from '../memory/queries'
import { encryptSecret, decryptSecret } from './secrets'

// Thin wrappers over the agent_config queries that transparently encrypt the
// apiKey field at rest (Electron safeStorage / OS keychain). Every code path
// that reads a config for use (the settings IPC and the PTY spawn) goes through
// readAgentConfig so callers always see the plaintext key.

export function readAgentConfig(workspaceId: string, agentId: AgentId): AgentConfig {
  const cfg = getAgentConfig(workspaceId, agentId)
  if (cfg.apiKey) return { ...cfg, apiKey: decryptSecret(cfg.apiKey) }
  return cfg
}

export function writeAgentConfig(workspaceId: string, agentId: AgentId, config: AgentConfig): void {
  const toStore = config.apiKey ? { ...config, apiKey: encryptSecret(config.apiKey) } : config
  setAgentConfig(workspaceId, agentId, toStore)
}
