// Which external language server (if any) owns a file.
//
// The TypeScript path stays in-process — the `typescript` package is a
// dependency and `ts.LanguageService` in a worker is faster than any subprocess
// round trip. Everything else is served by whatever real language server the
// user already has installed. That's the trade this module encodes: SwarmMind
// bundles nothing and installs nothing, so Python/Rust/Go support costs a
// registry entry rather than a vendored server per language, and a machine
// without the binary degrades to "no results" instead of erroring.
//
// Pure and dependency-free — the registry and the lookup are asserted offline.

export interface ServerCommand {
  command: string
  args: string[]
}

export interface LspServerDef {
  /** Stable key: one running process per id, per workspace. */
  id: string
  /** Candidates tried in order; the first that spawns wins. */
  candidates: ServerCommand[]
  /** Lowercase file extensions, with the dot. */
  extensions: string[]
  /** LSP `languageId` for textDocument/didOpen. */
  languageId: string
}

// Deliberately small. Each entry is a server that speaks stdio LSP with no
// project configuration beyond a workspace root, which is the only kind that
// can be spawned automatically without surprising the user.
export const DEFAULT_SERVERS: LspServerDef[] = [
  {
    id: 'python',
    // Pyright first (fast, no plugin setup); python-lsp-server as the fallback
    // because it's what a lot of existing environments already have.
    candidates: [
      { command: 'pyright-langserver', args: ['--stdio'] },
      { command: 'pylsp', args: [] },
    ],
    extensions: ['.py', '.pyi'],
    languageId: 'python',
  },
  {
    id: 'rust',
    candidates: [{ command: 'rust-analyzer', args: [] }],
    extensions: ['.rs'],
    languageId: 'rust',
  },
  {
    id: 'go',
    candidates: [{ command: 'gopls', args: [] }],
    extensions: ['.go'],
    languageId: 'go',
  },
  {
    id: 'clangd',
    candidates: [{ command: 'clangd', args: [] }],
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'],
    languageId: 'cpp',
  },
]

export function extensionOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

export function serverForPath(path: string, servers: readonly LspServerDef[] = DEFAULT_SERVERS): LspServerDef | null {
  const ext = extensionOf(path)
  if (!ext) return null
  return servers.find(s => s.extensions.includes(ext)) ?? null
}

/**
 * Extra servers from the `lspServers` app setting, so a user can wire up a
 * language we don't ship a default for without a new release.
 *
 * Parsed defensively and per entry: one malformed row in hand-edited JSON must
 * not discard the rows around it, and a bad setting must never prevent the
 * built-in servers from working.
 */
export function parseExtraServers(raw: string | null | undefined): LspServerDef[] {
  if (!raw || !raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: LspServerDef[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    const command = typeof e.command === 'string' ? e.command.trim() : ''
    const languageId = typeof e.languageId === 'string' ? e.languageId.trim() : ''
    const extensions = Array.isArray(e.extensions)
      ? e.extensions.filter((x): x is string => typeof x === 'string').map(x => x.toLowerCase())
      : []
    const args = Array.isArray(e.args) ? e.args.filter((x): x is string => typeof x === 'string') : []
    if (!id || !command || !languageId || extensions.length === 0) continue
    out.push({ id, candidates: [{ command, args }], extensions, languageId })
  }
  return out
}

/**
 * User entries first, so an explicit configuration overrides a built-in for the
 * same extension — that's the only reason to write one.
 */
export function resolveServers(extra: readonly LspServerDef[]): LspServerDef[] {
  return [...extra, ...DEFAULT_SERVERS]
}

/**
 * Quote one token for cmd.exe.
 *
 * Windows needs `shell: true` to launch a language server installed as a `.cmd`
 * shim — which is how every npm-distributed one arrives, `pyright-langserver`
 * included — because Node refuses to exec `.cmd` directly. But `shell: true`
 * makes Node join the command and its arguments into a single command line, so
 * anything containing a space splits: a server under `C:\Program Files\…`
 * silently becomes an attempt to run `C:\Program`, which surfaces as ENOENT and
 * looks exactly like "not installed".
 *
 * Only the double-quote needs escaping (cmd has no backslash escape), and a
 * token already wrapped in quotes is left alone so a user-written settings entry
 * that quoted its own path isn't double-wrapped.
 */
export function quoteForCmd(token: string): string {
  if (!token) return '""'
  if (token.startsWith('"') && token.endsWith('"') && token.length > 1) return token
  if (!/[\s&|<>^()"]/.test(token)) return token
  return `"${token.replace(/"/g, '""')}"`
}
