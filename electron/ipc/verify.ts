import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

// Constrained verify runner — the backend for the Composer's verify→fix loop
// (the safe core of "agent-mode iteration"). It runs ONLY one of the workspace's
// own declared npm scripts, never an arbitrary command:
//   • the requested script must exist in the workspace package.json `scripts`,
//   • and its name must match a strict charset (no shell metacharacters),
// so even a maliciously crafted cloned repo can't turn this into command
// execution. Output is captured and bounded; a long-running script is killed by
// a hard timeout. Mirrors git-manager.ts's safe execFile usage.

const RUN_TIMEOUT_MS = 180_000
const MAX_OUTPUT = 24_000 // chars kept per stream (tail) for the model summary

// Duplicated tiny guard (the pure src/ version is unit-tested; main can't import
// renderer paths). Must stay in sync with src/lib/verify.ts::isSafeScriptName.
function isSafeScriptName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && /^[A-Za-z0-9:_-]+$/.test(name)
}

async function readDeclaredScripts(rootPath: string): Promise<string[]> {
  try {
    const txt = await readFile(join(rootPath, 'package.json'), 'utf-8')
    const pkg = JSON.parse(txt) as { scripts?: Record<string, unknown> }
    if (!pkg.scripts || typeof pkg.scripts !== 'object') return []
    return Object.keys(pkg.scripts).filter((k) => typeof pkg.scripts![k] === 'string')
  } catch {
    return []
  }
}

const tail = (s: string) => (s.length > MAX_OUTPUT ? s.slice(s.length - MAX_OUTPUT) : s)

export function registerVerifyHandlers(): void {
  // List the workspace's runnable npm scripts so the renderer can offer a picker.
  ipcMain.handle('verify:scripts', async (_e, rootPath: string): Promise<string[]> => {
    if (!rootPath || !existsSync(rootPath)) return []
    return readDeclaredScripts(rootPath)
  })

  // Run `npm run <script>` in the workspace, returning {code, stdout, stderr}.
  // Refuses anything not on the package's own allowlist or with an unsafe name.
  ipcMain.handle(
    'verify:run',
    async (
      _e,
      rootPath: string,
      script: string,
    ): Promise<{ code: number; stdout: string; stderr: string; error?: string }> => {
      if (!rootPath || !existsSync(rootPath)) return { code: -1, stdout: '', stderr: '', error: 'no-workspace' }
      if (!isSafeScriptName(script)) return { code: -1, stdout: '', stderr: '', error: 'invalid-script' }
      const declared = await readDeclaredScripts(rootPath)
      if (!declared.includes(script)) return { code: -1, stdout: '', stderr: '', error: 'unknown-script' }

      // npm is `npm.cmd` on Windows, which Node can only spawn through a shell.
      // The script name is already allowlisted AND charset-validated above, so no
      // attacker-controlled metacharacters can reach the shell.
      const isWin = process.platform === 'win32'
      const cmd = isWin ? 'npm.cmd' : 'npm'

      return new Promise((resolve) => {
        execFile(
          cmd,
          ['run', script],
          { cwd: rootPath, timeout: RUN_TIMEOUT_MS, windowsHide: true, shell: isWin, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
            // execFile's err.code is the process exit code (number) for a normal
            // non-zero exit; a string code (e.g. 'ENOENT') means spawn failure.
            let code = 0
            if (e) code = typeof e.code === 'number' ? e.code : 1
            resolve({
              code,
              stdout: tail(stdout?.toString() ?? ''),
              stderr: tail(stderr?.toString() ?? ''),
              ...(e && typeof e.code !== 'number' ? { error: e.killed ? 'timeout' : String(e.code ?? 'spawn-failed') } : {}),
            })
          },
        )
      })
    },
  )
}
