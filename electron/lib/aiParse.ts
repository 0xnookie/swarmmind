// Shared, defensive parsing for LLM responses. Models often wrap output in
// Markdown code fences or add stray prose despite "raw output only" / JSON-mode
// instructions, so every handler that consumes model output must sanitise it.
// Centralised here (instead of re-implemented per handler) so the behaviour is
// consistent and unit-testable.

/**
 * Remove a leading ```lang fence line and a matching trailing ``` fence, if
 * present. Only strips the trailing fence when a leading one was found, so plain
 * code that merely ends in backticks is left untouched.
 */
export function stripCodeFences(text: string): string {
  const open = text.match(/^\s*```[^\n]*\n/)
  if (!open) return text
  return text.slice(open[0].length).replace(/\n?```\s*$/, '')
}

/**
 * Extract the outermost JSON object from a model response: strip any code
 * fence, then slice from the first `{` to the last `}`. Returns the trimmed
 * input unchanged if no braces are found (so the caller's JSON.parse fails
 * cleanly and surfaces a readable error rather than this silently mangling it).
 */
export function extractJsonObject(text: string): string {
  const t = stripCodeFences(text.trim()).trim()
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first === -1 || last === -1 || last < first) return t
  return t.slice(first, last + 1)
}
