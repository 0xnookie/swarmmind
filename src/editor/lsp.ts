// CodeMirror extensions backed by the TypeScript language service
// (electron/lsp/*): hover tooltips and go-to-definition.
//
// Diagnostics are NOT here — they merge with the AI diagnostics in FileEditor
// and are dispatched through the existing `setDiagnostics` pipeline, so every
// real type error inherits the "Fix with AI" action for free.

import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view'

export type DefinitionTarget = { path: string; line: number; col: number }

/**
 * Hover the identifier under the pointer → the compiler's own type signature and
 * doc comment. `hideOnChange` drops the tooltip as soon as the doc moves, so a
 * slow reply can't leave a stale popup pinned over rewritten text.
 */
export function lspHover(getPath: () => string | null) {
  return hoverTooltip(
    async (view: EditorView, pos: number): Promise<Tooltip | null> => {
      const path = getPath()
      if (!path) return null

      let res: { markdown: string; from: number; to: number } | null = null
      try {
        res = await window.swarmmind.lspHover(path, view.state.doc.toString(), pos)
      } catch {
        return null
      }
      if (!res || !res.markdown) return null
      const markdown = res.markdown

      return {
        pos: res.from,
        end: res.to,
        above: true,
        create: () => ({ dom: renderHover(markdown) }),
      }
    },
    { hideOnChange: true },
  )
}

/**
 * The worker sends a fenced signature followed by the doc comment. Rendering it
 * by hand (rather than pulling in a markdown renderer) keeps the tooltip on the
 * editor's own type scale and avoids a dependency in the hot path.
 */
function renderHover(markdown: string): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cm-lsp-hover'

  const fence = /^```ts\n([\s\S]*?)\n```\n?/.exec(markdown)
  if (fence) {
    const sig = document.createElement('pre')
    sig.className = 'cm-lsp-hover-sig'
    sig.textContent = fence[1]
    dom.appendChild(sig)
  }
  const rest = (fence ? markdown.slice(fence[0].length) : markdown).trim()
  if (rest) {
    const doc = document.createElement('div')
    doc.className = 'cm-lsp-hover-doc'
    doc.textContent = rest
    dom.appendChild(doc)
  }
  return dom
}

/**
 * Ctrl/Cmd+Click an identifier → jump to its definition (VS Code's gesture).
 *
 * Handled on `mousedown` so we can `preventDefault` before CodeMirror starts a
 * selection drag; the lookup itself is async and fires the callback when it
 * lands. Returning true swallows the click even if the lookup ultimately finds
 * nothing — a modified click is unambiguously "navigate", never "select".
 */
export function lspGoToDefinition(getPath: () => string | null, onJump: (target: DefinitionTarget) => void) {
  return EditorView.domEventHandlers({
    mousedown(event: MouseEvent, view: EditorView) {
      if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false
      const path = getPath()
      if (!path) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos == null) return false

      event.preventDefault()
      void jumpToDefinition(view, path, pos, onJump)
      return true
    },
  })
}

/** Shared by the Ctrl+Click handler and the F12 keybinding in FileEditor. */
export async function jumpToDefinition(
  view: EditorView,
  path: string,
  pos: number,
  onJump: (target: DefinitionTarget) => void,
): Promise<boolean> {
  try {
    const target = await window.swarmmind.lspDefinition(path, view.state.doc.toString(), pos)
    if (!target) return false
    onJump(target)
    return true
  } catch {
    return false
  }
}
