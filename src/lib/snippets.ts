// Code snippets — reusable fragments the user saves from a selection and inserts
// later (a standard editor feature; here scoped to the file editor). The pure
// CRUD + filter logic lives in this module so it can be unit-tested; the store
// owns persistence (an `editorSnippets` JSON app-setting) and the editor owns
// the insert/save UI.

export interface Snippet {
  id: string
  name: string
  body: string
  /** Optional language label captured when saved, for display only. */
  lang?: string
}

/** Append a snippet, replacing any existing one with the same (case-insensitive) name. */
export function addSnippet(list: Snippet[], snippet: Snippet): Snippet[] {
  const name = snippet.name.trim().toLowerCase()
  return [...list.filter((s) => s.name.trim().toLowerCase() !== name), snippet]
}

export function removeSnippet(list: Snippet[], id: string): Snippet[] {
  return list.filter((s) => s.id !== id)
}

/** Case-insensitive name/body substring filter; empty query returns all (name-sorted). */
export function filterSnippets(list: Snippet[], query: string): Snippet[] {
  const q = query.trim().toLowerCase()
  const matched = q
    ? list.filter((s) => s.name.toLowerCase().includes(q) || s.body.toLowerCase().includes(q))
    : list
  return [...matched].sort((a, b) => a.name.localeCompare(b.name))
}

/** Parse persisted JSON into a validated snippet list (defensive against corruption). */
export function parseSnippets(json: string | null | undefined): Snippet[] {
  if (!json) return []
  try {
    const data = JSON.parse(json)
    if (!Array.isArray(data)) return []
    return data
      .filter(
        (s): s is Snippet =>
          s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.body === 'string',
      )
      .map((s) => ({ id: s.id, name: s.name, body: s.body, ...(s.lang ? { lang: s.lang } : {}) }))
  } catch {
    return []
  }
}
