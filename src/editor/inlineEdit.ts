// Inline-edit (Cmd/Ctrl+K) support for the file editor — the Cursor-style
// "vibe coding" surface. This module owns the small CodeMirror plumbing:
//
//   - a Mod-k keymap that hands the live EditorView to a React callback, and
//   - a decoration StateField that tints a range while an AI edit is pending
//     (the green "this is the proposed change" highlight) until it's accepted
//     or rejected.
//
// The actual prompt UI, model call, and accept/reject flow live in FileEditor;
// this file is only the editor-level glue so the React side can drive it.
import { StateEffect, StateField, Prec, type Extension } from '@codemirror/state'
import { EditorView, Decoration, type DecorationSet, keymap } from '@codemirror/view'

// Carries the range to highlight, or null to clear it.
export const setEditHighlight = StateEffect.define<{ from: number; to: number } | null>()

const highlightMark = Decoration.mark({ class: 'cm-ai-edit' })

const editHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(deco, tr) {
    // Map existing highlight through document changes so it tracks edits.
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setEditHighlight)) {
        deco = e.value
          ? Decoration.set([highlightMark.range(e.value.from, e.value.to)])
          : Decoration.none
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

/**
 * Build the inline-edit extension. `onTrigger` is called with the live view
 * when the user presses Cmd/Ctrl+K. We give it the highest precedence so it
 * wins over the editor's other Mod-k bindings (there are none today, but this
 * keeps it robust against future keymaps).
 */
const editHighlightTheme = EditorView.baseTheme({
  '.cm-ai-edit': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    borderRadius: '2px',
    boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)',
  },
})

export function inlineEdit(onTrigger: (view: EditorView) => void): Extension {
  return [
    editHighlightField,
    editHighlightTheme,
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-k',
          run: (view) => {
            onTrigger(view)
            return true
          },
        },
      ]),
    ),
  ]
}
