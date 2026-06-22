import { useCallback, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { fuzzyMatch } from '../lib/fuzzy'

// @-mention file autocomplete for prompt composers (broadcast bar, SwarmAgent).
// Typing "@" followed by a fragment opens a fuzzy-ranked list of the workspace's
// files; choosing one inserts its workspace-relative path so the agent can read
// it — the standard vibecoding affordance. The recursive file index is loaded
// lazily (first "@") and cached per workspace; see fs:listFiles in the main
// process for the bounded walk.

const MAX_RESULTS = 8

export interface FileMentions {
  active: boolean
  candidates: string[]
  index: number
  query: string
  setIndex: (i: number) => void
  choose: (path: string) => void
  /** Recompute the active mention from the caret — call on change + key/click. */
  refresh: () => void
  /** Handle nav keys while the menu is open; returns true if it consumed the event. */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useFileMentions(opts: {
  value: string
  setValue: (v: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}): FileMentions {
  const { value, setValue, textareaRef } = opts
  const root = useWorkspaceStore(s => s.workspace?.rootPath)
  const [files, setFiles] = useState<string[]>([])
  const loadedFor = useRef<string | null>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [start, setStart] = useState(0)
  const [index, setIndex] = useState(0)

  const ensureIndex = useCallback(() => {
    if (!root || loadedFor.current === root) return
    loadedFor.current = root
    window.swarmmind.fsListFiles(root).then(f => setFiles(Array.isArray(f) ? f : [])).catch(() => {})
  }, [root])

  const refresh = useCallback(() => {
    const el = textareaRef.current
    if (!el || !root) { setQuery(null); return }
    const caret = el.selectionStart ?? 0
    // An "@token" at the caret, anchored to start-of-input or whitespace so it
    // doesn't fire inside emails or mid-word.
    const m = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/)
    if (!m) { setQuery(null); return }
    ensureIndex()
    setStart(caret - m[1].length - 1)
    setQuery(m[1])
    setIndex(0)
  }, [value, root, ensureIndex, textareaRef])

  const candidates = useMemo<string[]>(() => {
    if (query === null) return []
    if (!query) return files.slice(0, MAX_RESULTS)
    const scored: { f: string; s: number }[] = []
    for (const f of files) {
      const r = fuzzyMatch(query, f)
      if (r.matched) scored.push({ f, s: r.score })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, MAX_RESULTS).map(x => x.f)
  }, [query, files])

  const choose = useCallback((path: string) => {
    const el = textareaRef.current
    const caret = el?.selectionStart ?? value.length
    const next = value.slice(0, start) + '@' + path + ' ' + value.slice(caret)
    setValue(next)
    setQuery(null)
    const pos = start + path.length + 2
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(pos, pos) } })
  }, [value, setValue, start, textareaRef])

  const active = query !== null && candidates.length > 0

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!active) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(candidates.length - 1, i + 1)); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(candidates[index]); return true }
    if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return true }
    return false
  }, [active, candidates, index, choose])

  return { active, candidates, index, query: query ?? '', setIndex, choose, refresh, onKeyDown }
}
