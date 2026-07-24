import { ipcMain, shell } from 'electron'
import { readdir, readFile, writeFile, mkdir, rename, chmod, stat, cp, rm } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, extname, dirname, resolve, sep, basename } from 'path'
import { getCurrentRootPath } from './workspace'
import { isValidEntryName, isInside, samePathish, nextAvailableName } from '../lib/fsOps'
import { parseImageDataUrl, MAX_CAPTURE_BYTES } from '../lib/canvasCapture'

export interface FsEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  ext: string  // lowercase extension without dot, e.g. 'ts', '' for dirs
}

// Directories never worth indexing for @-mentions — vendored deps, VCS, build
// output, caches. Keeps the index relevant and the walk fast.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build', 'target',
  '.next', '.nuxt', '.cache', '.turbo', 'coverage', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', 'vendor', '.swarmmind',
])

// Collect workspace-relative file paths (POSIX slashes) under rootPath, skipping
// noise dirs and dotfiles (except .env), bounded by `max` and depth. Shared by
// the @-mention index and the codebase search.
async function walkFiles(rootPath: string, max: number): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= max || depth > 12) return
    let entries: import('fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= max) return
      if (e.name.startsWith('.') && e.name !== '.env') continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(join(dir, e.name), depth + 1)
      } else if (e.isFile()) {
        out.push(join(dir, e.name).slice(rootPath.length + 1).replace(/\\/g, '/'))
      }
    }
  }
  await walk(rootPath, 0)
  return out
}

export interface CodeMatch { path: string; line: number; text: string }

// ── Destructive-op containment ──────────────────────────────────────────────
// rename / move / copy / create / trash / chmod mutate the user's disk, so
// unlike the read handlers they are confined to the open workspace. Everything
// is resolved to an absolute real path first, then checked to be *strictly
// inside* the root — so `..` traversal, and the root directory itself, are both
// rejected. Without this an accidental (or agent-driven) call could rename or
// trash anything the user account can reach.
//
// `allowRoot` exists only for *container* arguments (the directory a new file
// or a paste lands in): the workspace root is a legitimate place to create
// things, but never a legitimate thing to move, rename or delete. The child
// path that results is always re-checked without it.
function assertInsideWorkspace(target: string, opts: { allowRoot?: boolean } = {}): string {
  const root = getCurrentRootPath()
  if (!root) throw new Error('No workspace is open')
  const abs = resolve(target)
  const rootAbs = resolve(root)
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  // Case-insensitive on Windows/macOS; the compare mirrors the OS's own rules
  // loosely enough to stay a guard rather than a correctness dependency.
  const ci = process.platform !== 'linux'
  const cmp = ci
    ? (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase())
    : (a: string, b: string) => a.startsWith(b)
  const isRoot = ci ? abs.toLowerCase() === rootAbs.toLowerCase() : abs === rootAbs
  if (!(opts.allowRoot && isRoot) && !cmp(abs, prefix)) {
    throw new Error('Path is outside the workspace')
  }
  // Never touch SwarmMind's own per-workspace state directory.
  const rel = isRoot ? '' : abs.slice(prefix.length)
  if (rel === '.swarmmind' || rel.startsWith('.swarmmind' + sep)) {
    throw new Error('Path is inside .swarmmind')
  }
  return abs
}

/** Path comparisons follow the platform's own case rules (see above). */
const CASE_INSENSITIVE_FS = process.platform !== 'linux'
const IS_WINDOWS = process.platform === 'win32'

/** Reject a name that can't be a single directory entry, with a real reason. */
function checkName(name: string): string | null {
  if (!name.trim()) return 'Name cannot be empty'
  if (/[\\/]/.test(name)) return 'Name cannot contain a path separator'
  if (!isValidEntryName(name, { windows: IS_WINDOWS })) return `“${name}” is not a valid file name`
  return null
}

/**
 * Resolve a destination directory and the final path an entry lands at inside
 * it, applying the shared move/copy guards: the destination must be an existing
 * directory in the workspace, and must not be the source itself or anything
 * beneath it (moving a folder into its own subtree orphans the whole subtree).
 */
async function resolveDestination(
  fromPath: string,
  destDir: string
): Promise<{ from: string; dir: string; name: string } | { error: string }> {
  const from = assertInsideWorkspace(fromPath)
  const dir = assertInsideWorkspace(destDir, { allowRoot: true })
  if (!existsSync(from)) return { error: 'Source no longer exists' }
  const dirStat = statSync(dir, { throwIfNoEntry: false })
  if (!dirStat?.isDirectory()) return { error: 'Destination is not a folder' }
  if (samePathish(from, dir, CASE_INSENSITIVE_FS)) return { error: 'Cannot place a folder inside itself' }
  if (isInside(from, dir, CASE_INSENSITIVE_FS)) return { error: 'Cannot place a folder inside itself' }
  return { from, dir, name: basename(from) }
}

/** Names already present in a directory — the input to collision-free naming. */
async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

export interface FsStat {
  size: number
  mtimeMs: number
  isDir: boolean
  mode: number      // full st_mode
  octal: string     // permission bits as e.g. '644'
  readonly: boolean // owner-write bit clear (the only bit Windows tracks)
}

export function registerFsHandlers(): void {
  // List directory contents — dirs first, then files, both alphabetical
  // Hidden entries (starting with '.') are included but flagged
  ipcMain.handle('fs:listDir', async (_e, dirPath: string): Promise<FsEntry[]> => {
    if (!existsSync(dirPath)) return []
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      const result: FsEntry[] = entries
        .filter(e => e.isFile() || e.isDirectory())
        .map((e): FsEntry => ({
          name: e.name,
          path: join(dirPath, e.name),
          type: e.isDirectory() ? 'dir' : 'file',
          ext: e.isDirectory() ? '' : extname(e.name).slice(1).toLowerCase(),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      return result
    } catch {
      return []
    }
  })

  // Bounded recursive file index for @-mention pickers (broadcast bar, prompts).
  // Returns workspace-relative file paths (POSIX slashes), skipping heavy/noise
  // dirs and capping the count so a huge repo can't stall the UI. Best-effort:
  // unreadable dirs are silently skipped.
  ipcMain.handle('fs:listFiles', async (_e, rootPath: string, max = 4000): Promise<string[]> => {
    if (!existsSync(rootPath)) return []
    return walkFiles(rootPath, max)
  })

  // Codebase content search ("grep") for the SwarmAgent. Walks the same indexed
  // files, reads text files (skips binaries and >512KB), and returns up to
  // `maxMatches` line hits for a case-insensitive substring. Optional `glob` is
  // a simple path-substring filter (e.g. ".tsx", "src/components"). Bounded so a
  // huge repo can't hang the call.
  ipcMain.handle('fs:searchFiles', async (_e, rootPath: string, query: string, glob = '', maxMatches = 60): Promise<CodeMatch[]> => {
    if (!existsSync(rootPath) || !query.trim()) return []
    const needle = query.toLowerCase()
    const globLc = glob.toLowerCase()
    const files = await walkFiles(rootPath, 6000)
    const matches: CodeMatch[] = []
    for (const rel of files) {
      if (matches.length >= maxMatches) break
      if (globLc && !rel.toLowerCase().includes(globLc)) continue
      const abs = join(rootPath, rel)
      try {
        const stat = statSync(abs, { throwIfNoEntry: false })
        if (!stat || stat.size > 512 * 1024) continue
        const buf = await readFile(abs)
        if (buf.includes(0)) continue // crude binary guard (NUL byte)
        const lines = buf.toString('utf-8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
            if (matches.length >= maxMatches) break
          }
        }
      } catch { /* unreadable — skip */ }
    }
    return matches
  })

  // Cheap file-existence probe (regular files only). Used by the terminal's
  // path-link provider to validate candidates before underlining them.
  ipcMain.handle('fs:exists', async (_e, filePath: string): Promise<boolean> => {
    try {
      const stat = statSync(filePath, { throwIfNoEntry: false })
      return !!stat && stat.isFile()
    } catch {
      return false
    }
  })

  // Read a text file (max 5MB)
  ipcMain.handle('fs:readFile', async (_e, filePath: string): Promise<string> => {
    const stat = statSync(filePath, { throwIfNoEntry: false })
    if (!stat || !stat.isFile() || stat.size > 5 * 1024 * 1024) {
      throw new Error('File not found or too large')
    }
    const buf = await readFile(filePath)
    return buf.toString('utf-8')
  })

  // Write a text file, creating parent directories as needed (so the Composer
  // can create new files in not-yet-existing folders).
  ipcMain.handle('fs:writeFile', async (_e, filePath: string, content: string): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf-8')
  })

  // ── Mutating file operations (editor context menu) ────────────────────────
  // All three are workspace-confined via assertInsideWorkspace and return a
  // {ok} / {error} shape rather than throwing across IPC, so the renderer can
  // show the real reason (EACCES, ENOTEMPTY, name collision) in the UI.

  // Stat a path — powers the permissions dialog and the rename pre-checks.
  ipcMain.handle('fs:stat', async (_e, filePath: string): Promise<FsStat | null> => {
    try {
      const s = await stat(filePath)
      return {
        size: s.size,
        mtimeMs: s.mtimeMs,
        isDir: s.isDirectory(),
        mode: s.mode,
        octal: (s.mode & 0o777).toString(8).padStart(3, '0'),
        readonly: (s.mode & 0o200) === 0,
      }
    } catch {
      return null
    }
  })

  // Rename a file/folder in place. Refuses to clobber an existing target —
  // fs.rename would silently overwrite a file otherwise.
  ipcMain.handle('fs:rename', async (_e, fromPath: string, toName: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    try {
      const from = assertInsideWorkspace(fromPath)
      // `toName` is a bare name, not a path — separators are rejected so a
      // rename can't walk out of the containing directory. Moving between
      // directories is fs:move's job.
      const bad = checkName(toName)
      if (bad) return { ok: false, error: bad }
      const to = assertInsideWorkspace(join(dirname(from), toName))
      if (from === to) return { ok: true, path: to }
      // A case-only rename ("Foo.ts" → "foo.ts") is a real, common operation
      // that existsSync would reject on Windows/macOS, where the old and new
      // names are the same file. rename() handles it fine.
      const caseOnlyChange = CASE_INSENSITIVE_FS && from.toLowerCase() === to.toLowerCase()
      if (!caseOnlyChange && existsSync(to)) {
        return { ok: false, error: 'A file with that name already exists' }
      }
      await rename(from, to)
      return { ok: true, path: to }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Create an empty file or a folder inside `dirPath`. The workspace root is a
  // valid container here (allowRoot), unlike for the destructive ops.
  ipcMain.handle('fs:create', async (_e, dirPath: string, name: string, kind: 'file' | 'dir'): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    try {
      const dir = assertInsideWorkspace(dirPath, { allowRoot: true })
      const bad = checkName(name)
      if (bad) return { ok: false, error: bad }
      const target = assertInsideWorkspace(join(dir, name))
      if (existsSync(target)) return { ok: false, error: 'A file with that name already exists' }
      if (kind === 'dir') {
        await mkdir(target, { recursive: true })
      } else {
        await mkdir(dirname(target), { recursive: true })
        // 'wx' fails rather than truncating if something appeared in between.
        await writeFile(target, '', { encoding: 'utf-8', flag: 'wx' })
      }
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Move a file/folder into another folder (drag-and-drop, cut+paste).
  // `overwrite: false` (the default) picks a free "copy"-style name instead of
  // clobbering; the renderer sets it true only after the user confirms.
  ipcMain.handle('fs:move', async (_e, fromPath: string, destDir: string, overwrite = false): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    try {
      const resolved = await resolveDestination(fromPath, destDir)
      if ('error' in resolved) return { ok: false, error: resolved.error }
      const { from, dir, name } = resolved
      if (samePathish(dirname(from), dir, CASE_INSENSITIVE_FS)) {
        return { ok: true, path: from } // already there — a no-op, not an error
      }
      let target = assertInsideWorkspace(join(dir, name))
      if (existsSync(target)) {
        if (!overwrite) {
          target = assertInsideWorkspace(join(dir, nextAvailableName(name, await namesIn(dir), { caseInsensitive: CASE_INSENSITIVE_FS })))
        } else {
          await rm(target, { recursive: true, force: true })
        }
      }
      try {
        await rename(from, target)
      } catch (err) {
        // Cross-device (a junction/symlink/mount pointing outside the volume)
        // — rename can't span filesystems, so fall back to copy-then-delete.
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        await cp(from, target, { recursive: true, force: true })
        await rm(from, { recursive: true, force: true })
      }
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Copy a file/folder into a folder (copy+paste, duplicate). Recursive for
  // directories. Never overwrites: a colliding name becomes "x copy.ts".
  ipcMain.handle('fs:copy', async (_e, fromPath: string, destDir: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    try {
      const resolved = await resolveDestination(fromPath, destDir)
      if ('error' in resolved) return { ok: false, error: resolved.error }
      const { from, dir, name } = resolved
      const finalName = nextAvailableName(name, await namesIn(dir), { caseInsensitive: CASE_INSENSITIVE_FS })
      const target = assertInsideWorkspace(join(dir, finalName))
      await cp(from, target, { recursive: true, errorOnExist: true, force: false })
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Import files dragged in from the OS file manager. The *sources* are outside
  // the workspace by definition (that's the point), so they are not containment-
  // checked — the user physically dragged them — but the destination still is,
  // and the batch is capped so a dropped 10k-file folder can't wedge the app.
  ipcMain.handle('fs:import', async (_e, sources: string[], destDir: string): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> => {
    try {
      const dir = assertInsideWorkspace(destDir, { allowRoot: true })
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        return { ok: false, error: 'Destination is not a folder' }
      }
      if (!Array.isArray(sources) || !sources.length) return { ok: false, error: 'Nothing to import' }
      if (sources.length > 200) return { ok: false, error: 'Too many items (max 200)' }
      const written: string[] = []
      for (const src of sources) {
        const from = resolve(src)
        if (!existsSync(from)) continue
        // Dropping a folder onto something inside itself would recurse forever.
        if (samePathish(from, dir, CASE_INSENSITIVE_FS) || isInside(from, dir, CASE_INSENSITIVE_FS)) {
          return { ok: false, error: 'Cannot import a folder into itself' }
        }
        const finalName = nextAvailableName(basename(from), await namesIn(dir), { caseInsensitive: CASE_INSENSITIVE_FS })
        const target = assertInsideWorkspace(join(dir, finalName))
        await cp(from, target, { recursive: true, errorOnExist: true, force: false })
        written.push(target)
      }
      return { ok: true, paths: written }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Duplicate in place — copy into the entry's own parent under a free name.
  ipcMain.handle('fs:duplicate', async (_e, filePath: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    try {
      const from = assertInsideWorkspace(filePath)
      if (!existsSync(from)) return { ok: false, error: 'Source no longer exists' }
      const dir = dirname(from)
      const finalName = nextAvailableName(basename(from), await namesIn(dir), { caseInsensitive: CASE_INSENSITIVE_FS })
      const target = assertInsideWorkspace(join(dir, finalName))
      await cp(from, target, { recursive: true, errorOnExist: true, force: false })
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Delete a file/folder by moving it to the OS trash — recoverable, unlike
  // rm -rf. Works for directories too (trashItem takes the whole subtree).
  ipcMain.handle('fs:trash', async (_e, filePath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const abs = assertInsideWorkspace(filePath)
      if (!existsSync(abs)) return { ok: false, error: 'Path no longer exists' }
      await shell.trashItem(abs)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Change permission bits. NOTE: on Windows only the read-only flag is real —
  // Node maps the owner-write bit onto it and ignores the rest — so the UI
  // presents a read-only toggle there and the full octal grid elsewhere.
  ipcMain.handle('fs:chmod', async (_e, filePath: string, mode: number): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const abs = assertInsideWorkspace(filePath)
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
        return { ok: false, error: 'Invalid mode' }
      }
      await chmod(abs, mode)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Reveal a path in the OS file manager (Explorer / Finder).
  ipcMain.handle('fs:reveal', async (_e, filePath: string): Promise<void> => {
    try { shell.showItemInFolder(resolve(filePath)) } catch { /* best effort */ }
  })

  // Open a path with the OS default application ("Open with system editor").
  // Confined to the workspace: shell.openPath hands the file to whatever the
  // OS has registered, so this is the one read-ish call that deserves the same
  // containment as the mutating ones.
  ipcMain.handle('fs:openPath', async (_e, filePath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const abs = assertInsideWorkspace(filePath)
      const err = await shell.openPath(abs)
      return err ? { ok: false, error: err } : { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Save a Canvas screenshot capture (webview capturePage + baked annotations)
  // as a PNG/JPEG under the workspace's own state dir, returning a repo-relative
  // path the handoff prompt can hand to an agent to read. Writes straight into
  // .swarmmind (SwarmMind's own directory, like scrollback/worktrees) rather
  // than through the user-op guard, which deliberately forbids .swarmmind — this
  // is an internal artifact, not a user file operation.
  ipcMain.handle('canvas:saveCapture', async (_e, dataUrl: string): Promise<{ ok: true; path: string; rel: string } | { ok: false; error: string }> => {
    try {
      const root = getCurrentRootPath()
      if (!root) return { ok: false, error: 'No workspace is open' }
      const parsed = parseImageDataUrl(dataUrl)
      if (!parsed) return { ok: false, error: 'Unsupported image data' }
      const buf = Buffer.from(parsed.base64, 'base64')
      if (buf.length === 0) return { ok: false, error: 'Empty capture' }
      if (buf.length > MAX_CAPTURE_BYTES) return { ok: false, error: 'Capture too large' }
      const dir = join(root, '.swarmmind', 'canvas-captures')
      await mkdir(dir, { recursive: true })
      const name = `capture-${Date.now()}.${parsed.ext}`
      await writeFile(join(dir, name), buf)
      return { ok: true, path: join(dir, name), rel: `.swarmmind/canvas-captures/${name}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Read an image file as a base64 data URL plus metadata (max 25MB)
  ipcMain.handle('fs:readImage', async (_e, filePath: string): Promise<ImageData> => {
    const stat = statSync(filePath, { throwIfNoEntry: false })
    if (!stat || !stat.isFile() || stat.size > 25 * 1024 * 1024) {
      throw new Error('Image not found or too large')
    }
    const mime = imageMime(extname(filePath).slice(1).toLowerCase())
    if (!mime) throw new Error('Unsupported image type')
    const buf = await readFile(filePath)
    return {
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      mime,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  })
}

export interface ImageData {
  dataUrl: string
  mime: string
  size: number
  mtimeMs: number
}

function imageMime(ext: string): string | null {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'ico':
      return 'image/x-icon'
    case 'avif':
      return 'image/avif'
    default:
      return null
  }
}
