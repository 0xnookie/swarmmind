// Request gate for ghost-text autocomplete. Each request spends a Groq call, so
// the fetcher should only fire where a completion is actually useful. This pure
// predicate captures the "is this a sensible place to predict?" decision so it
// can be unit-tested apart from the editor plumbing.
export function shouldRequestCompletion(prefix: string, suffix: string): boolean {
  // Empty/whitespace-only buffer — nothing meaningful to continue.
  if (!prefix.trim() && !suffix.trim()) return false
  // Cursor sits in the middle of an identifier or number (the next char is a
  // word char): the user is editing an existing token, not asking for a
  // continuation. Predicting here yields noisy, usually-wrong ghost text — and
  // would clash with CodeMirror's own word completion — so skip it.
  if (suffix.length && /\w/.test(suffix[0])) return false
  return true
}
