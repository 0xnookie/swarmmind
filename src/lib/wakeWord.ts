// ── Wake word matching ────────────────────────────────────────────────────────
//
// SwarmVoice needs a click (or a keystroke) per dictation. A wake word removes
// that: leave it armed, say "hey swarm", talk.
//
// There is no wake-word engine here and deliberately so — Whisper is already
// on-device, so arming just means running short VAD-delimited segments through
// the model that's already loaded and asking *this* module whether what came
// back begins with the wake phrase. That keeps everything offline and adds no
// dependency, but it also means the matcher has to absorb how a speech model
// actually behaves, which is the whole reason this file exists:
//
//  - **Punctuation and case are invented by the model.** "hey swarm" comes back
//    as "Hey, Swarm." or "Hey swarm!" depending on the sentence around it. A
//    string compare would miss almost every time.
//  - **Words get misheard** ("swarm" ↔ "swarn"/"sworn"), so words are compared
//    with a small edit-distance budget that scales with length. Short words get
//    **no** budget at all: one edit from "hey" is also "her", "hen", "hex",
//    "key" and "they", so tolerating it would fire the wake word during ordinary
//    conversation. A miss just costs the user saying it again; a false fire
//    types into their terminal, so the asymmetry is deliberate.
//  - **The model prepends filler.** "Uh, hey swarm" is common, so the phrase may
//    start a word or two in rather than exactly at offset 0.
//
// The other half of the job is the command spoken in the same breath. "Hey
// swarm, run the tests" should dictate `run the tests` — not force a second
// utterance — so matching returns the remainder, sliced out of the *original*
// transcript so the user's capitalisation and punctuation survive.

export const DEFAULT_WAKE_PHRASE = 'hey swarm'

/** Words of filler the model may prepend before the phrase actually starts. */
const LEAD_SLACK_WORDS = 2

export interface WakeMatch {
  matched: boolean
  /**
   * Anything said after the wake phrase in the same utterance, in its original
   * form. Empty when the user only said the wake phrase — the caller treats that
   * as "open dictation and listen for the next thing I say".
   */
  rest: string
}

const NO_MATCH: WakeMatch = { matched: false, rest: '' }

/**
 * Fold a transcript to the form comparisons happen in: lowercase, no accents,
 * no punctuation. Exported because the settings UI shows the user what their
 * phrase actually normalises to.
 */
export function normalizeSpeech(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Levenshtein distance, abandoned early once it exceeds `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      row.push(v)
      if (v < best) best = v
    }
    if (best > max) return max + 1 // no cell in this row can lead to a match
    prev = row
  }
  return prev[b.length]
}

/**
 * Are these the same word, allowing for a mishearing?
 *
 * The budget scales with length on purpose. At one edit, "hey"/"her" and
 * "on"/"in" are different words and would fire the wake word on ordinary
 * conversation; at six letters or more, one wrong character is overwhelmingly a
 * transcription slip rather than a different word.
 */
export function wordsMatch(spoken: string, expected: string): boolean {
  if (spoken === expected) return true
  if (expected.length <= 3) return false
  const budget = expected.length >= 6 ? 2 : 1
  return editDistance(spoken, expected, budget) <= budget
}

/**
 * Is this usable as a wake phrase?
 *
 * Rejects anything so short or common that it would fire constantly. A single
 * short word is the trap: "hey" or "yo" appears in normal speech many times an
 * hour, and every false fire hijacks the user's terminal.
 */
export function isValidWakePhrase(phrase: string): boolean {
  const norm = normalizeSpeech(phrase)
  if (!norm) return false
  if (norm.length > 48) return false
  const words = norm.split(' ')
  if (words.length > 5) return false
  // Two or more words is fine; a lone word has to be long enough to be distinct.
  return words.length >= 2 ? norm.length >= 5 : words[0].length >= 5
}

interface Token {
  norm: string
  /** Index just past this token in the original string. */
  end: number
}

/** Split the raw transcript into normalized words, remembering where each ends. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const re = /[\p{L}\p{N}']+/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const norm = normalizeSpeech(m[0])
    if (norm) tokens.push({ norm, end: m.index + m[0].length })
  }
  return tokens
}

/**
 * Does `transcript` open with `phrase`, and what was said after it?
 *
 * Matching is anchored near the start rather than anywhere in the utterance: a
 * wake word that fires on "…and then tell the swarm about it" would be worse
 * than no wake word at all.
 */
export function matchWakeWord(transcript: string, phrase: string): WakeMatch {
  if (!transcript.trim() || !isValidWakePhrase(phrase)) return NO_MATCH

  const target = normalizeSpeech(phrase).split(' ')
  const tokens = tokenize(transcript)
  if (tokens.length < target.length) return NO_MATCH

  const lastStart = Math.min(LEAD_SLACK_WORDS, tokens.length - target.length)
  for (let start = 0; start <= lastStart; start++) {
    let ok = true
    for (let i = 0; i < target.length; i++) {
      if (!wordsMatch(tokens[start + i].norm, target[i])) { ok = false; break }
    }
    if (!ok) continue

    // Slice from the original string so the command keeps its real casing and
    // punctuation — this text goes straight into a terminal.
    const after = tokens[start + target.length - 1].end
    const rest = transcript
      .slice(after)
      .replace(/^[\s,.!?;:—–-]+/, '')
      .trim()
    return { matched: true, rest }
  }
  return NO_MATCH
}
