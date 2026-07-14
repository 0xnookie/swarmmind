// TypeScript language service, running in a worker thread.
//
// WHY A WORKER: `ts.LanguageService` is synchronous, and building the initial
// program for a real project takes seconds. The main process pumps every PTY's
// output and all IPC, so doing this on it would freeze every terminal in the
// app. The service therefore lives here, off-thread, and talks to main over
// postMessage (electron/lsp/client.ts).
//
// WHY NOT AN EXTERNAL LANGUAGE SERVER: none to install, spawn, or keep alive —
// the `typescript` package we already build with *is* the engine. That covers
// TS/JS/TSX/JSX, which is what people vibecode in.
//
// The roots of each program are just the files the editor has open (the
// "overlay"). TS pulls in their whole import closure by itself, so we get
// cross-file types without ever enumerating the repo.

import { parentPort } from 'node:worker_threads'
import { statSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import ts from 'typescript'
import {
  applyTextEdits,
  chooseProject,
  displayPartsToText,
  flattenMessage,
  formatHover,
  isValidIdentifier,
  lineTextAt,
  normPath,
  severityOf,
  type ProjectCandidate,
  type SpanEdit,
} from '../lib/tsLsp'
import type { LspDefinition, LspDiagnostic, LspHover, LspReference, LspRenameResult, LspRequest, LspResponse } from './protocol'

if (!parentPort) throw new Error('lsp worker must be run as a worker thread')
const port = parentPort

// ── Documents ───────────────────────────────────────────────────────────────
// The editor's live buffer for each open file. An overlay entry always wins over
// the file on disk, so diagnostics reflect what the user is looking at — including
// unsaved edits.
type Doc = { content: string; version: number }
const overlay = new Map<string, Doc>() // normPath -> doc
const fileToConfig = new Map<string, string | null>() // normPath -> owning tsconfig

const isExternal = (f: string) => {
  const n = normPath(f)
  return n.includes('/node_modules/') || n.includes('/typescript/lib/')
}

// ── Projects ────────────────────────────────────────────────────────────────
// `roots` maps a normalized key -> the file name in its REAL case. TS echoes root
// names straight back in definition results, so seeding it with normalized keys
// would hand the editor a lowercased path — fine on Windows, broken on a
// case-sensitive filesystem.
type Project = { service: ts.LanguageService; options: ts.CompilerOptions; roots: Map<string, string>; dir: string }
const projects = new Map<string, Project>() // configPath ('' = default/no tsconfig) -> project

function parseConfig(configPath: string): { options: ts.CompilerOptions; fileNames: string[]; refs: string[] } {
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(configPath), undefined, configPath)
  const refs = (parsed.projectReferences ?? []).map((r) => {
    const p = resolvePath(dirname(configPath), r.path)
    return ts.sys.directoryExists(p) ? resolvePath(p, 'tsconfig.json') : p
  })
  return { options: parsed.options, fileNames: parsed.fileNames, refs }
}

/**
 * Which tsconfig owns this file? Resolved through project references, because a
 * solution-style root config (`{"files": [], "references": [...]}`) is closest on
 * disk but declares no files and no `jsx` — trusting it would flag every .tsx in
 * the repo as broken. Decision logic is the pure, unit-tested `chooseProject`.
 */
function configFor(file: string): string | null {
  const cached = fileToConfig.get(normPath(file))
  if (cached !== undefined) return cached

  let chosen: string | null = null
  try {
    const nearestPath = ts.findConfigFile(dirname(file), ts.sys.fileExists)
    if (nearestPath) {
      const near = parseConfig(nearestPath)
      const nearest: ProjectCandidate = { configPath: nearestPath, fileNames: near.fileNames }
      const referenced: ProjectCandidate[] = []
      for (const refPath of near.refs) {
        try {
          referenced.push({ configPath: refPath, fileNames: parseConfig(refPath).fileNames })
        } catch {
          /* a broken reference shouldn't sink the whole lookup */
        }
      }
      chosen = chooseProject(file, nearest, referenced)
    }
  } catch {
    chosen = null
  }
  fileToConfig.set(normPath(file), chosen)
  return chosen
}

/** Options for a file with no tsconfig at all — still gives real single-file types. */
function defaultOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    esModuleInterop: true,
    skipLibCheck: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  }
}

function projectFor(file: string): Project {
  const configPath = configFor(file)
  const key = configPath ?? ''
  const existing = projects.get(key)
  if (existing) {
    existing.roots.set(normPath(file), scriptName(file))
    return existing
  }

  let options: ts.CompilerOptions
  let dir: string
  // Ambient declarations MUST be program roots. Nothing imports them — they're
  // pulled in by being listed in the project — so a program rooted only at the
  // open file loses every global augmentation: `window.swarmmind` becomes
  // "Property 'swarmmind' does not exist on Window", `import logo from './x.png'`
  // becomes "Cannot find module". They're a handful of files, so this costs
  // nothing and is the difference between real diagnostics and a wall of lies.
  let ambient: string[] = []
  if (configPath) {
    try {
      const parsed = parseConfig(configPath)
      options = parsed.options
      dir = dirname(configPath)
      ambient = parsed.fileNames.filter((f) => /\.d\.ts$/i.test(f))
    } catch {
      options = defaultOptions()
      dir = dirname(file)
    }
  } else {
    options = defaultOptions()
    dir = dirname(file)
  }

  // Emit-related settings are meaningless for a language service and actively
  // harmful: `composite`/`incremental` make TS complain about files outside the
  // declared file list (TS6307) and try to write .tsbuildinfo.
  options = {
    ...options,
    noEmit: true,
    composite: false,
    declaration: false,
    declarationMap: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    skipLibCheck: true,
  }

  const roots = new Map<string, string>([[normPath(file), scriptName(file)]])
  for (const d of ambient) roots.set(normPath(d), scriptName(d))

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...roots.values()],
    getScriptVersion: (f) => {
      const doc = overlay.get(normPath(f))
      if (doc) return String(doc.version)
      // lib.d.ts and node_modules never change under us; stat'ing them on every
      // program update (thousands of files) would be the slow path.
      if (isExternal(f)) return '1'
      try {
        return String(statSync(f).mtimeMs)
      } catch {
        return '0'
      }
    },
    getScriptSnapshot: (f) => {
      const doc = overlay.get(normPath(f))
      if (doc) return ts.ScriptSnapshot.fromString(doc.content)
      const text = ts.sys.readFile(f)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => dir,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  }

  const project: Project = { service: ts.createLanguageService(host, ts.createDocumentRegistry()), options, roots, dir }
  projects.set(key, project)
  return project
}

/** TS wants the path exactly as it resolved it; our overlay keys are normalized. */
function scriptName(file: string): string {
  return file.replace(/\\/g, '/')
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * Point the service at the editor's live buffer, bumping the version so it
 * re-checks only what this file touches. Called at the head of every query, so a
 * request never depends on a prior message having landed.
 */
function applyDoc(file: string, content: string): void {
  const key = normPath(file)
  const prev = overlay.get(key)
  if (prev && prev.content === content) return // unchanged — keep the version, reuse the cached program
  overlay.set(key, { content, version: (prev?.version ?? 0) + 1 })
}

function diagnostics(file: string): LspDiagnostic[] {
  const { service } = projectFor(file)
  const name = scriptName(file)
  // Syntactic first: when a file doesn't parse, the semantic pass reports a
  // cascade of nonsense derived from the broken tree.
  const syntactic = service.getSyntacticDiagnostics(name)
  const raw: ts.Diagnostic[] = syntactic.length > 0 ? [...syntactic] : [...syntactic, ...service.getSemanticDiagnostics(name)]

  const out: LspDiagnostic[] = []
  for (const d of raw) {
    if (d.start === undefined || d.length === undefined) continue
    out.push({
      from: d.start,
      to: d.start + Math.max(d.length, 1),
      message: flattenMessage(d.messageText as string | { messageText: string }),
      severity: severityOf(d.category),
      code: typeof d.code === 'number' ? d.code : undefined,
    })
  }
  return out
}

function hover(file: string, offset: number): LspHover | null {
  const { service } = projectFor(file)
  const info = service.getQuickInfoAtPosition(scriptName(file), offset)
  if (!info) return null
  const markdown = formatHover(displayPartsToText(info.displayParts), displayPartsToText(info.documentation))
  if (!markdown) return null
  return { markdown, from: info.textSpan.start, to: info.textSpan.start + info.textSpan.length }
}

function definition(file: string, offset: number): LspDefinition | null {
  const project = projectFor(file)
  const defs = project.service.getDefinitionAtPosition(scriptName(file), offset)
  if (!defs || defs.length === 0) return null

  // Prefer a definition outside a .d.ts — jumping into a type declaration when a
  // real implementation exists is almost never what the user meant.
  const impl = defs.find((d) => !/\.d\.ts$/i.test(d.fileName)) ?? defs[0]
  const program = project.service.getProgram()
  const source = program?.getSourceFile(impl.fileName)
  if (!source) return null
  const pos = ts.getLineAndCharacterOfPosition(source, impl.textSpan.start)
  return { path: impl.fileName, line: pos.line + 1, col: pos.character + 1 }
}

/** The file's text exactly as the language service sees it (overlay wins). */
function serviceText(file: string): string | null {
  const doc = overlay.get(normPath(file))
  if (doc) return doc.content
  const text = ts.sys.readFile(file)
  return text === undefined ? null : text
}

const MAX_REFERENCES = 300

function references(file: string, offset: number): LspReference[] {
  const { service } = projectFor(file)
  // findReferences (not getReferencesAtPosition): its entries carry
  // `isDefinition`, which the flat variant dropped in TS 5.
  const symbols = service.findReferences(scriptName(file), offset)
  if (!symbols || symbols.length === 0) return []
  const refs = symbols.flatMap((s) => s.references)

  const out: LspReference[] = []
  // Cache each file's text once — a symbol with hundreds of usages would
  // otherwise re-read the same sources per hit.
  const texts = new Map<string, string | null>()
  for (const r of refs.slice(0, MAX_REFERENCES)) {
    if (isExternal(r.fileName)) continue // usages inside node_modules/lib.d.ts aren't actionable
    let text = texts.get(r.fileName)
    if (text === undefined) {
      text = serviceText(r.fileName)
      texts.set(r.fileName, text)
    }
    if (text === null) continue
    const before = text.slice(0, r.textSpan.start)
    const line = before.length - before.replace(/\n/g, '').length + 1
    const lineStart = before.lastIndexOf('\n') + 1
    out.push({
      path: r.fileName,
      line,
      col: r.textSpan.start - lineStart + 1,
      lineText: lineTextAt(text, r.textSpan.start),
      isDefinition: r.isDefinition ?? false,
      isWrite: r.isWriteAccess ?? false,
    })
  }
  return out
}

/**
 * Compiler-exact rename. Collects every rename location (with the prefix/suffix
 * text TS needs for shorthand properties, `export { x as y }`, etc.), applies
 * the spans per file against the service's own snapshots, and returns full new
 * file contents ready for the Composer's diff/checkpoint/apply pipeline.
 */
function rename(file: string, offset: number, newName: string): LspRenameResult {
  if (!isValidIdentifier(newName)) return { ok: false, error: 'invalid-name' }
  const { service } = projectFor(file)
  const name = scriptName(file)

  const info = service.getRenameInfo(name, offset, { allowRenameOfImportPath: false })
  if (!info.canRename) return { ok: false, error: info.localizedErrorMessage || 'cannot-rename' }

  // providePrefixAndSuffixTextForRename: FALSE — with it on, renaming an
  // imported symbol at a use site produces an import alias (`double as twice`)
  // instead of renaming the export: exactly not what this app's F2 ("rename
  // across files") promises. Propagation is safe here because the result is
  // never applied silently — it lands in the Composer's diff preview first.
  // We still honor any prefix/suffix TS emits (it may for other constructs).
  const locs = service.findRenameLocations(name, offset, false, false, {
    providePrefixAndSuffixTextForRename: false,
  })
  if (!locs || locs.length === 0) return { ok: false, error: 'no-locations' }

  const byFile = new Map<string, SpanEdit[]>()
  for (const loc of locs) {
    if (isExternal(loc.fileName)) return { ok: false, error: 'renames-external' } // touching node_modules is never right
    const edits = byFile.get(loc.fileName) ?? []
    edits.push({
      start: loc.textSpan.start,
      length: loc.textSpan.length,
      newText: (loc.prefixText ?? '') + newName + (loc.suffixText ?? ''),
    })
    byFile.set(loc.fileName, edits)
  }

  const files: { path: string; newContent: string; edits: number }[] = []
  for (const [fileName, edits] of byFile) {
    const text = serviceText(fileName)
    if (text === null) return { ok: false, error: `unreadable: ${fileName}` }
    const newContent = applyTextEdits(text, edits)
    if (newContent === null) return { ok: false, error: `overlapping-edits: ${fileName}` }
    files.push({ path: fileName, newContent, edits: edits.length })
  }
  return { ok: true, displayName: info.displayName, files }
}

// ── Message loop ────────────────────────────────────────────────────────────

port.on('message', (req: LspRequest) => {
  const reply = (res: Omit<LspResponse, 'id'>) => port.postMessage({ id: (req as { id?: number }).id ?? 0, ...res })

  try {
    switch (req.type) {
      case 'close': {
        const key = normPath(req.path)
        overlay.delete(key)
        // Closing the tab drops the file back to its on-disk contents. A .d.ts is
        // kept as a root regardless — it's ambient, so evicting it because the
        // user happened to close its tab would silently break globals everywhere.
        if (!/\.d\.ts$/i.test(key)) {
          for (const p of projects.values()) p.roots.delete(key)
        }
        reply({ ok: true, data: null })
        return
      }
      case 'diagnostics':
        applyDoc(req.path, req.content)
        reply({ ok: true, data: diagnostics(req.path) })
        return
      case 'hover':
        applyDoc(req.path, req.content)
        reply({ ok: true, data: hover(req.path, req.offset) })
        return
      case 'definition':
        applyDoc(req.path, req.content)
        reply({ ok: true, data: definition(req.path, req.offset) })
        return
      case 'references':
        applyDoc(req.path, req.content)
        reply({ ok: true, data: references(req.path, req.offset) })
        return
      case 'rename':
        applyDoc(req.path, req.content)
        reply({ ok: true, data: rename(req.path, req.offset, req.newName) })
        return
      default:
        reply({ ok: false, error: 'unknown-request' })
    }
  } catch (err) {
    // A language-service throw (malformed tsconfig, unreadable file, TS internal
    // error) must degrade to "no results" — never take the worker down and leave
    // the editor without diagnostics for the rest of the session.
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

port.postMessage({ id: 0, ok: true, data: 'ready' })
