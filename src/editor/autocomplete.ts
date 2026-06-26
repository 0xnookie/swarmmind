// Ghost-text autocomplete (Copilot/Cursor-style) for the file editor.
//
// As the user types, a debounced background request asks the model to predict
// the text at the cursor; the prediction is shown as dimmed inline "ghost text"
// that Tab accepts (Escape, or typing on, dismisses it). All of it is editor-
// level plumbing — a StateField holds the pending suggestion, a widget
// decoration renders it, a ViewPlugin drives the debounced fetch, and a
// high-precedence keymap binds Tab/Escape.
//
// Cost-awareness: requests are debounced, deduped by a request counter (stale
// responses are dropped), skipped when there's a selection, and gated behind an
// `enabled` getter so the feature can be toggled off.
import { StateEffect, StateField, Prec, type Extension } from '@codemirror/state'
import { nextWordBoundary } from '../lib/ghostAccept'
import { shouldRequestCompletion } from '../lib/ghostRequest'
import { dedupeSuggestion } from '../lib/ghostDedupe'
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  ViewPlugin,
  keymap,
  type ViewUpdate,
} from '@codemirror/view'

interface Ghost {
  from: number
  text: string
}

const setGhost = StateEffect.define<Ghost | null>()

// First line of a suggestion: an inline widget sitting right after the cursor.
class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: GhostWidget) {
    return other.text === this.text
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ghost-text'
    span.textContent = this.text
    return span
  }
  // The widget is non-interactive; let clicks fall through to the editor.
  ignoreEvent() {
    return false
  }
}

// Remaining lines of a multi-line suggestion. An *inline* widget is atomic to a
// single line, so newlines in it corrupt CodeMirror's line layout. The tail of
// a block completion is therefore rendered as a real block widget below the
// cursor's line (Copilot/Cursor do the same — first line inline, rest below).
class GhostBlockWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: GhostBlockWidget) {
    return other.text === this.text
  }
  toDOM() {
    const div = document.createElement('div')
    div.className = 'cm-ghost-text cm-ghost-block'
    div.textContent = this.text
    return div
  }
  ignoreEvent() {
    return false
  }
}

const ghostField = StateField.define<Ghost | null>({
  create() {
    return null
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value
    // Any real document or cursor movement invalidates a standing suggestion
    // (the new prediction, if any, arrives via a fresh setGhost effect).
    if (tr.docChanged || tr.selection) return null
    return value
  },
  // `compute` (not `from`) because positioning the block tail needs the doc to
  // find the cursor line's end.
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const g = state.field(f)
      if (!g || !g.text) return Decoration.none
      const nl = g.text.indexOf('\n')
      if (nl === -1) {
        return Decoration.set([
          Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.from),
        ])
      }
      // Multi-line: first line inline at the cursor, the rest as a block widget
      // anchored to the end of the cursor's line.
      const firstLine = g.text.slice(0, nl)
      const rest = g.text.slice(nl + 1)
      const lineEnd = state.doc.lineAt(g.from).to
      const decos = []
      if (firstLine)
        decos.push(Decoration.widget({ widget: new GhostWidget(firstLine), side: 1 }).range(g.from))
      decos.push(
        Decoration.widget({ widget: new GhostBlockWidget(rest), block: true, side: 1 }).range(lineEnd),
      )
      // Ranges may share a position (cursor at line end); let CM sort them.
      return Decoration.set(decos, true)
    }),
})

const ghostTheme = EditorView.baseTheme({
  '.cm-ghost-text': {
    opacity: '0.4',
    color: 'var(--text-muted)',
    whiteSpace: 'pre-wrap',
  },
  // Block tail of a multi-line completion: preserve its own indentation and sit
  // flush below the cursor line without adding editor chrome.
  '.cm-ghost-block': {
    fontStyle: 'inherit',
  },
})

/** Accept the pending ghost suggestion, if any. Exposed so a button can call it too. */
export function acceptGhost(view: EditorView): boolean {
  const g = view.state.field(ghostField, false)
  if (!g || !g.text) return false
  view.dispatch({
    changes: { from: g.from, insert: g.text },
    selection: { anchor: g.from + g.text.length },
    effects: setGhost.of(null),
  })
  return true
}

/**
 * Accept only the next word of the pending suggestion (Ctrl/Cmd-→), leaving the
 * rest as ghost text — Cursor's partial-accept. Returns false when there's no
 * ghost so the key falls through to normal word-wise cursor motion.
 */
export function acceptGhostWord(view: EditorView): boolean {
  const g = view.state.field(ghostField, false)
  if (!g || !g.text) return false
  const n = nextWordBoundary(g.text)
  if (n <= 0) return false
  if (n >= g.text.length) return acceptGhost(view) // nothing left to keep as ghost
  const accepted = g.text.slice(0, n)
  const nextFrom = g.from + accepted.length
  // The setGhost effect is honoured before this transaction's docChange/selection
  // would otherwise clear the field (see ghostField.update), so the remainder
  // survives, re-anchored after the inserted text.
  view.dispatch({
    changes: { from: g.from, insert: accepted },
    selection: { anchor: nextFrom },
    effects: setGhost.of({ from: nextFrom, text: g.text.slice(n) }),
  })
  return true
}

function clearGhost(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)) return false
  view.dispatch({ effects: setGhost.of(null) })
  return true
}

const PREFIX_CHARS = 2000
const SUFFIX_CHARS = 1000

interface GhostOptions {
  /** Current language label for the open file (e.g. "TypeScript"). */
  getLanguage: () => string
  /** Whether autocomplete is currently enabled. */
  isEnabled: () => boolean
  /** Debounce before firing a request, ms. */
  debounceMs?: number
}

function fetcher(opts: GhostOptions) {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null
      reqSeq = 0

      constructor(readonly view: EditorView) {}

      update(u: ViewUpdate) {
        // Only (re)fetch when the document changed from typing. A bare cursor
        // move clears the ghost (via the field) but shouldn't spend a request.
        if (u.docChanged) this.schedule()
      }

      schedule() {
        if (this.timer) clearTimeout(this.timer)
        if (!opts.isEnabled()) return
        this.timer = setTimeout(() => this.run(), opts.debounceMs ?? 350)
      }

      async run() {
        const view = this.view
        const state = view.state
        const sel = state.selection.main
        if (!sel.empty) return // no ghost while selecting
        const pos = sel.head
        const doc = state.doc
        const prefix = doc.sliceString(Math.max(0, pos - PREFIX_CHARS), pos)
        const suffix = doc.sliceString(pos, Math.min(doc.length, pos + SUFFIX_CHARS))
        // Gate the (token-spending) request: skip empty buffers and mid-token
        // positions where a prediction would just be noise.
        if (!shouldRequestCompletion(prefix, suffix)) return
        const seq = ++this.reqSeq
        let res: { text: string }
        try {
          res = await window.swarmmind.swarmAgentComplete({
            prefix,
            suffix,
            language: opts.getLanguage(),
          })
        } catch {
          return
        }
        if (seq !== this.reqSeq) return // superseded by a newer keystroke
        if (!opts.isEnabled()) return // toggled off while in flight
        if (view.state.selection.main.head !== pos) return // cursor moved
        // Trim any tail the model re-emitted that the doc already has after the
        // cursor (e.g. an auto-closed bracket), so accepting can't double it.
        const text = dedupeSuggestion(res.text ?? '', suffix)
        if (!text) return
        view.dispatch({ effects: setGhost.of({ from: pos, text }) })
      }

      destroy() {
        if (this.timer) clearTimeout(this.timer)
      }
    },
  )
}

/**
 * Build the ghost-text autocomplete extension. `getLanguage`/`isEnabled` are
 * read live so the same extension instance tracks the open file's language and
 * the user's on/off toggle without being rebuilt.
 */
export function ghostCompletion(opts: GhostOptions): Extension {
  return [
    ghostField,
    ghostTheme,
    fetcher(opts),
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: acceptGhost },
        // Partial accept — one word at a time, like Cursor. Falls through to
        // normal word-wise cursor motion when there's no suggestion.
        { key: 'Mod-ArrowRight', run: acceptGhostWord },
        { key: 'Escape', run: clearGhost },
      ]),
    ),
  ]
}
