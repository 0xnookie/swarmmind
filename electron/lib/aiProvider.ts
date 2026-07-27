// AI provider abstraction — the pure half.
//
// SwarmMind's in-app AI (SwarmAgent chat, inline Cmd-K edit, ghost text, the
// Composer, diagnostics, next-edit) was hard-wired to one vendor. This module
// makes the provider a setting: which vendor, which model, which base URL, and
// how to phrase that vendor's errors.
//
// SwarmMind's internal wire format stays OpenAI-shaped (`role`/`content` +
// `tool_calls`), because that's what the renderer's agent loop already speaks
// and what most providers accept verbatim. Anthropic's Messages API has a
// genuinely different shape, so the translation both ways lives here — pure,
// so it can be unit-tested without a network or an SDK.
//
// Everything in this file is dependency-free on purpose (see CLAUDE.md): the
// impure runtime that actually opens sockets lives in `electron/ai/client.ts`.

export type ProviderId = 'groq' | 'anthropic' | 'openai' | 'custom'

export interface ProviderInfo {
  id: ProviderId
  label: string
  // Model used when the user hasn't chosen one. Kept current per provider.
  defaultModel: string
  // Fixed endpoint for the hosted providers; `custom` supplies its own.
  baseUrl?: string
  // A local runtime (Ollama, LM Studio) needs no key — don't block on one.
  requiresKey: boolean
  // True when the provider speaks the OpenAI chat-completions wire format, so
  // one client implementation covers it. Anthropic is the exception.
  openAiCompatible: boolean
  hint: string
}

// Note on models: these are the current defaults at time of writing. Every
// provider's catalogue moves, which is exactly why the model is user-editable
// in Settings and why `listModels` exists.
export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'groq',
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    openAiCompatible: true,
    hint: 'Fastest and cheapest. Good for ghost-text autocomplete.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    // Claude Opus 5 — the strongest option for the Composer's multi-file plans
    // and the agentic chat, which are the workloads that most reward capability.
    defaultModel: 'claude-opus-5',
    baseUrl: 'https://api.anthropic.com',
    requiresKey: true,
    openAiCompatible: false,
    hint: 'Best quality for multi-file edits and agentic chat.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    openAiCompatible: true,
    hint: 'Standard OpenAI chat models.',
  },
  {
    id: 'custom',
    label: 'Custom / local (OpenAI-compatible)',
    defaultModel: 'llama3',
    requiresKey: false,
    openAiCompatible: true,
    hint: 'Ollama, LM Studio, OpenRouter, vLLM — any OpenAI-compatible base URL.',
  },
] as const

export function providerInfo(id: string): ProviderInfo {
  return PROVIDERS.find(p => p.id === id) ?? PROVIDERS[0]
}

export interface ResolvedProvider {
  id: ProviderId
  label: string
  model: string
  baseUrl: string
  requiresKey: boolean
  openAiCompatible: boolean
}

// Turn the three stored settings into everything the runtime needs. Blank or
// unknown values fall back rather than failing — a half-configured provider
// should degrade to a working default, not break every AI surface at once.
export function resolveProvider(
  providerSetting: string | null | undefined,
  modelSetting: string | null | undefined,
  baseUrlSetting?: string | null,
): ResolvedProvider {
  const info = providerInfo((providerSetting ?? '').trim())
  const model = (modelSetting ?? '').trim() || info.defaultModel
  const baseUrl = ((baseUrlSetting ?? '').trim() || info.baseUrl || '').replace(/\/+$/, '')
  return {
    id: info.id,
    label: info.label,
    model,
    baseUrl,
    requiresKey: info.requiresKey,
    openAiCompatible: info.openAiCompatible,
  }
}

// One readable message per failure mode, named for the provider the user
// actually configured. Previously this was copy-pasted (and Groq-specific) in
// every handler; a wrong vendor name in an error is its own support burden.
export function providerErrorMessage(
  provider: ResolvedProvider,
  err: { status?: number; message?: string } | null | undefined,
): string {
  const status = err?.status
  const raw = err?.message?.trim()
  if (status === 401 || status === 403)
    return `Invalid ${provider.label} API key. Check Settings → SwarmAgent.`
  if (status === 429)
    return `${provider.label} rate limit reached. Try again in a moment.`
  if (status === 404)
    return `Model "${provider.model}" not found on ${provider.label}. Pick another in Settings → SwarmAgent.`
  if (status === 400 && raw) return `${provider.label} rejected the request: ${raw}`
  if (status && status >= 500)
    return `${provider.label} is unavailable right now (${status}). Try again shortly.`
  return raw || `${provider.label} request failed.`
}

// Keep chat-capable models in a provider's catalogue listing. Embedding,
// speech, moderation and guard models can't hold a conversation, and listing
// them just invites a confusing 404 later.
const NON_CHAT_RE = /whisper|tts|embed|guard|moderation|dall-?e|stable-|rerank|distil-whisper/i

export function filterChatModels(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || NON_CHAT_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

// ── SwarmMind's internal (OpenAI-shaped) wire format ─────────────────────────

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
  name?: string
}

export interface WireTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

// ── Anthropic Messages API shapes (only what we send/receive) ────────────────

export interface AnthropicTool {
  name: string
  description: string
  // Anthropic requires a JSON Schema object here, and requires `type: 'object'`
  // specifically — hence the narrowed shape rather than a loose record.
  input_schema: { type: 'object'; [key: string]: unknown }
}

export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

export function toAnthropicTools(tools: readonly WireTool[] | undefined): AnthropicTool[] {
  return (tools ?? [])
    .filter(t => t?.function?.name)
    .map(t => ({
      name: t.function.name,
      description: t.function.description ?? '',
      // A tool with no parameters still needs a well-formed empty object schema
      // or the request is rejected; `type: 'object'` is forced because the API
      // requires it even when the caller's schema omitted it.
      input_schema: {
        properties: {},
        ...(t.function.parameters ?? {}),
        type: 'object' as const,
      },
    }))
}

// Translate SwarmMind's OpenAI-shaped conversation into Anthropic's.
//
// Three things this has to get right, all of which are silent failures rather
// than obvious ones:
//   • `system` is a top-level parameter, not a message. Leaving it in the array
//     is a 400.
//   • Consecutive tool results must be merged into ONE user message. Splitting
//     parallel tool results across separate messages teaches the model to stop
//     issuing parallel tool calls — it degrades quietly, it doesn't error.
//   • Empty/blank text blocks are rejected, so they're dropped rather than sent.
export function toAnthropicMessages(msgs: readonly WireMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const systemParts: string[] = []
  const out: AnthropicMessage[] = []

  const pushBlocks = (role: 'user' | 'assistant', blocks: AnthropicBlock[]): void => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    // Merge into the previous message when the role matches — this is what
    // collapses a run of `role:'tool'` results into a single user turn.
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const m of msgs) {
    if (!m) continue
    if (m.role === 'system') {
      if (m.content?.trim()) systemParts.push(m.content.trim())
      continue
    }
    if (m.role === 'tool') {
      if (!m.tool_call_id) continue
      pushBlocks('user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          // A tool that returned nothing still needs a non-empty result block.
          content: m.content?.trim() ? m.content : '(no output)',
        },
      ])
      continue
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
      for (const call of m.tool_calls ?? []) {
        if (!call?.function?.name) continue
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        })
      }
      pushBlocks('assistant', blocks)
      continue
    }
    // user
    if (m.content?.trim()) pushBlocks('user', [{ type: 'text', text: m.content }])
  }

  return { system: systemParts.join('\n\n'), messages: out }
}

// Tool arguments cross the wire as a JSON *string* in the OpenAI shape but must
// be a real object for Anthropic. Malformed JSON becomes an empty object rather
// than throwing — a bad argument blob shouldn't kill the whole turn.
export function parseToolArguments(args: string | undefined): Record<string, unknown> {
  if (!args || !args.trim()) return {}
  try {
    const parsed = JSON.parse(args)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// Translate an Anthropic response back into the OpenAI-shaped assistant message
// the renderer's agent loop already knows how to execute.
export function fromAnthropicContent(blocks: readonly AnthropicBlock[] | undefined): {
  content: string
  toolCalls: WireToolCall[]
} {
  let content = ''
  const toolCalls: WireToolCall[] = []
  for (const b of blocks ?? []) {
    if (b.type === 'text') content += b.text
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      })
    }
  }
  return { content, toolCalls }
}

// Claude's safety classifiers can decline a request: that arrives as a normal
// successful response with `stop_reason: 'refusal'` and (possibly empty)
// content — not as an error. Callers must check this before reading content,
// otherwise a refusal looks like an inexplicably blank reply.
export function refusalMessage(stopReason: string | null | undefined): string | null {
  return stopReason === 'refusal'
    ? 'Claude declined this request. Rephrase it, or switch provider in Settings → SwarmAgent.'
    : null
}
