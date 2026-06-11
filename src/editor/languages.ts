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
  makefile: 'Shell', // no make mode in language-data; shell is the closest fit
  '.env': 'Shell',
  '.bashrc': 'Shell',
  '.zshrc': 'Shell',
  '.gitignore': 'Shell',
  '.gitattributes': 'Shell',
  '.npmrc': 'Shell',
}

export function detectLanguage(fileName: string): LanguageDescription | null {
  const byFilename = LanguageDescription.matchFilename(languages, fileName)
  if (byFilename) return byFilename
  const override = FILENAME_OVERRIDES[fileName.toLowerCase()]
  if (override) return LanguageDescription.matchLanguageName(languages, override, true)
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
