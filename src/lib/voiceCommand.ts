// ── Voice orchestration (pure) ───────────────────────────────────────────────
//
// SwarmVoice already turns speech into text and types it into a terminal. That
// is dictation, and it's the right default — but it means the one thing you
// can't do hands-free is the thing the app is actually for: pointing several
// agents at some work. "Hey swarm, have Codex fix the failing tests" should
// create a task for Codex, not type that sentence into whichever pane happens
// to be focused.
//
// This module decides which of those two a spoken phrase is. Three properties
// matter more than coverage:
//
//  1. **Dictation is the fallback, always.** Anything not confidently matched
//     goes to the terminal unchanged. A missed command costs the user a click;
//     a false positive silently swallows text they meant to type.
//  2. **Commands are anchored to the start.** "…and then tell Claude about it"
//     is a sentence, not an instruction to the orchestrator.
//  3. **An agent name must be a real agent.** Without that check, "have a look
//     at the login flow" parses as a task assigned to an agent called "a" — the
//     failure mode that would make the whole feature untrustworthy.
//
// Dependency-free (including of wakeWord.ts, whose normaliser is similar but
// serves a different job) so it strip-and-runs in tests/lib-units.mts.

export type VoiceIntent =
  /** Type it into the active pane — the default, and what everything falls back to. */
  | { kind: 'dictate'; text: string }
  /** Set the orchestrator's goal. */
  | { kind: 'goal'; text: string }
  /** Queue a task, optionally pinned to one agent. */
  | { kind: 'task'; text: string; agent: string | null }
  /** Start or stop the orchestration run. */
  | { kind: 'control'; action: 'start' | 'stop' }
  /** Send the same line to every running pane. */
  | { kind: 'broadcast'; text: string }

/** Lowercase, unaccented, punctuation-free — the form patterns match against. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Map a normalized-word index back to an offset in the original string, so the
 * payload keeps the user's own casing and punctuation. It goes into a task
 * title or a terminal, where "Fix the CI" and "fix the ci" are not equivalent.
 */
function sliceAfterWords(original: string, wordCount: number): string {
  const re = /[\p{L}\p{N}']+/gu
  let m: RegExpExecArray | null
  let seen = 0
  while ((m = re.exec(original)) !== null) {
    if (++seen === wordCount) {
      return original.slice(m.index + m[0].length).replace(/^[\s,.:;!?—–-]+/, '').trim()
    }
  }
  return ''
}

const dictate = (text: string): VoiceIntent => ({ kind: 'dictate', text })

// Each entry is a leading phrase; the longest match wins so "tell all agents"
// isn't shadowed by "tell".
const START_PHRASES = ['start the swarm', 'run the swarm', 'start the orchestrator', 'start orchestration', 'go swarm']
const STOP_PHRASES = ['stop the swarm', 'halt the swarm', 'pause the swarm', 'stop the orchestrator', 'stop orchestration']
const GOAL_PHRASES = ['set the goal to', 'set the goal', 'new goal', 'the goal is', 'goal is', 'set goal to']
const BROADCAST_PHRASES = [
  'tell everyone to', 'tell everyone', 'tell everybody to', 'tell everybody',
  'tell all agents to', 'tell all agents', 'tell the swarm to', 'tell the swarm', 'broadcast',
]
const TASK_PHRASES = [
  'create a task to', 'create a task', 'add a task to', 'add a task',
  'new task to', 'new task', 'queue a task to', 'queue a task', 'make a task',
]
// Verbs that hand work to a named agent: "have codex fix the tests".
const AGENT_VERBS = ['have', 'ask', 'tell', 'get']

function wordsOf(s: string): string[] {
  return s ? s.split(' ') : []
}

/** Does the normalized transcript begin with `phrase`? Returns its word count. */
function leadingMatch(norm: string, phrase: string): number | null {
  const p = normalize(phrase)
  if (norm === p) return wordsOf(p).length
  return norm.startsWith(p + ' ') ? wordsOf(p).length : null
}

function firstLeading(norm: string, phrases: readonly string[]): { words: number } | null {
  // Longest first so a more specific phrase always wins over its own prefix.
  const sorted = [...phrases].sort((a, b) => b.length - a.length)
  for (const p of sorted) {
    const words = leadingMatch(norm, p)
    if (words !== null) return { words }
  }
  return null
}

/**
 * Classify a spoken command.
 *
 * `knownAgents` is the app's real agent id list; an agent-directed phrase only
 * matches when the spoken name is one of them.
 */
export function parseVoiceCommand(transcript: string, knownAgents: readonly string[]): VoiceIntent {
  const raw = transcript.trim()
  if (!raw) return dictate('')
  const norm = normalize(raw)
  if (!norm) return dictate(raw)

  // 1. Run control — whole-utterance commands with no payload.
  if (firstLeading(norm, START_PHRASES)) return { kind: 'control', action: 'start' }
  if (firstLeading(norm, STOP_PHRASES)) return { kind: 'control', action: 'stop' }

  // 2. Broadcast before agent-directed: "tell everyone" starts with "tell", and
  //    "everyone" is not an agent, so the agent branch would reject it and fall
  //    through to dictation.
  const bc = firstLeading(norm, BROADCAST_PHRASES)
  if (bc) {
    const rest = sliceAfterWords(raw, bc.words)
    // "broadcast" alone is not a broadcast — there is nothing to send.
    return rest ? { kind: 'broadcast', text: rest } : dictate(raw)
  }

  // 3. Goal.
  const goal = firstLeading(norm, GOAL_PHRASES)
  if (goal) {
    const rest = sliceAfterWords(raw, goal.words)
    return rest ? { kind: 'goal', text: rest } : dictate(raw)
  }

  // 4. Unassigned task.
  const task = firstLeading(norm, TASK_PHRASES)
  if (task) {
    const rest = sliceAfterWords(raw, task.words)
    return rest ? { kind: 'task', text: rest, agent: null } : dictate(raw)
  }

  // 5. Agent-directed task: <verb> <known agent> [to] <work>.
  const words = wordsOf(norm)
  if (words.length >= 3 && AGENT_VERBS.includes(words[0])) {
    const agent = knownAgents.find(a => normalize(a) === words[1])
    if (agent) {
      const skip = words[2] === 'to' ? 3 : 2
      const rest = sliceAfterWords(raw, skip)
      if (rest) return { kind: 'task', text: rest, agent }
    }
  }

  return dictate(raw)
}

/** One-line description of what will happen, for the confirmation flash. */
export function describeIntent(intent: VoiceIntent): string {
  switch (intent.kind) {
    case 'goal': return `Goal: ${intent.text}`
    case 'task': return intent.agent ? `Task → ${intent.agent}: ${intent.text}` : `Task: ${intent.text}`
    case 'control': return intent.action === 'start' ? 'Starting the swarm' : 'Stopping the swarm'
    case 'broadcast': return `All panes: ${intent.text}`
    case 'dictate': return intent.text
  }
}
