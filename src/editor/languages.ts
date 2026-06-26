// Language detection + lazy loading for the built-in code editor.
//
// `@codemirror/language-data` describes ~150 languages (PHP, Rust, Go, SQL,
// YAML, Markdown with nested code blocks, …) and dynamically imports each
// parser only when a matching file is first opened, so the renderer bundle
// stays small. A few filenames without useful extensions (Dockerfile, .env,
// shell rc files) are special-cased by name.

import { languages } from '@codemirror/language-data'
import { LanguageDescription } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

// Exact-filename → language-data name, for files matchFilename can't resolve.
const FILENAME_OVERRIDES: Record<string, string> = {
  dockerfile: 'Dockerfile',
  containerfile: 'Dockerfile', // Podman's Dockerfile equivalent
  makefile: 'Shell', // no make mode in language-data; shell is the closest fit
  '.env': 'Shell',
  '.env.local': 'Shell',
  '.env.development': 'Shell',
  '.env.production': 'Shell',
  '.bashrc': 'Shell',
  '.zshrc': 'Shell',
  '.profile': 'Shell',
  '.gitignore': 'Shell',
  '.gitattributes': 'Shell',
  '.dockerignore': 'Shell',
  '.npmrc': 'Shell',
  '.editorconfig': 'Properties files',
}

// Extension (lowercase, no dot) → language-data name, for common file types
// `matchFilename` doesn't recognise. We map to the closest available parser so
// the file still gets syntax highlighting and a sensible language label (which
// also feeds the AI edit/diagnose features). Markup-ish frameworks fall back to
// HTML; data/config files to their nearest structured format.
const EXTENSION_OVERRIDES: Record<string, string> = {
  svelte: 'HTML',
  astro: 'HTML',
  ipynb: 'JSON', // Jupyter notebooks are JSON on disk
  conf: 'Shell',
  dockerfile: 'Dockerfile',
  bashrc: 'Shell',
  zshrc: 'Shell',
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase()
}

export function detectLanguage(fileName: string): LanguageDescription | null {
  const byFilename = LanguageDescription.matchFilename(languages, fileName)
  if (byFilename) return byFilename
  const nameOverride = FILENAME_OVERRIDES[fileName.toLowerCase()]
  if (nameOverride) return LanguageDescription.matchLanguageName(languages, nameOverride, true)
  const extOverride = EXTENSION_OVERRIDES[extensionOf(fileName)]
  if (extOverride) return LanguageDescription.matchLanguageName(languages, extOverride, true)
  return null
}

/** Human-readable language name for the status bar ("TypeScript", "PHP", …). */
export function languageName(fileName: string): string | null {
  return detectLanguage(fileName)?.name ?? null
}

/** Resolve the (lazily imported) CodeMirror support extension for a file. */
export async function loadLanguage(fileName: string): Promise<Extension | null> {
  const desc = detectLanguage(fileName)
  if (!desc) return null
  return desc.load()
}
