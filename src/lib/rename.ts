// ── Compiler-exact rename → Composer plan (pure) ─────────────────────────────
//
// The LSP worker answers a rename with full new file contents (absolute paths,
// applied against its own snapshots). The Composer's apply pipeline wants
// workspace-relative forward-slash paths. This module is the bridge — pure, so
// tests/lib-units.mts can assert the path math (which is exactly the part that
// breaks on Windows: `D:\x` vs `d:/x`).

export interface RenamedFile {
  /** Absolute path, as the language service reports it. */
  path: string
  newContent: string
  edits: number
}

export interface RenamePlan {
  summary: string
  changes: { path: string; action: 'edit'; content: string }[]
}

/**
 * Workspace-relative forward-slash path, or null when the file lies outside the
 * root. Windows needs the case-insensitive prefix compare (TS reports `d:/…`
 * while Electron hands out `D:\…`), but the returned path keeps its real case.
 */
export function toWorkspaceRelative(rootPath: string, absPath: string): string | null {
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const abs = absPath.replace(/\\/g, '/')
  if (abs.toLowerCase().startsWith(root.toLowerCase() + '/')) return abs.slice(root.length + 1)
  return null
}

/**
 * Turn the worker's rename result into a pre-built Composer plan.
 *
 * Returns null when ANY touched file lies outside the workspace root: applying
 * only the in-root subset would leave a half-renamed codebase (worse than not
 * renaming), so the caller falls back to the model-mediated flow instead.
 */
export function buildRenamePlan(
  rootPath: string,
  oldName: string,
  newName: string,
  files: RenamedFile[],
): RenamePlan | null {
  if (files.length === 0) return null
  const changes: RenamePlan['changes'] = []
  let total = 0
  for (const f of files) {
    const rel = toWorkspaceRelative(rootPath, f.path)
    if (rel === null) return null
    changes.push({ path: rel, action: 'edit', content: f.newContent })
    total += f.edits
  }
  return {
    summary: `Rename ${oldName} → ${newName}: ${total} occurrence${total === 1 ? '' : 's'} across ${changes.length} file${changes.length === 1 ? '' : 's'} (compiler-exact, via the TypeScript language service).`,
    changes,
  }
}
