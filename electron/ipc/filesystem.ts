import { ipcMain, shell } from 'electron'
import { readdir, readFile, writeFile, mkdir, rename, chmod, stat } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, extname, dirname, resolve, sep } from 'path'
import { getCurrentRootPath } from './workspace'

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
// rename / trash / chmod mutate the user's disk, so unlike the read handlers
// they are confined to the open workspace. Everything is resolved to an
// absolute real path first, then checked to be *strictly inside* the root — so
// `..` traversal, and the root directory itself, are both rejected. Without
// this an accidental (or agent-driven) call could rename or trash anything the
// user account can reach.
function assertInsideWorkspace(target: string): string {
  const root = getCurrentRootPath()
  if (!root) throw new Error('No workspace is open')
  const abs = resolve(target)
  const rootAbs = resolve(root)
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  // Case-insensitive on Windows/macOS; the compare mirrors the OS's own rules
  // loosely enough to stay a guard rather than a correctness dependency.
  const cmp = process.platform === 'linux'
    ? (a: string, b: string) => a.startsWith(b)
    : (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase())
  if (!cmp(abs, prefix)) throw new Error('Path is outside the workspace')
  // Never touch SwarmMind's own per-workspace state directory.
  const rel = abs.slice(prefix.length)
  if (rel === '.swarmmind' || rel.startsWith('.swarmmind' + sep)) {
    throw new Error('Path is inside .swarmmind')
  }
  return abs
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

  // Rename (or move) a file/folder within the workspace. Refuses to clobber an
  // existing target — fs.rename would silently overwrite a file otherwise.
  ipcMain.handle('fs:rename', async (_e, fromPath: string, toName: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    try {
      const from = assertInsideWorkspace(fromPath)
      // `toName` is a bare name, not a path — reject separators so a rename
      // can't walk out of the containing directory.
      if (!toName || /[\\/]/.test(toName) || toName === '.' || toName === '..') {
        return { ok: false, error: 'Invalid name' }
      }
      const to = assertInsideWorkspace(join(dirname(from), toName))
      if (from === to) return { ok: true, path: to }
      if (existsSync(to)) return { ok: false, error: 'A file with that name already exists' }
      await rename(from, to)
      return { ok: true, path: to }
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
