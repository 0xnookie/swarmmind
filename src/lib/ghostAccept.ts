// Partial-accept boundary for ghost-text autocomplete. Cursor/Copilot let you
// accept a suggestion one word at a time (Ctrl/Cmd-→) instead of the whole
// thing (Tab). Given the pending ghost text, this returns the length of the
// prefix that counts as "the next word" — leading whitespace (so indentation and
// even a newline are pulled along, letting accept-word walk down a block token
// by token) followed by either a run of word characters or a run of punctuation.
// Pure so it can be unit-tested without the editor.
export function nextWordBoundary(text: string): number {
  if (!text) return 0
  let i = 0
  // Pull along any leading whitespace (indentation / newline before the token).
  while (i < text.length && /\s/.test(text[i])) i++
  if (i >= text.length) return text.length // whitespace only — accept it all
  if (/\w/.test(text[i])) {
    // A normal identifier/number run.
    while (i < text.length && /\w/.test(text[i])) i++
  } else {
    // A run of symbols/punctuation (e.g. "=>", "})") taken together.
    while (i < text.length && !/\w/.test(text[i]) && !/\s/.test(text[i])) i++
  }
  return i
}
