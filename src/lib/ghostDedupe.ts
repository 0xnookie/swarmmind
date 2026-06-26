// De-duplicate a ghost-text suggestion against the document text that already
// follows the cursor. Models routinely re-emit characters that are already
// present after the caret — most visibly a closing bracket/quote the editor
// auto-inserted — so accepting the raw suggestion produces doubled tokens
// (predict "bar)" into "foo(|)" → "foo(bar))"). We trim the longest tail of the
// suggestion that duplicates the head of the suffix. Pure + unit-tested.
export function dedupeSuggestion(suggestion: string, suffix: string): string {
  if (!suggestion || !suffix) return suggestion
  const max = Math.min(suggestion.length, suffix.length)
  for (let k = max; k > 0; k--) {
    if (suggestion.slice(suggestion.length - k) === suffix.slice(0, k)) {
      return suggestion.slice(0, suggestion.length - k)
    }
  }
  return suggestion
}
