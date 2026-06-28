import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { SWARM_AGENT_TOOLS, runTool, cancelTools, resetToolCancellation, buildSwarmAgentContext } from '../swarmagent/tools'
import { pickVoice, rankVoices, chunkForSpeech, type VoiceLike } from '../lib/voices'

// Drives the SwarmAgent conversation. The agentic loop lives here in the
// renderer because tool calls are app actions: each turn is one
// `window.swarmmind.swarmAgentChat` round-trip; if the model returns tool calls
// we execute them locally, append the results, and loop until it just talks.

const MAX_STEPS = 6 // guard against tool-call loops

// Conversation persistence. The chat overlay unmounts when toggled closed, so
// the transcript lives in localStorage (which persists on this app's file://
// origin — same as FilePanel/useVoice) rather than in component state alone.
const HISTORY_KEY = 'swarmagent:history'
const MAX_HISTORY = 40 // cap what we keep/replay so context stays bounded

// Trim to the last MAX_HISTORY messages, then drop any leading orphans so the
// transcript starts on a clean `user` turn — a restored `tool` (or an assistant
// message carrying tool_calls) with no matching predecessor would otherwise
// break the model's tool-call pairing on the next request.
function sanitizeHistory(msgs: SwarmAgentMessage[]): SwarmAgentMessage[] {
  const tail = msgs.slice(-MAX_HISTORY)
  const firstUser = tail.findIndex(m => m.role === 'user')
  return firstUser <= 0 ? tail : tail.slice(firstUser)
}

function loadHistory(): SwarmAgentMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? sanitizeHistory(parsed as SwarmAgentMessage[]) : []
  } catch { return [] }
}

function saveHistory(msgs: SwarmAgentMessage[]): void {
  try {
    if (msgs.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(sanitizeHistory(msgs)))
    else localStorage.removeItem(HISTORY_KEY)
  } catch { /* storage best-effort */ }
}

// Local, per-turn request id (only needs to be unique within this renderer to
// match streamed deltas — avoids crypto.randomUUID(), which needs a secure
// context the file:// renderer may not provide).
let reqCounter = 0
const nextReqId = () => `swarmagent-${Date.now()}-${reqCounter++}`

// Persist the TTS toggle so spoken replies stay on/off across sessions.
const TTS_KEY = 'swarmagent:tts'
function loadTts(): boolean {
  try { return localStorage.getItem(TTS_KEY) === '1' } catch { return false }
}

// Persist the chosen voice (by voiceURI) so the user's pick survives restarts.
// Empty/missing → "Auto" (best natural voice for the language).
const VOICE_KEY = 'swarmagent:voiceURI'
function loadVoiceURI(): string | null {
  try { return localStorage.getItem(VOICE_KEY) || null } catch { return null }
}

// A slightly slower rate + neutral pitch reads more naturally than the platform
// defaults; the natural/neural voices selected by pickVoice do the rest.
const SPEAK_RATE = 0.98
const SPEAK_PITCH = 1.0

export interface UseSwarmAgent {
  messages: SwarmAgentMessage[]
  streaming: string
  sending: boolean
  error: string | null
  ttsEnabled: boolean
  setTtsEnabled: (v: boolean) => void
  // Voice selection for spoken replies. `voices` is ranked best-first for the
  // active language; `voiceURI` is the user's pick (null = Auto / best).
  voices: VoiceLike[]
  voiceURI: string | null
  setVoiceURI: (uri: string | null) => void
  previewVoice: (uri?: string | null) => void
  send: (text: string) => void
  stop: () => void
  regenerate: () => void
  canRegenerate: boolean
  clear: () => void
}

// How a tool call is executed. Defaults to running locally against this
// renderer's store (`runTool`); the desktop widget passes a runner that forwards
// the call to the main window instead, since the widget has no workspace state.
type ToolRunner = (name: string, rawArgs: string) => Promise<string>

export function useSwarmAgent(options?: { runTool?: ToolRunner; getContext?: () => string }): UseSwarmAgent {
  const runToolFn = options?.runTool ?? runTool
  // Live workspace snapshot injected into the system prompt each turn. Defaults
  // to reading this renderer's store; the widget (no store of its own) overrides
  // it so it never reports a misleading "no workspace open".
  const getContextFn = options?.getContext ?? buildSwarmAgentContext
  const language = useWorkspaceStore(s => s.language)
  const [messages, setMessages] = useState<SwarmAgentMessage[]>(loadHistory)
  const [streaming, setStreaming] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ttsEnabled, setTtsEnabledState] = useState(loadTts)
  const [voiceURI, setVoiceURIState] = useState<string | null>(loadVoiceURI)
  const [voices, setVoices] = useState<VoiceLike[]>([])

  // Persisted TTS setter; turning it off also cuts any in-progress speech.
  const setTtsEnabled = useCallback((v: boolean) => {
    setTtsEnabledState(v)
    try { localStorage.setItem(TTS_KEY, v ? '1' : '0') } catch { /* best-effort */ }
    if (!v && typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel()
  }, [])

  const setVoiceURI = useCallback((uri: string | null) => {
    setVoiceURIState(uri)
    try {
      if (uri) localStorage.setItem(VOICE_KEY, uri)
      else localStorage.removeItem(VOICE_KEY)
    } catch { /* best-effort */ }
  }, [])

  // The browser populates getVoices() asynchronously (and refires on change), so
  // subscribe and keep a language-ranked list for the picker. Refreshes when the
  // language changes so the ranking follows the active locale.
  useEffect(() => {
    if (typeof window.speechSynthesis === 'undefined') return
    const lang = language === 'de' ? 'de-DE' : 'en-US'
    const refresh = () => setVoices(rankVoices(window.speechSynthesis.getVoices(), lang))
    refresh()
    window.speechSynthesis.addEventListener('voiceschanged', refresh)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh)
  }, [language])

  // Streaming deltas land here keyed by the active request id; we mirror the
  // accumulated text into `streaming` for the in-progress assistant bubble.
  const activeReqRef = useRef<string | null>(null)
  const streamBufRef = useRef('')
  // Set by stop() to break the agentic loop between steps.
  const cancelRef = useRef(false)

  useEffect(() => {
    const off = window.swarmmind.onSwarmAgentDelta(({ requestId, text }) => {
      if (requestId !== activeReqRef.current) return
      streamBufRef.current += text
      setStreaming(streamBufRef.current)
    })
    return off
  }, [])

  // Persist the transcript so it survives the overlay unmounting / app restart.
  useEffect(() => { saveHistory(messages) }, [messages])

  // Speak `text` aloud using the chosen (or best natural) voice. Markdown is
  // stripped and the speech is queued per-sentence — both for a more human
  // cadence and to dodge Chrome's ~15s long-utterance cutoff. `forceURI`/`force`
  // let previewVoice speak a sample regardless of the toggle.
  const utter = useCallback((text: string, opts?: { force?: boolean; voiceURI?: string | null }) => {
    if ((!opts?.force && !ttsEnabled) || typeof window.speechSynthesis === 'undefined') return
    const lang = language === 'de' ? 'de-DE' : 'en-US'
    const all = window.speechSynthesis.getVoices()
    const wantURI = opts && 'voiceURI' in opts ? opts.voiceURI : voiceURI
    const voice = pickVoice(all, lang, wantURI)
    const chunks = chunkForSpeech(text)
    if (!chunks.length) return
    try {
      window.speechSynthesis.cancel()
      for (const chunk of chunks) {
        const u = new SpeechSynthesisUtterance(chunk)
        u.lang = voice?.lang ?? lang
        if (voice) u.voice = voice as unknown as SpeechSynthesisVoice
        u.rate = SPEAK_RATE
        u.pitch = SPEAK_PITCH
        window.speechSynthesis.speak(u)
      }
    } catch { /* TTS is best-effort */ }
  }, [ttsEnabled, language, voiceURI])

  const speak = useCallback((text: string) => { if (text.trim()) utter(text) }, [utter])

  // Speak a short sample so users can audition a voice before committing to it.
  const previewVoice = useCallback((uri?: string | null) => {
    const sample = language === 'de'
      ? 'Hallo, ich bin SwarmAgent. So klinge ich.'
      : "Hi, I'm SwarmAgent. This is how I sound."
    utter(sample, { force: true, voiceURI: uri === undefined ? voiceURI : uri })
  }, [utter, language, voiceURI])

  // The agentic loop. Runs `conversation` (which already ends on a user turn) to
  // completion: each step is one model round-trip; tool calls are executed
  // locally and fed back until the model just talks. Shared by send + regenerate.
  const runConversation = useCallback((conversation: SwarmAgentMessage[]) => {
    cancelRef.current = false
    resetToolCancellation()
    setError(null)
    setSending(true)
    setMessages(conversation)

    ;(async () => {
      try {
        let working = conversation
        for (let step = 0; step < MAX_STEPS; step++) {
          if (cancelRef.current) return
          const reqId = nextReqId()
          activeReqRef.current = reqId
          streamBufRef.current = ''
          setStreaming('')

          // Rebuilt each step so multi-step runs see state changed by prior tools.
          const context = getContextFn()
          const res = await window.swarmmind.swarmAgentChat(reqId, working, SWARM_AGENT_TOOLS as unknown as unknown[], context)
          activeReqRef.current = null
          setStreaming('')
          if (cancelRef.current) return

          if (res.error) {
            const msg = res.error === 'no-key'
              ? 'No Groq API key configured. Add one in Settings → SwarmAgent.'
              : res.error
            setError(msg)
            setMessages([...working, { role: 'assistant', content: `⚠️ ${msg}` }])
            return
          }

          const assistant = res.message
          if (!assistant) return
          working = [...working, assistant]
          setMessages(working)

          // No tool calls → the turn is done.
          if (!assistant.tool_calls?.length) {
            if (assistant.content) speak(assistant.content)
            return
          }

          // Execute each tool call locally and feed the results back.
          for (const call of assistant.tool_calls) {
            if (cancelRef.current) return
            const result = await runToolFn(call.function.name, call.function.arguments)
            working = [...working, { role: 'tool', tool_call_id: call.id, name: call.function.name, content: result }]
          }
          setMessages(working)
        }
      } finally {
        setSending(false)
        setStreaming('')
        activeReqRef.current = null
      }
    })()
  }, [speak, runToolFn, getContextFn])

  const send = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    runConversation([...messages, { role: 'user', content: trimmed }])
  }, [messages, sending, runConversation])

  // Abort the in-flight turn. The current model request finishes in the main
  // process but its result is ignored; the loop won't advance to the next step.
  const stop = useCallback(() => {
    cancelRef.current = true
    cancelTools() // break out of any blocking tool (e.g. wait_for_agent's poll)
    activeReqRef.current = null
    setSending(false)
    setStreaming('')
    if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel()
  }, [])

  // Re-run the last user turn: drop everything after the last user message and
  // ask again (useful after an error or an unsatisfying answer).
  const regenerate = useCallback(() => {
    if (sending) return
    let idx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { idx = i; break }
    }
    if (idx === -1) return
    runConversation(messages.slice(0, idx + 1))
  }, [messages, sending, runConversation])

  const clear = useCallback(() => {
    cancelRef.current = true
    cancelTools()
    setMessages([])
    setStreaming('')
    setError(null)
    saveHistory([])
  }, [])

  const canRegenerate = !sending && messages.some(m => m.role === 'user')

  return { messages, streaming, sending, error, ttsEnabled, setTtsEnabled, voices, voiceURI, setVoiceURI, previewVoice, send, stop, regenerate, canRegenerate, clear }
}
