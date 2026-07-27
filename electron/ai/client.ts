// AI provider abstraction — the impure half.
//
// One `runChat` entry point that every AI surface in the app calls, backed by
// two implementations chosen from the user's settings:
//
//   • OpenAI-compatible (Groq, OpenAI, Ollama/LM Studio/OpenRouter/vLLM via a
//     custom base URL) — one wire format, one client.
//   • Anthropic (Claude) — its own SDK and its own message shape, translated at
//     the boundary by the pure helpers in `electron/lib/aiProvider.ts`.
//
// Callers speak SwarmMind's internal OpenAI-shaped format and never branch on
// the provider; the renderer is completely unaware which vendor answered.

import Groq from 'groq-sdk'
import Anthropic from '@anthropic-ai/sdk'
import {
  resolveProvider,
  providerErrorMessage,
  filterChatModels,
  toAnthropicMessages,
  toAnthropicTools,
  fromAnthropicContent,
  refusalMessage,
  type ResolvedProvider,
  type WireMessage,
  type WireTool,
  type WireToolCall,
  type AnthropicBlock,
} from '../lib/aiProvider'

export interface ChatRequest {
  messages: WireMessage[]
  tools?: WireTool[]
  // Cap on the reply. Anthropic requires one; OpenAI-compatible providers treat
  // it as optional, so it's only forwarded when set.
  maxTokens?: number
  // Ask for a JSON object back. Honoured natively by OpenAI-compatible
  // providers; on Anthropic the system prompt plus the shared defensive parse
  // (`extractJsonObject`) already covers it.
  json?: boolean
  // Latency-sensitive, short outputs (ghost text, inline edit). Turns off
  // Claude's thinking — it would otherwise consume the whole token budget on a
  // request whose answer is a single line — and lowers sampling temperature on
  // OpenAI-compatible providers.
  fast?: boolean
  // Called with each text delta when streaming is wanted.
  onDelta?: (text: string) => void
}

export interface ChatResult {
  content: string
  toolCalls: WireToolCall[]
  error?: string
}

export interface ProviderSettings {
  provider: string | null
  model: string | null
  baseUrl: string | null
  apiKey: string
}

export function resolve(settings: ProviderSettings): ResolvedProvider {
  return resolveProvider(settings.provider, settings.model, settings.baseUrl)
}

// A provider that needs a key and hasn't got one is the single most common
// failure; callers surface `'no-key'` as a distinct, actionable state.
export function missingKey(settings: ProviderSettings): boolean {
  return resolve(settings).requiresKey && !settings.apiKey
}

// ── OpenAI-compatible ────────────────────────────────────────────────────────
//
// groq-sdk is a Stainless-generated OpenAI-compatible client and accepts a
// `baseURL`, so it drives every OpenAI-shaped provider without adding a second
// HTTP dependency to the installer.

function openAiClient(provider: ResolvedProvider, apiKey: string): Groq {
  return new Groq({
    apiKey: apiKey || 'not-needed',
    ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
  })
}

async function runOpenAiCompatible(
  provider: ResolvedProvider,
  apiKey: string,
  req: ChatRequest,
): Promise<ChatResult> {
  const client = openAiClient(provider, apiKey)
  const params = {
    model: provider.model,
    messages: req.messages as never,
    ...(req.tools?.length ? { tools: req.tools, tool_choice: 'auto' as const } : {}),
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.json ? { response_format: { type: 'json_object' as const } } : {}),
    temperature: req.fast ? 0.1 : 0.2,
  }

  if (!req.onDelta) {
    const res = await client.chat.completions.create({ ...params, stream: false })
    const msg = res.choices[0]?.message
    const toolCalls = (msg?.tool_calls ?? []).map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
    }))
    return { content: msg?.content ?? '', toolCalls }
  }

  const stream = await client.chat.completions.create({ ...params, stream: true })
  let content = ''
  // Tool calls arrive as incremental fragments keyed by index; accumulate the
  // name and the arguments string and only parse them downstream.
  const acc: Record<number, { id: string; name: string; args: string }> = {}
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta
    if (!delta) continue
    if (delta.content) {
      content += delta.content
      req.onDelta(delta.content)
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const slot = (acc[idx] ??= { id: '', name: '', args: '' })
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
    }
  }
  const toolCalls = Object.values(acc)
    .filter(c => c.name)
    .map(c => ({
      id: c.id || `call_${c.name}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args || '{}' },
    }))
  return { content, toolCalls }
}

// ── Anthropic ────────────────────────────────────────────────────────────────
//
// Always streamed, then collected with `finalMessage()`. Streaming avoids the
// SDK's HTTP timeout on large `max_tokens` and gives non-streaming callers the
// identical code path; `stream.on('text')` yields only visible text, so
// thinking never leaks into an editor buffer.

// Claude's `max_tokens` caps thinking *and* the reply together, so a request
// that thinks needs real headroom.
const ANTHROPIC_MAX_TOKENS = 16000
const ANTHROPIC_FAST_MAX_TOKENS = 1024

async function runAnthropic(
  provider: ResolvedProvider,
  apiKey: string,
  req: ChatRequest,
): Promise<ChatResult> {
  const client = new Anthropic({
    apiKey,
    ...(provider.baseUrl && provider.baseUrl !== 'https://api.anthropic.com'
      ? { baseURL: provider.baseUrl }
      : {}),
  })
  const { system, messages } = toAnthropicMessages(req.messages)
  const tools = toAnthropicTools(req.tools)

  const stream = client.messages.stream({
    model: provider.model,
    // Note: no temperature/top_p — current Claude models reject them outright.
    max_tokens:
      req.maxTokens ?? (req.fast ? ANTHROPIC_FAST_MAX_TOKENS : ANTHROPIC_MAX_TOKENS),
    ...(system ? { system } : {}),
    ...(tools.length ? { tools } : {}),
    // Short, latency-sensitive completions shouldn't spend the budget thinking.
    ...(req.fast ? { thinking: { type: 'disabled' as const } } : {}),
    messages: messages as never,
  })

  if (req.onDelta) stream.on('text', text => req.onDelta!(text))

  const final = await stream.finalMessage()

  // A safety decline arrives as a *successful* response with an empty or
  // partial body — checking this before reading content is what stops it
  // presenting as a mysteriously blank reply.
  const refusal = refusalMessage(final.stop_reason)
  if (refusal) return { content: '', toolCalls: [], error: refusal }

  const { content, toolCalls } = fromAnthropicContent(
    final.content as unknown as AnthropicBlock[],
  )
  return { content, toolCalls }
}

// ── Public entry point ───────────────────────────────────────────────────────

// Run one model turn against whichever provider is configured. Never throws:
// every failure comes back as `{ error }` so each AI surface can degrade the
// way it wants (silent for ghost text, a message in the chat, and so on).
export async function runChat(
  settings: ProviderSettings,
  req: ChatRequest,
): Promise<ChatResult> {
  const provider = resolve(settings)
  try {
    return provider.openAiCompatible
      ? await runOpenAiCompatible(provider, settings.apiKey, req)
      : await runAnthropic(provider, settings.apiKey, req)
  } catch (err) {
    return {
      content: '',
      toolCalls: [],
      error: providerErrorMessage(provider, err as { status?: number; message?: string }),
    }
  }
}

// List the models this key can reach, so Settings can offer a live picker
// instead of a free-text guess. Empty array on any failure — the UI falls back
// to free text plus the provider's curated default.
export async function listModels(settings: ProviderSettings): Promise<string[]> {
  const provider = resolve(settings)
  if (provider.requiresKey && !settings.apiKey) return []
  try {
    if (provider.openAiCompatible) {
      const res = await openAiClient(provider, settings.apiKey).models.list()
      const data = (res.data ?? []) as { id: string; created?: number }[]
      return filterChatModels(
        data.sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).map(m => m.id),
      )
    }
    const client = new Anthropic({ apiKey: settings.apiKey })
    const out: string[] = []
    for await (const m of client.models.list()) out.push(m.id)
    return filterChatModels(out)
  } catch {
    return []
  }
}
