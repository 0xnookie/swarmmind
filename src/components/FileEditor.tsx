import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useWorkspaceStore } from '../store/workspace'
import ReactCodeMirror, { type ViewUpdate } from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { editorTheme } from '../editor/theme'
import { loadLanguage, languageName } from '../editor/languages'
import { inlineEdit, setEditHighlight } from '../editor/inlineEdit'
import { ghostCompletion } from '../editor/autocomplete'
import { lspGoToDefinition, lspHover, jumpToDefinition } from '../editor/lsp'
import { lintGutter, linter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { activeMentionAt } from '../lib/mention'
import { lineDiff } from '../lib/lineDiff'
import { fuzzyRank } from '../lib/fuzzy'
import { resolveNextEditTarget, type NextEditTarget } from '../lib/nextEdit'
import { mergeDiagnostics, summarizeDiagnostics, type RawDiag } from '../lib/diagnostics'
import { renderDiffRows } from './DiffRows'

// How many lines of surrounding context to send the model with an inline edit.
const CONTEXT_LINES = 40
// Quiet period after a keystroke before we re-ask the language service. Type
// checking is free (no tokens), so this can be tight — it just shouldn't run on
// every character.
const LSP_DEBOUNCE_MS = 500

interface RenameState {
  from: number
  to: number
  oldName: string
  value: string
  top: number
  left: number
  busy: boolean
}

type InlineEditPhase = 'prompt' | 'streaming' | 'preview'
interface InlineEditState {
  phase: InlineEditPhase
  from: number
  to: number // current end of the (selection | applied) range
  originalText: string
  newText: string // applied replacement (preview phase)
  instruction: string
  draft: string // streamed text so far
  top: number
  left: number
  error: string | null
}

export interface FileEditorProps {
  filePath: string | null
  fileName: string | null
  /** Path relative to the workspace root, for the status-bar breadcrumb. */
  relPath: string | null
  content: string
  isDirty: boolean
  onChange: (newContent: string) => void
  onSave: () => void
  /** Total dirty tabs open (drives the "Save all" affordance). */
  dirtyCount: number
  onSaveAll: () => void
}

interface CursorInfo {
  line: number
  col: number
  selected: number
  cursors: number
}

// Static (per-mount) extensions: VS Code-style Alt+Click adds a cursor,
// indent guides match the theme's border colours.
const staticExtensions: Extension[] = [
  editorTheme,
  EditorView.clickAddsSelectionRange.of((e) => e.altKey),
  indentationMarkers({
    hideFirstIndent: true,
    highlightActiveBlock: true,
    thickness: 1,
    colors: {
      light: 'var(--border)',
      dark: 'var(--border)',
      activeLight: 'var(--border-active)',
      activeDark: 'var(--border-active)',
    },
  }),
]

export function FileEditor({
  filePath,
  fileName,
  relPath,
  content,
  isDirty,
  onChange,
  onSave,
  dirtyCount,
  onSaveAll,
}: FileEditorProps) {
  const t = useT()
  const [langExt, setLangExt] = useState<Extension | null>(null)
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, col: 1, selected: 0, cursors: 1 })
  const editorWrapRef = useRef<HTMLDivElement>(null)
  const setEditorFontSize = useWorkspaceStore((s) => s.setEditorFontSize)

  // ── Inline edit (Cmd/Ctrl+K) ────────────────────────────────────────────
  const rootPath = useWorkspaceStore((s) => s.workspace?.rootPath ?? null)
  const openComposerWith = useWorkspaceStore((s) => s.openComposerWith)
  const ghostEnabled = useWorkspaceStore((s) => s.ghostTextEnabled)
  const setGhostTextEnabled = useWorkspaceStore((s) => s.setGhostTextEnabled)
  const snippets = useWorkspaceStore((s) => s.snippets)
  const addSnippetStore = useWorkspaceStore((s) => s.addSnippet)
  const removeSnippetStore = useWorkspaceStore((s) => s.removeSnippet)
  // Read live inside the (stable) CodeMirror plugin without rebuilding it.
  const ghostEnabledRef = useRef(ghostEnabled)
  ghostEnabledRef.current = ghostEnabled
  const langNameRef = useRef<string>('plain text')
  const viewRef = useRef<EditorView | null>(null)
  // The open file, read live by the once-built LSP extensions (hover / go-to-def)
  // so switching files doesn't force CodeMirror to rebuild them.
  const filePathRef = useRef<string | null>(filePath)
  filePathRef.current = filePath
  const promptInputRef = useRef<HTMLTextAreaElement>(null)
  const [edit, setEdit] = useState<InlineEditState | null>(null)
  // Next-edit prediction ("Tab to jump"): after an AI edit, the model points at
  // the next related change; this chip offers to jump there and continue.
  const [nextEditHint, setNextEditHint] = useState<NextEditTarget | null>(null)
  // Project file list (relative, forward-slash paths) for @-mention autocomplete,
  // loaded lazily the first time the inline-edit widget opens.
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const mentionFilesLoaded = useRef(false)
  // Stable trigger the (once-built) keymap calls; reads the latest opener.
  const openRef = useRef<(view: EditorView) => void>(() => {})
  // The in-flight edit request; cleared on close so a result that lands after
  // the user cancelled is ignored (and never applied to the doc).
  const activeReqRef = useRef<string | null>(null)
  // Rename-symbol (F2) popover + its stable trigger for the keymap.
  const [rename, setRename] = useState<RenameState | null>(null)
  const renameRef = useRef<(view: EditorView) => void>(() => {})
  const renameInputRef = useRef<HTMLInputElement>(null)
  // Stable trigger for the Tab-to-jump keybinding; returns whether it jumped so
  // the keymap can fall through to ghost-accept / default Tab when there's no hint.
  const jumpRef = useRef<() => boolean>(() => false)
  // Latest edit/hint state for the once-built keymap to read (Escape handler).
  const editRef = useRef<InlineEditState | null>(null)
  const hintRef = useRef<NextEditTarget | null>(null)
  editRef.current = edit
  hintRef.current = nextEditHint

  // Terminal→editor bridge: consume a one-shot reveal seed (openFileAtLine) once
  // this editor shows the requested file. The CodeMirror view is created by
  // ReactCodeMirror's own effect, so poll briefly until it exists, then select
  // the line, center it, and clear the seed.
  const editorReveal = useWorkspaceStore((s) => s.editorReveal)
  useEffect(() => {
    if (!editorReveal || editorReveal.path !== filePath) return
    let cancelled = false
    let attempts = 0
    const tryReveal = () => {
      if (cancelled) return
      const view = viewRef.current
      if (!view) {
        if (++attempts < 20) setTimeout(tryReveal, 30)
        return
      }
      const lineNo = Math.max(1, Math.min(view.state.doc.lines, editorReveal.line ?? 1))
      const ln = view.state.doc.line(lineNo)
      view.dispatch({
        selection: { anchor: ln.from, head: ln.to },
        effects: EditorView.scrollIntoView(ln.from, { y: 'center' }),
      })
      view.focus()
      useWorkspaceStore.getState().clearEditorReveal()
    }
    tryReveal()
    return () => { cancelled = true }
  }, [editorReveal, filePath])

  // Position the floating widget near a document offset, in wrap-local coords.
  const widgetCoordsFor = (view: EditorView, pos: number) => {
    const coords = view.coordsAtPos(pos)
    const wrap = editorWrapRef.current
    if (!coords || !wrap) return { top: 8, left: 8 }
    const rect = wrap.getBoundingClientRect()
    return {
      top: Math.max(4, coords.bottom - rect.top + 4),
      left: Math.min(Math.max(8, coords.left - rect.left), rect.width - 380),
    }
  }

  // Open the Cmd-K inline-edit widget. With no opts it operates on the current
  // selection; "Fix with AI" passes an explicit range + prefilled instruction.
  const openInlineEdit = (
    view: EditorView,
    opts?: { from?: number; to?: number; instruction?: string },
  ) => {
    // Warm the @-mention file index once per editor mount.
    if (!mentionFilesLoaded.current && rootPath) {
      mentionFilesLoaded.current = true
      window.swarmmind
        .fsListFiles(rootPath, 4000)
        .then((files) => setMentionFiles(files.map((f) => f.replace(/\\/g, '/'))))
        .catch(() => {})
    }
    const sel = view.state.selection.main
    const from = opts?.from ?? sel.from
    const to = opts?.to ?? sel.to
    const originalText = view.state.doc.sliceString(from, to)
    if (from !== to) view.dispatch({ effects: setEditHighlight.of({ from, to }) })
    const { top, left } = widgetCoordsFor(view, from)
    setEdit({
      phase: 'prompt',
      from,
      to,
      originalText,
      newText: '',
      instruction: opts?.instruction ?? '',
      draft: '',
      top,
      left,
      error: null,
    })
    setTimeout(() => promptInputRef.current?.focus(), 0)
  }
  openRef.current = openInlineEdit

  const closeInlineEdit = () => {
    activeReqRef.current = null
    viewRef.current?.dispatch({ effects: setEditHighlight.of(null) })
    setEdit(null)
    setTimeout(() => viewRef.current?.focus(), 0)
  }

  const submitInlineEdit = async () => {
    const view = viewRef.current
    if (!view || !edit || !edit.instruction.trim()) return
    const { from, to } = edit
    const doc = view.state.doc
    const startLine = doc.lineAt(from).number
    const endLine = doc.lineAt(to).number
    const beforeFrom = doc.line(Math.max(1, startLine - CONTEXT_LINES)).from
    const afterTo = doc.line(Math.min(doc.lines, endLine + CONTEXT_LINES)).to
    const before = doc.sliceString(beforeFrom, from)
    const after = doc.sliceString(to, afterTo)

    // Resolve @-mentioned files (relative paths) to their contents so the model
    // can use them as context. Capped to keep the prompt bounded.
    const mentionPaths = Array.from(
      new Set((edit.instruction.match(/@([^\s@]+)/g) ?? []).map((m) => m.slice(1))),
    ).slice(0, 5)
    const mentions: { path: string; content: string }[] = []
    if (rootPath) {
      for (const rel of mentionPaths) {
        try {
          const abs = `${rootPath.replace(/\\/g, '/')}/${rel}`
          const content = await window.swarmmind.fsReadFile(abs)
          mentions.push({ path: rel, content: content.slice(0, 8000) })
        } catch {
          /* unresolvable mention — skip silently */
        }
      }
    }

    const requestId = crypto.randomUUID()
    activeReqRef.current = requestId
    setEdit((e) => (e ? { ...e, phase: 'streaming', draft: '', error: null } : e))
    const off = window.swarmmind.onSwarmAgentEditDelta((d) => {
      if (d.requestId !== requestId) return
      setEdit((e) => (e && e.phase === 'streaming' ? { ...e, draft: e.draft + d.text } : e))
    })
    try {
      const res = await window.swarmmind.swarmAgentEditCode(requestId, {
        instruction: edit.instruction,
        selection: edit.originalText,
        before,
        after,
        language: (fileName ? languageName(fileName) : null) ?? 'plain text',
        fileName: fileName ?? 'untitled',
        mentions,
      })
      off()
      if (activeReqRef.current !== requestId) return // cancelled while in flight
      if (res.error || res.code == null) {
        setEdit((e) => (e ? { ...e, phase: 'prompt', error: res.error ?? 'No output.' } : e))
        setTimeout(() => promptInputRef.current?.focus(), 0)
        return
      }
      // Apply the replacement and switch to accept/reject preview.
      const code = res.code
      view.dispatch({
        changes: { from, to, insert: code },
        effects: setEditHighlight.of({ from, to: from + code.length }),
      })
      const { top, left } = widgetCoordsFor(view, from)
      setEdit((e) =>
        e ? { ...e, phase: 'preview', to: from + code.length, newText: code, top, left } : e,
      )
    } catch (err) {
      off()
      setEdit((e) =>
        e ? { ...e, phase: 'prompt', error: err instanceof Error ? err.message : String(err) } : e,
      )
    }
  }

  const acceptInlineEdit = () => {
    const view = viewRef.current
    const accepted = edit
    closeInlineEdit() // changes are already in the doc
    // Fire-and-forget: ask where the next related edit likely belongs, then
    // surface a "Tab to jump" chip. Best-effort — any failure just stays quiet.
    if (view && accepted) {
      const doc = view.state.doc
      const fromLine = doc.lineAt(Math.min(accepted.from, doc.length)).number
      const toLine = doc.lineAt(Math.min(accepted.to, doc.length)).number
      window.swarmmind
        .swarmAgentNextEdit({
          content: doc.toString(),
          language: (fileName ? languageName(fileName) : null) ?? 'plain text',
          fileName: fileName ?? 'untitled',
          editedFromLine: fromLine,
          editedToLine: toLine,
        })
        .then((res) => {
          if (res.error) return
          const target = resolveNextEditTarget(res.prediction, doc.lines, toLine)
          if (target) setNextEditHint(target)
        })
        .catch(() => {})
    }
  }

  // Jump to the predicted next edit: move the cursor to that line and open the
  // inline-edit prompt prefilled with the suggested instruction. Returns true if
  // a jump happened so the Tab keymap can fall through when there's no hint.
  const jumpToNextEdit = (): boolean => {
    const view = viewRef.current
    if (!view || !nextEditHint) return false
    const line = view.state.doc.line(Math.min(nextEditHint.line, view.state.doc.lines))
    view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true })
    view.focus()
    const instruction = nextEditHint.instruction
    setNextEditHint(null)
    openInlineEdit(view, { from: line.from, to: line.to, instruction })
    return true
  }
  jumpRef.current = jumpToNextEdit

  const rejectInlineEdit = () => {
    const view = viewRef.current
    if (view && edit && edit.phase === 'preview') {
      view.dispatch({
        changes: { from: edit.from, to: edit.to, insert: edit.originalText },
      })
    }
    closeInlineEdit()
  }

  // ── Rename symbol across files (F2) ─────────────────────────────────────
  const openRename = (view: EditorView) => {
    const sel = view.state.selection.main
    // The word under the cursor, or the selection if it's a single token.
    const wordRange = view.state.wordAt(sel.head) ?? (sel.empty ? null : sel)
    if (!wordRange) return
    const oldName = view.state.doc.sliceString(wordRange.from, wordRange.to).trim()
    if (!oldName || !/^[A-Za-z_$][\w$]*$/.test(oldName)) return // identifiers only
    const { top, left } = widgetCoordsFor(view, wordRange.from)
    setRename({ from: wordRange.from, to: wordRange.to, oldName, value: oldName, top, left, busy: false })
    setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 0)
  }
  renameRef.current = openRename

  const submitRename = async () => {
    if (!rename || !rootPath) return
    const newName = rename.value.trim()
    if (!newName || newName === rename.oldName || !/^[A-Za-z_$][\w$]*$/.test(newName)) {
      setRename(null)
      return
    }
    setRename((r) => (r ? { ...r, busy: true } : r))
    // Find files that reference the symbol (grep), plus the current file.
    let paths: string[] = []
    try {
      const matches = await window.swarmmind.fsSearchFiles(rootPath, rename.oldName, '', 200)
      paths = Array.from(new Set(matches.map((m) => m.path.replace(/\\/g, '/'))))
    } catch {
      /* fall through with just the current file */
    }
    const rootFwd = rootPath.replace(/\\/g, '/')
    if (filePath) {
      const relCur = filePath.replace(/\\/g, '/').startsWith(rootFwd + '/')
        ? filePath.replace(/\\/g, '/').slice(rootFwd.length + 1)
        : null
      if (relCur && !paths.includes(relCur)) paths.unshift(relCur)
    }
    paths = paths.slice(0, 12) // bound the Composer request
    const instruction =
      `Rename the symbol "${rename.oldName}" to "${newName}" across the codebase. ` +
      `Update every declaration and reference of this exact identifier, including imports/exports. ` +
      `Do NOT rename unrelated identifiers that merely contain "${rename.oldName}" as a substring, ` +
      `and do not touch matches inside unrelated strings or comments.`
    setRename(null)
    openComposerWith({ instruction, contextPaths: paths })
  }

  // ── Snippets (save selection / insert at cursor) ────────────────────────
  const [snipOpen, setSnipOpen] = useState(false)
  const [snipName, setSnipName] = useState<{ body: string; name: string } | null>(null)

  const insertSnippet = (body: string) => {
    const view = viewRef.current
    if (!view) return
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: body },
      selection: { anchor: sel.from + body.length },
    })
    view.focus()
    setSnipOpen(false)
  }

  const beginSaveSnippet = () => {
    const view = viewRef.current
    if (!view) return
    const sel = view.state.selection.main
    const body = view.state.doc.sliceString(sel.from, sel.to)
    if (!body) return // nothing selected
    setSnipName({ body, name: '' })
  }

  const commitSaveSnippet = () => {
    if (!snipName || !snipName.name.trim()) return
    addSnippetStore(snipName.name, snipName.body, langNameRef.current)
    setSnipName(null)
    setSnipOpen(false)
  }

  // ── Diagnostics: compiler + AI, one gutter ──────────────────────────────
  // Two sources feed the same lint list:
  //   • the TypeScript language service — free, automatic, authoritative;
  //   • the model (`swarmAgent:diagnose`) — click-triggered, catches what a type
  //     checker can't see (logic bugs, edge cases).
  // `mergeDiagnostics` (pure, unit-tested) resolves the overlap. The payoff is
  // that a REAL type error now inherits the existing "Fix with AI" action: one
  // click sends it to the inline-edit widget.
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagCount, setDiagCount] = useState<number | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  const aiDiagsRef = useRef<RawDiag[]>([])
  const tsDiagsRef = useRef<RawDiag[]>([])
  const [tsSummary, setTsSummary] = useState<{ errors: number; warnings: number } | null>(null)

  // Rebuild the CodeMirror lint list from both sources and dispatch it.
  const renderDiagnostics = (view: EditorView) => {
    const doc = view.state.doc
    const merged = mergeDiagnostics(tsDiagsRef.current, aiDiagsRef.current)
    const diags: Diagnostic[] = merged.map((d) => {
      const lineNo = Math.min(Math.max(1, d.line), doc.lines)
      const line = doc.line(lineNo)
      // The compiler gives an exact span, so underline just the offending
      // expression; the model only knows a line, so underline the whole line.
      const from = d.from != null ? Math.min(Math.max(d.from, 0), doc.length) : line.from
      const to = d.to != null ? Math.min(Math.max(d.to, from), doc.length) : line.to
      const instruction =
        d.source === 'ts'
          ? `Fix this TypeScript error${d.code ? ` (TS${d.code})` : ''}: ${d.message}`
          : d.fix || `Fix this problem: ${d.message}`
      return {
        from,
        to,
        severity: d.severity,
        message: d.message,
        source: d.source === 'ts' ? 'tsserver' : 'ai',
        actions: [
          {
            name: t('file.diag.fix'),
            // Hand the inline-edit widget the whole LINE, not the error's narrow
            // span — the model needs a complete statement to rewrite.
            apply: (v: EditorView) => {
              v.focus()
              const ln = v.state.doc.lineAt(from)
              openInlineEdit(v, { from: ln.from, to: ln.to, instruction })
            },
          },
        ],
      }
    })
    view.dispatch(setDiagnostics(view.state, diags))
    return merged
  }

  // Live compiler diagnostics: debounced on every edit, no click and no tokens.
  useEffect(() => {
    const path = filePath
    if (!path) return
    let cancelled = false
    const timer = setTimeout(async () => {
      let list: RawDiag[] = []
      try {
        const raw = await window.swarmmind.lspDiagnostics(path, content)
        const view = viewRef.current
        if (cancelled || !view) return
        // Offsets are indices into the text we SENT. If the user kept typing
        // while the request was in flight the doc has moved, so drop the result
        // rather than underlining the wrong characters — the next debounce tick
        // will produce a fresh, correct set.
        if (view.state.doc.length !== content.length) return
        const doc = view.state.doc
        list = raw.map((d) => ({
          line: doc.lineAt(Math.min(Math.max(d.from, 0), doc.length)).number,
          from: d.from,
          to: d.to,
          message: d.message,
          severity: d.severity,
          source: 'ts' as const,
          code: d.code,
        }))
      } catch {
        list = [] // no TypeScript in this repo, or the service is down — stay quiet
      }
      if (cancelled) return
      const view = viewRef.current
      if (!view) return
      tsDiagsRef.current = list
      renderDiagnostics(view)
      setTsSummary(list.length ? summarizeDiagnostics(list) : { errors: 0, warnings: 0 })
    }, LSP_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [filePath, content])

  // Drop the language service's copy of a file the editor no longer has open.
  useEffect(() => {
    const path = filePath
    if (!path) return
    return () => {
      void window.swarmmind.lspClose(path)
    }
  }, [filePath])

  const runDiagnostics = async () => {
    const view = viewRef.current
    if (!view || diagnosing) return
    setDiagnosing(true)
    setDiagError(null)
    try {
      const res = await window.swarmmind.swarmAgentDiagnose({
        content: view.state.doc.toString(),
        language: langNameRef.current,
        fileName: fileName ?? 'untitled',
      })
      // A failed request must NOT read as "✓ No issues" — surface the reason and
      // leave the count unknown.
      if (res.error) {
        setDiagError(res.error === 'no-key' ? t('file.aiEdit.noKey') : res.error)
        setDiagCount(null)
        return
      }
      aiDiagsRef.current = (res.diagnostics ?? []).map((d) => ({
        line: d.line,
        message: d.message,
        severity: (d.severity as RawDiag['severity']) ?? 'warning',
        source: 'ai' as const,
        fix: d.fix,
      }))
      const merged = renderDiagnostics(view)
      setDiagCount(merged.length)
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : String(err))
      setDiagCount(null)
    } finally {
      setDiagnosing(false)
    }
  }

  // Ctrl+scroll zooms the editor font, like VS Code. Needs a native non-passive
  // listener — React's onWheel is passive, so preventDefault would be ignored.
  useEffect(() => {
    const el = editorWrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const current = useWorkspaceStore.getState().editorFontSize
      setEditorFontSize(current + (e.deltaY < 0 ? 1 : -1))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setEditorFontSize])

  // Dismiss any open inline-edit widget and clear stale diagnostics when the
  // file changes (their offsets are meaningless against a different document).
  useEffect(() => {
    setEdit(null)
    setRename(null)
    setNextEditHint(null)
    setDiagCount(null)
    setDiagError(null)
    setTsSummary(null)
    aiDiagsRef.current = []
    tsDiagsRef.current = []
    const view = viewRef.current
    if (view) view.dispatch(setDiagnostics(view.state, []))
  }, [filePath])

  const langName = useMemo(() => (fileName ? languageName(fileName) : null), [fileName])
  langNameRef.current = langName ?? 'plain text'

  // Lazily import the parser for the open file's language.
  useEffect(() => {
    let cancelled = false
    setLangExt(null)
    if (!fileName) return
    loadLanguage(fileName).then((ext) => {
      if (!cancelled) setLangExt(ext)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, fileName])

  const extensions = useMemo(
    () => [
      ...staticExtensions,
      lintGutter(),
      // `linter(null)` = "install the lint state, but no lint source of our own"
      // (the library's documented hook for externally-supplied diagnostics).
      //
      // It is load-bearing. Without it `setDiagnostics` takes its fallback path:
      // it appends the lint extensions via `appendConfig` in the SAME transaction
      // that carries the diagnostics — but a state field added by `appendConfig`
      // starts from `create()` and never sees that transaction's effects, so the
      // first batch is silently dropped by `lintState`. The gutter has its own
      // field (already installed by `lintGutter()` above), so the symptom is
      // gutter markers and a problem count with NO underline and no lint tooltip.
      // Installing the field up front means the very first dispatch renders.
      linter(null),
      // Language-service surfaces. Both read the open file through a ref, so the
      // extensions are built once and never rebuilt on a file switch.
      lspHover(() => filePathRef.current),
      lspGoToDefinition(() => filePathRef.current, (target) => {
        useWorkspaceStore.getState().openFileAtLine(target.path, target.line)
      }),
      Prec.highest(
        keymap.of([
          {
            key: 'F2',
            run: (view) => {
              renameRef.current(view)
              return true
            },
          },
          {
            // F12 → go to definition (VS Code's key). Falls through when the
            // language service has nothing, so it never eats the keystroke.
            key: 'F12',
            run: (view) => {
              const path = filePathRef.current
              if (!path) return false
              void jumpToDefinition(view, path, view.state.selection.main.head, (target) => {
                useWorkspaceStore.getState().openFileAtLine(target.path, target.line)
              })
              return true
            },
          },
          {
            // Tab jumps to the predicted next edit when a hint is showing;
            // otherwise return false so ghost-accept / default Tab still work.
            key: 'Tab',
            run: () => jumpRef.current(),
          },
          {
            // Escape dismisses the next-edit hint (when no inline-edit widget is
            // open to claim it); falls through otherwise.
            key: 'Escape',
            run: () => {
              if (editRef.current || !hintRef.current) return false
              setNextEditHint(null)
              return true
            },
          },
        ]),
      ),
      inlineEdit((view) => openRef.current(view)),
      ghostCompletion({
        getLanguage: () => langNameRef.current,
        isEnabled: () => ghostEnabledRef.current,
      }),
      ...(langExt ? [langExt] : []),
    ],
    [langExt]
  )

  const handleUpdate = (vu: ViewUpdate) => {
    // A manual edit invalidates a pending next-edit hint (its line may have moved).
    if (vu.docChanged && hintRef.current) setNextEditHint(null)
    if (!vu.selectionSet && !vu.docChanged) return
    const sel = vu.state.selection
    const main = sel.main
    const line = vu.state.doc.lineAt(main.head)
    let selected = 0
    for (const r of sel.ranges) selected += r.to - r.from
    setCursor({
      line: line.number,
      col: main.head - line.from + 1,
      selected,
      cursors: sel.ranges.length,
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      if (isDirty) onSave()
    }
  }

  if (filePath === null) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: 13,
          background: 'var(--bg-base)',
        }}
      >
        {t('file.selectToEdit')}
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--bg-base)',
        overflow: 'hidden',
      }}
      onKeyDown={handleKeyDown}
    >
      {/* Editor */}
      <div ref={editorWrapRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        <ReactCodeMirror
          value={content}
          theme="none"
          extensions={extensions}
          onChange={onChange}
          onUpdate={handleUpdate}
          onCreateEditor={(view) => {
            viewRef.current = view
          }}
          height="100%"
          style={{ height: '100%' }}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            dropCursor: true,
            allowMultipleSelections: true,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            rectangularSelection: true,
            crosshairCursor: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            highlightSelectionMatches: true,
            closeBracketsKeymap: true,
            searchKeymap: true,
          }}
        />
        {edit && (
          <InlineEditWidget
            edit={edit}
            inputRef={promptInputRef}
            files={mentionFiles}
            onInstruction={(v) => setEdit((e) => (e ? { ...e, instruction: v } : e))}
            onSubmit={submitInlineEdit}
            onAccept={acceptInlineEdit}
            onReject={rejectInlineEdit}
            onCancel={closeInlineEdit}
          />
        )}

        {nextEditHint && !edit && (
          <button
            onClick={() => jumpToNextEdit()}
            title={nextEditHint.instruction}
            style={{
              position: 'absolute',
              bottom: 12,
              right: 16,
              zIndex: 20,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              maxWidth: 320,
              padding: '6px 10px',
              fontSize: 11,
              color: 'var(--text-primary)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--accent)',
              borderRadius: 8,
              boxShadow: '0 6px 22px rgba(0,0,0,0.4)',
              cursor: 'pointer',
            }}
          >
            <kbd
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                padding: '1px 5px',
              }}
            >
              Tab
            </kbd>
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {nextEditHint.instruction}
            </span>
          </button>
        )}

        {rename && (
          <div
            style={{
              position: 'absolute',
              top: rename.top,
              left: rename.left,
              width: 240,
              zIndex: 20,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-active)',
              borderRadius: 8,
              boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
              padding: 8,
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                e.preventDefault()
                setRename(null)
                setTimeout(() => viewRef.current?.focus(), 0)
              }
            }}
          >
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--accent)', marginBottom: 6 }}>
              ✎ {t('file.rename.title')}
            </div>
            <input
              ref={renameInputRef}
              value={rename.value}
              disabled={rename.busy}
              onChange={(e) => setRename((r) => (r ? { ...r, value: e.target.value } : r))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (!rename.busy) submitRename()
                }
              }}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                borderRadius: 5,
                color: 'var(--text-primary)',
                padding: '6px 8px',
                fontSize: 12.5,
                fontFamily: 'var(--font-mono, monospace)',
                outline: 'none',
              }}
            />
            <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-dim)' }}>
              {rename.busy ? t('file.rename.searching') : t('file.rename.hint')}
            </div>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div
        style={{
          height: 24,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px',
          gap: 14,
          background: 'var(--bg-panel)',
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 11,
          color: 'var(--text-muted)',
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {/* Breadcrumb */}
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'var(--text-muted)',
          }}
          title={filePath}
        >
          {(relPath ?? fileName ?? '').split(/[\\/]/).join('  ›  ')}
        </span>

        {cursor.cursors > 1 ? (
          <span>{t('file.multiCursor', { n: String(cursor.cursors) })}</span>
        ) : (
          <span>
            {t('file.lnCol', { ln: String(cursor.line), col: String(cursor.col) })}
            {cursor.selected > 0 && ` (${t('file.selected', { n: String(cursor.selected) })})`}
          </span>
        )}

        <span>{langName ?? t('file.plainText')}</span>

        {/* Compiler status — live, no click needed. Absent for non-TS/JS files. */}
        {tsSummary && (
          <span
            title={t('file.lsp.tooltip')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color:
                tsSummary.errors > 0
                  ? '#e57373'
                  : tsSummary.warnings > 0
                    ? '#e0a44a'
                    : '#7cba7c',
            }}
          >
            {tsSummary.errors === 0 && tsSummary.warnings === 0
              ? `✓ ${t('file.lsp.clean')}`
              : `⨯ ${t('file.lsp.problems', {
                  e: String(tsSummary.errors),
                  w: String(tsSummary.warnings),
                })}`}
          </span>
        )}

        <button
          onClick={runDiagnostics}
          disabled={diagnosing}
          title={diagError ?? t('file.diag.tooltip')}
          style={{
            height: 18,
            padding: '0 8px',
            fontSize: 10.5,
            fontWeight: 600,
            border: '1px solid var(--border)',
            borderRadius: 3,
            cursor: diagnosing ? 'default' : 'pointer',
            background: 'transparent',
            color: diagError
              ? '#e57373'
              : diagCount === 0
                ? '#7cba7c'
                : diagCount && diagCount > 0
                  ? '#e0a44a'
                  : 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {diagnosing
            ? t('file.diag.analyzing')
            : diagError
              ? `⚠ ${t('file.diag.failed')}`
              : diagCount === 0
                ? `✓ ${t('file.diag.clean')}`
                : diagCount && diagCount > 0
                  ? `⚠ ${t('file.diag.count', { n: diagCount })}`
                  : `⚠ ${t('file.diag.label')}`}
        </button>

        <button
          onClick={() => setGhostTextEnabled(!ghostEnabled)}
          title={t('file.ghost.tooltip')}
          style={{
            height: 18,
            padding: '0 8px',
            fontSize: 10.5,
            fontWeight: 600,
            border: '1px solid var(--border)',
            borderRadius: 3,
            cursor: 'pointer',
            background: ghostEnabled ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
            color: ghostEnabled ? 'var(--accent)' : 'var(--text-dim)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {ghostEnabled ? '⊳' : '⊝'} {t('file.ghost.label')}
        </button>

        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setSnipOpen((o) => !o)}
            title={t('file.snip.tooltip')}
            style={{
              height: 18,
              padding: '0 8px',
              fontSize: 10.5,
              fontWeight: 600,
              border: '1px solid var(--border)',
              borderRadius: 3,
              cursor: 'pointer',
              background: snipOpen ? 'var(--bg-elevated)' : 'transparent',
              color: 'var(--text-secondary)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            ❏ {t('file.snip.label')}
            {snippets.length > 0 && <span style={{ opacity: 0.6 }}>({snippets.length})</span>}
          </button>
          {snipOpen && (
            <div
              style={{
                position: 'absolute',
                bottom: '120%',
                right: 0,
                width: 240,
                maxHeight: 260,
                overflowY: 'auto',
                zIndex: 30,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-active)',
                borderRadius: 6,
                boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
              }}
            >
              {snipName ? (
                <div style={{ padding: 8 }}>
                  <input
                    autoFocus
                    value={snipName.name}
                    onChange={(e) => setSnipName((s) => (s ? { ...s, name: e.target.value } : s))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitSaveSnippet()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setSnipName(null)
                      }
                    }}
                    placeholder={t('file.snip.namePlaceholder')}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                      color: 'var(--text-primary)',
                      padding: '6px 8px',
                      fontSize: 12,
                      outline: 'none',
                    }}
                  />
                </div>
              ) : (
                <>
                  <button
                    onClick={beginSaveSnippet}
                    disabled={cursor.selected === 0}
                    title={cursor.selected === 0 ? t('file.snip.selectFirst') : undefined}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '7px 10px',
                      border: 'none',
                      borderBottom: '1px solid var(--border-subtle)',
                      background: 'transparent',
                      color: cursor.selected === 0 ? 'var(--text-dim)' : 'var(--accent)',
                      cursor: cursor.selected === 0 ? 'default' : 'pointer',
                      fontSize: 11.5,
                      fontWeight: 600,
                    }}
                  >
                    ＋ {t('file.snip.save')}
                  </button>
                  {snippets.length === 0 ? (
                    <div style={{ padding: '10px', fontSize: 11, color: 'var(--text-muted)' }}>
                      {t('file.snip.empty')}
                    </div>
                  ) : (
                    snippets.map((s) => (
                      <div
                        key={s.id}
                        onClick={() => insertSnippet(s.body)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 10px',
                          cursor: 'pointer',
                          fontSize: 11.5,
                          color: 'var(--text-primary)',
                        }}
                      >
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.name}
                        </span>
                        {s.lang && <span style={{ fontSize: 9.5, opacity: 0.5 }}>{s.lang}</span>}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            removeSnippetStore(s.id)
                          }}
                          style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => {
            const view = viewRef.current
            if (view) {
              view.focus()
              openInlineEdit(view)
            }
          }}
          title={`${t('file.aiEdit.title')} (Ctrl+K)`}
          style={{
            height: 18,
            padding: '0 8px',
            fontSize: 10.5,
            fontWeight: 600,
            border: '1px solid var(--border)',
            borderRadius: 3,
            cursor: 'pointer',
            background: 'transparent',
            color: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          ✦ {t('file.aiEdit.title')}
        </button>

        {dirtyCount > 1 && (
          <button
            onClick={onSaveAll}
            style={{
              height: 18,
              padding: '0 8px',
              fontSize: 10.5,
              fontWeight: 600,
              border: '1px solid var(--border)',
              borderRadius: 3,
              cursor: 'pointer',
              background: 'transparent',
              color: 'var(--text-secondary)',
            }}
            title={t('file.saveAll', { n: dirtyCount })}
          >
            {t('file.saveAll', { n: dirtyCount })}
          </button>
        )}

        <button
          onClick={onSave}
          disabled={!isDirty}
          style={{
            height: 18,
            padding: '0 8px',
            fontSize: 10.5,
            fontWeight: 600,
            border: 'none',
            borderRadius: 3,
            cursor: isDirty ? 'pointer' : 'default',
            background: isDirty ? 'var(--accent)' : 'transparent',
            color: isDirty ? 'var(--accent-fg)' : 'var(--text-dim)',
            transition: 'background 150ms, color 150ms',
          }}
          title="Ctrl+S"
        >
          {isDirty ? t('common.save') : t('common.saved')}
        </button>
      </div>
    </div>
  )
}

interface InlineEditWidgetProps {
  edit: InlineEditState
  inputRef: React.RefObject<HTMLTextAreaElement>
  files: string[]
  onInstruction: (v: string) => void
  onSubmit: () => void
  onAccept: () => void
  onReject: () => void
  onCancel: () => void
}

// The floating Cmd/Ctrl+K prompt + accept/reject bar, positioned over the
// editor at the selection. Three phases: prompt (type an instruction),
// streaming (model is writing), preview (accept or reject the applied change).
function InlineEditWidget({
  edit,
  inputRef,
  files,
  onInstruction,
  onSubmit,
  onAccept,
  onReject,
  onCancel,
}: InlineEditWidgetProps) {
  const t = useT()
  const isInsert = edit.originalText.length === 0
  const errorText = edit.error === 'no-key' ? t('file.aiEdit.noKey') : edit.error

  // @-mention autocomplete state (prompt phase only).
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)

  const suggestions = useMemo(() => {
    if (!mention) return []
    return fuzzyRank(files, mention.query, (f) => f, 8)
  }, [mention, files])

  // Recompute the active mention from the textarea's caret after any change.
  const syncMention = (el: HTMLTextAreaElement) => {
    const m = activeMentionAt(el.value, el.selectionStart ?? el.value.length)
    setMention(m)
    setMentionIdx(0)
  }

  const pickSuggestion = (rel: string) => {
    if (!mention) return
    const el = inputRef.current
    const caret = el?.selectionStart ?? edit.instruction.length
    const next =
      edit.instruction.slice(0, mention.start) + '@' + rel + ' ' + edit.instruction.slice(caret)
    onInstruction(next)
    setMention(null)
    const newCaret = mention.start + rel.length + 2
    setTimeout(() => {
      if (el) {
        el.focus()
        el.setSelectionRange(newCaret, newCaret)
      }
    }, 0)
  }

  const menuOpen = mention !== null && suggestions.length > 0

  return (
    <div
      style={{
        position: 'absolute',
        top: edit.top,
        left: edit.left,
        width: 360,
        zIndex: 20,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-active)',
        borderRadius: 8,
        boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
        overflow: 'hidden',
        fontSize: 12,
      }}
      onKeyDown={(e) => {
        // Keep editor shortcuts (e.g. Ctrl+S) from firing under the widget.
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          edit.phase === 'preview' ? onReject() : onCancel()
        }
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid var(--border-subtle)',
          color: 'var(--accent)',
          fontWeight: 600,
          fontSize: 11,
          letterSpacing: 0.3,
        }}
      >
        <span style={{ fontSize: 13 }}>✦</span>
        {isInsert ? t('file.aiEdit.titleInsert') : t('file.aiEdit.title')}
      </div>

      {edit.phase === 'preview' ? (
        <>
          {/* Compact diff of what the edit changed (original → result). */}
          <pre
            style={{
              margin: 0,
              maxHeight: 180,
              overflow: 'auto',
              padding: '6px 10px',
              borderBottom: '1px solid var(--border-subtle)',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 11,
              lineHeight: 1.5,
              tabSize: 2,
            }}
          >
            {renderDiffRows(lineDiff(edit.originalText, edit.newText ?? ''))}
          </pre>
          {/* Accept / reject bar */}
          <div style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onAccept}
            style={{
              flex: 1,
              height: 28,
              border: 'none',
              borderRadius: 5,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 12,
              background: 'var(--accent)',
              color: 'var(--accent-fg)',
            }}
          >
            ✓ {t('file.aiEdit.accept')}
          </button>
          <button
            onClick={onReject}
            style={{
              flex: 1,
              height: 28,
              border: '1px solid var(--border)',
              borderRadius: 5,
              cursor: 'pointer',
              fontSize: 12,
              background: 'transparent',
              color: 'var(--text-secondary)',
            }}
          >
            ✕ {t('file.aiEdit.reject')}
          </button>
          <button
            onClick={onSubmit}
            title={t('file.aiEdit.regenerate')}
            style={{
              height: 28,
              padding: '0 10px',
              border: '1px solid var(--border)',
              borderRadius: 5,
              cursor: 'pointer',
              fontSize: 12,
              background: 'transparent',
              color: 'var(--text-secondary)',
            }}
          >
            ↻
          </button>
          </div>
        </>
      ) : (
        <div style={{ padding: 8, position: 'relative' }}>
          <textarea
            ref={inputRef}
            value={edit.instruction}
            disabled={edit.phase === 'streaming'}
            onChange={(e) => {
              onInstruction(e.target.value)
              syncMention(e.target)
            }}
            onClick={(e) => syncMention(e.currentTarget)}
            onKeyUp={(e) => {
              // Arrow/click navigation can move the caret in/out of a mention.
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
                syncMention(e.currentTarget)
            }}
            onKeyDown={(e) => {
              if (menuOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIdx((i) => (i + 1) % suggestions.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIdx((i) => (i - 1 + suggestions.length) % suggestions.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickSuggestion(suggestions[mentionIdx])
                  return
                }
                if (e.key === 'Escape') {
                  // Close just the autocomplete, not the whole widget.
                  e.preventDefault()
                  e.stopPropagation()
                  setMention(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (edit.phase !== 'streaming') onSubmit()
              }
            }}
            placeholder={isInsert ? t('file.aiEdit.placeholderInsert') : t('file.aiEdit.placeholder')}
            rows={2}
            style={{
              width: '100%',
              resize: 'none',
              boxSizing: 'border-box',
              background: 'var(--bg-base)',
              border: '1px solid var(--border)',
              borderRadius: 5,
              color: 'var(--text-primary)',
              padding: '6px 8px',
              fontSize: 12,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />

          {menuOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 8,
                right: 8,
                marginTop: -2,
                zIndex: 30,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-active)',
                borderRadius: 6,
                boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
                overflow: 'hidden',
                maxHeight: 200,
                overflowY: 'auto',
              }}
            >
              {suggestions.map((f, i) => {
                const base = f.slice(f.lastIndexOf('/') + 1)
                const dir = f.slice(0, f.length - base.length)
                return (
                  <div
                    key={f}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pickSuggestion(f)
                    }}
                    onMouseEnter={() => setMentionIdx(i)}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 6,
                      padding: '5px 9px',
                      cursor: 'pointer',
                      fontSize: 11.5,
                      background: i === mentionIdx ? 'var(--accent)' : 'transparent',
                      color: i === mentionIdx ? 'var(--accent-fg)' : 'var(--text-primary)',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{base}</span>
                    <span
                      style={{
                        fontSize: 10.5,
                        opacity: 0.7,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {dir}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {edit.phase === 'streaming' && edit.draft && (
            <pre
              style={{
                margin: '8px 0 0',
                maxHeight: 140,
                overflow: 'auto',
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 5,
                padding: '6px 8px',
                fontSize: 11,
                fontFamily: 'var(--font-mono, monospace)',
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {edit.draft}
            </pre>
          )}

          {errorText && (
            <div style={{ marginTop: 6, color: '#e57373', fontSize: 11 }}>{errorText}</div>
          )}

          <div
            style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ color: 'var(--text-dim)', fontSize: 10.5 }}>
              {edit.phase === 'streaming' ? t('file.aiEdit.generating') : t('file.aiEdit.hint')}
            </span>
            <button
              onClick={onSubmit}
              disabled={edit.phase === 'streaming' || !edit.instruction.trim()}
              style={{
                height: 26,
                padding: '0 12px',
                border: 'none',
                borderRadius: 5,
                fontWeight: 600,
                fontSize: 12,
                cursor:
                  edit.phase === 'streaming' || !edit.instruction.trim() ? 'default' : 'pointer',
                background:
                  edit.phase === 'streaming' || !edit.instruction.trim()
                    ? 'var(--bg-panel)'
                    : 'var(--accent)',
                color:
                  edit.phase === 'streaming' || !edit.instruction.trim()
                    ? 'var(--text-dim)'
                    : 'var(--accent-fg)',
              }}
            >
              {edit.phase === 'streaming' ? t('file.aiEdit.generating') : t('file.aiEdit.generate')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
