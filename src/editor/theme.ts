// CodeMirror theme for the built-in code editor.
//
// SwarmMind themes are applied at runtime as CSS custom properties (see
// appearance.ts), so this theme references vars instead of literal colours —
// the editor re-skins instantly on a theme switch, including the light Paper
// theme. Syntax token colours reuse the `--term-*` ANSI palette, which every
// theme already keeps legible against its own background (light themes ship a
// darker palette), so highlighting stays theme-accurate without a per-theme
// editor palette.

import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

const chrome = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg-base)',
    color: 'var(--text-primary)',
    fontSize: 'var(--editor-font-size, 13px)',
    height: '100%',
    WebkitFontSmoothing: 'antialiased',
    textRendering: 'optimizeLegibility',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-editor)',
    fontFeatureSettings: "'liga' 1, 'calt' 1",
    fontVariantLigatures: 'contextual',
    lineHeight: '1.65',
    letterSpacing: '0.01em',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    paddingTop: '8px',
    paddingBottom: '40vh', // scroll past end, like VS Code
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    {
      backgroundColor: 'var(--accent-subtle)',
    },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--overlay-active)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--overlay-hover)',
  },
  // Selection sits in a layer *behind* the active-line background — without
  // this the active-line wash hides the selection on that line.
  '&.cm-focused .cm-activeLine': {
    backgroundColor: 'transparent',
    outline: '1px solid var(--border-subtle)',
    outlineOffset: '-1px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-base)',
    color: 'var(--text-dim)',
    border: 'none',
    borderRight: '1px solid var(--border-subtle)',
    paddingRight: '2px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '40px',
    padding: '0 8px 0 12px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
  },
  '.cm-foldGutter .cm-gutterElement': {
    color: 'var(--text-dim)',
    cursor: 'pointer',
  },
  '.cm-foldGutter .cm-gutterElement:hover': {
    color: 'var(--text-secondary)',
  },
  '.cm-foldPlaceholder': {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    color: 'var(--text-muted)',
    borderRadius: '3px',
    padding: '0 6px',
    margin: '0 2px',
  },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'transparent',
    outline: '1px solid var(--border-active)',
    borderRadius: '2px',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--accent-subtle)',
    outline: '1px solid var(--accent-glow)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--accent-glow)',
  },
  // Panels (the Ctrl-F search bar)
  '.cm-panels': {
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--text-primary)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': {
    padding: '6px 8px',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
  },
  '.cm-panel.cm-search input': {
    background: 'var(--bg-input)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text-primary)',
    outline: 'none',
    padding: '3px 6px',
  },
  '.cm-panel.cm-search input:focus': {
    borderColor: 'var(--accent)',
  },
  '.cm-panel.cm-search button': {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    backgroundImage: 'none',
  },
  '.cm-panel.cm-search button:hover': {
    background: 'var(--bg-elevated-2)',
    color: 'var(--text-primary)',
  },
  '.cm-panel.cm-search label': {
    color: 'var(--text-secondary)',
    fontSize: '11px',
  },
  '.cm-panel.cm-search button[name="close"]': {
    color: 'var(--text-muted)',
    background: 'transparent',
    border: 'none',
  },
  // Tooltips + autocomplete dropdown
  '.cm-tooltip': {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    color: 'var(--text-primary)',
    boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-editor)',
    fontSize: '12.5px',
    maxHeight: '240px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '3px 8px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--accent-subtle)',
    color: 'var(--text-primary)',
  },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    color: 'var(--accent)',
    fontWeight: '600',
  },
  '.cm-completionIcon': {
    color: 'var(--text-muted)',
  },
})

// Token colours via the `--syn-*` palette published by applyAppearance —
// VS Code Dark+ roles by default, the Light+ palette on light themes. Kept
// separate from the terminal's ANSI palette so greyscale themes still get
// colourful code.
const highlight = HighlightStyle.define([
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--syn-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword],
    color: 'var(--syn-keyword)',
  },
  { tag: [t.string, t.docString, t.character, t.attributeValue], color: 'var(--syn-string)' },
  { tag: [t.regexp, t.escape, t.special(t.string)], color: 'var(--syn-regexp)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--syn-number)' },
  { tag: [t.bool, t.null, t.atom, t.constant(t.variableName)], color: 'var(--syn-atom)' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
    color: 'var(--syn-function)',
  },
  { tag: [t.typeName, t.className, t.namespace, t.annotation], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: [t.definition(t.variableName)], color: 'var(--syn-property)' },
  { tag: [t.variableName], color: 'var(--text-primary)' },
  { tag: [t.self, t.special(t.variableName)], color: 'var(--syn-atom)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: 'var(--text-secondary)' },
  { tag: [t.tagName], color: 'var(--syn-tag)' },
  { tag: [t.meta, t.processingInstruction, t.documentMeta], color: 'var(--text-muted)' },
  { tag: [t.labelName], color: 'var(--syn-keyword)' },
  { tag: t.heading, color: 'var(--syn-tag)', fontWeight: 'bold' },
  { tag: [t.link, t.url], color: 'var(--syn-property)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: 'var(--syn-invalid)' },
  { tag: [t.inserted], color: 'var(--syn-comment)' },
  { tag: [t.deleted], color: 'var(--syn-invalid)' },
  { tag: [t.changed], color: 'var(--syn-function)' },
])

export const editorTheme: Extension = [chrome, syntaxHighlighting(highlight)]
