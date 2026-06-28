// Pure helpers for SwarmAgent spoken replies (Web Speech API / SpeechSynthesis).
// Kept dependency-free so the voice-ranking and text-cleaning logic can be
// unit-tested straight from source (see tests/lib-units.mts) — the impure
// runtime (getVoices / speak) lives in the useSwarmAgent hook.

// Structural subset of the browser's SpeechSynthesisVoice — so the ranker can be
// exercised with plain objects in tests, and accepts the real voices at runtime.
export interface VoiceLike {
  name: string
  lang: string
  voiceURI: string
  localService: boolean
  default: boolean
}

// Two-letter primary subtag, lowercased ('en-US' → 'en', 'de' → 'de').
function primaryLang(lang: string): string {
  return (lang || '').toLowerCase().split(/[-_]/)[0]
}

// Substrings that mark a modern, natural-sounding (neural/cloud) voice. Higher
// weight = preferred. Matching is case-insensitive on the voice name.
const NATURAL_MARKERS: Array<[RegExp, number]> = [
  [/natural/i, 120],          // Microsoft "… Natural" neural voices
  [/neural/i, 120],
  [/\bonline\b/i, 90],        // Microsoft online (cloud) voices
  [/google/i, 80],            // Chrome's Google voices — high quality, cloud
  // Named neural personas shipped by Microsoft/Apple — reliably good.
  [/\b(aria|jenny|guy|emma|ava|andrew|brian|sonia|ryan|libby|michelle|nova|ana)\b/i, 55],
  [/premium|enhanced|siri/i, 50], // Apple premium/enhanced/Siri voices
]

// Substrings that mark an older, robotic voice we should avoid when a better
// option exists. Negative weight.
const ROBOTIC_MARKERS: Array<[RegExp, number]> = [
  [/espeak/i, -120],
  [/\b(david|zira|mark|hazel|george)\b/i, -30], // legacy Microsoft SAPI voices
  [/compact/i, -25],
]

// Score a single voice for the requested language. Language match dominates;
// among same-language voices, naturalness markers decide. Higher = better.
export function scoreVoice(voice: VoiceLike, lang: string): number {
  const want = primaryLang(lang)
  const have = primaryLang(voice.lang)
  let score = 0

  if (have === want) score += 1000
  else if (have) score -= 500 // wrong language — only as a last resort
  // Exact region match (en-US vs en-GB) is a mild tiebreaker.
  if (voice.lang.toLowerCase() === lang.toLowerCase()) score += 20

  for (const [re, w] of NATURAL_MARKERS) if (re.test(voice.name)) score += w
  for (const [re, w] of ROBOTIC_MARKERS) if (re.test(voice.name)) score += w

  // Cloud voices (localService === false) are usually higher fidelity.
  if (!voice.localService) score += 25
  if (voice.default) score += 5

  return score
}

// All voices sorted best-first for the requested language. Stable-ish: ties keep
// input order, so the platform's own ordering breaks exact ties deterministically.
export function rankVoices<T extends VoiceLike>(voices: T[], lang: string): T[] {
  return voices
    .map((v, i) => ({ v, i, s: scoreVoice(v, lang) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.v)
}

// The voice to actually use: the user's pick if it still exists, otherwise the
// best-ranked voice for the language. Returns null if there are no voices.
export function pickVoice<T extends VoiceLike>(voices: T[], lang: string, preferredURI?: string | null): T | null {
  if (!voices.length) return null
  if (preferredURI) {
    const chosen = voices.find(v => v.voiceURI === preferredURI)
    if (chosen) return chosen
  }
  return rankVoices(voices, lang)[0] ?? null
}

// Strip markdown / code so the synthesizer speaks prose, not punctuation. Reading
// "asterisk asterisk bold" or a whole code block aloud is the main thing that
// makes the default TTS feel robotic.
export function cleanForSpeech(text: string): string {
  return text
    // Fenced code blocks — don't read source aloud.
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/~~~[\s\S]*?~~~/g, ' code block ')
    // Images / links → keep the visible text only.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Inline code, bold, italic, strikethrough markers.
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // Headings, blockquotes, list bullets at line start.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    // Table pipes and horizontal rules.
    .replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '')
    .replace(/\|/g, ' ')
    // Collapse whitespace.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+\n/g, '\n')
    .trim()
}

// Split cleaned text into sentence-ish chunks. Two reasons: Chrome silently cuts
// off utterances longer than ~15s, and queueing per-sentence gives natural
// pauses. Greedily packs sentences up to maxLen.
export function chunkForSpeech(text: string, maxLen = 200): string[] {
  const cleaned = cleanForSpeech(text)
  if (!cleaned) return []
  const sentences = cleaned.match(/[^.!?…\n]+[.!?…]*\s*/g) ?? [cleaned]
  const chunks: string[] = []
  let buf = ''
  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) continue
    if (buf && (buf.length + 1 + s.length) > maxLen) {
      chunks.push(buf)
      buf = s
    } else {
      buf = buf ? `${buf} ${s}` : s
    }
    // A single oversized sentence — flush it on its own.
    while (buf.length > maxLen) {
      chunks.push(buf.slice(0, maxLen))
      buf = buf.slice(maxLen).trim()
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}
