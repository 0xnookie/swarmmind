// The active @-mention fragment under the caret, used by the Cmd-K inline-edit
// prompt's file autocomplete. An "@" that starts the line or follows whitespace,
// up to the caret. Returns its start offset + the query typed after the "@".
// Extracted as a pure function so it can be unit-tested.
export function activeMentionAt(text: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i]) && text[i] !== '@') i--
  if (i < 0 || text[i] !== '@') return null
  if (i > 0 && !/\s/.test(text[i - 1])) return null // '@' must be word-initial
  return { start: i, query: text.slice(i + 1, caret) }
}
