import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import express, { type Express } from 'express'
import { Server, createServer } from 'http'
import { randomBytes, createHmac, timingSafeEqual } from 'crypto'
import { registerTools } from './tools'
import { registerResources } from './resources'
import { runWithWorkspace, getRequestWorkspaceId } from '../memory/db'

// Preferred port; we fall back to OS-assigned if it's blocked
const PREFERRED_PORT = 57400

let httpServer: Server | null = null
let actualPort: number | null = null
let activeWorkspaceId: string | null = null

// Per-run master secret. The server binds to 127.0.0.1, but any local process
// could otherwise read/write workspace memory and tasks; requiring a token
// (handed only to agents we spawn, via their injected config) closes that gap.
// Tokens are derived per workspace so a token issued for one workspace can't be
// replayed against another by swapping the `?ws=` query param — each token only
// authorizes its own workspace's DB.
const masterSecret = randomBytes(32)

export function getMcpToken(workspaceId: string): string {
  return createHmac('sha256', masterSecret).update(workspaceId).digest('hex')
}

// Constant-time comparison of two hex token strings.
function tokensMatch(a: unknown, expected: string): boolean {
  if (typeof a !== 'string' || a.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(expected))
  } catch {
    return false
  }
}

export function setActiveWorkspace(id: string | null): void {
  activeWorkspaceId = id
}

export function getActiveWorkspace(): string | null {
  return activeWorkspaceId
}

export function getMcpPort(): number | null {
  return actualPort
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(); reject(new Error('No address')); return }
      const port = addr.port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

export function startMcpServer(): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const app: Express = express()
    app.use(express.json())

    const mcpServer = new McpServer({
      name: 'swarmmind',
      version: '0.17.0'
    })

    // Each tool call resolves its workspace from the per-request context (the
    // calling agent's own workspace, bound below), falling back to the
    // foreground workspace for any call made outside a bound request.
    registerTools(mcpServer, () => getRequestWorkspaceId() ?? activeWorkspaceId)
    registerResources(mcpServer, () => getRequestWorkspaceId() ?? activeWorkspaceId)

    // Keyed by the transport's own sessionId (a UUID) — that's the id the client
    // posts back to /mcp/messages. `ws` is the agent's workspace, injected into
    // its MCP URL at spawn, so a background agent's calls still target its own DB.
    const transports = new Map<string, { transport: SSEServerTransport; ws: string | null }>()

    app.get('/mcp/sse', async (req, res) => {
      // Gate session establishment on the per-workspace token. The token must
      // match the one derived for the requested `ws`, so a client can only open a
      // session against the workspace it was issued for. /mcp/messages is
      // implicitly protected: it requires a sessionId only handed out here.
      const ws = typeof req.query.ws === 'string' && req.query.ws ? req.query.ws : null
      if (!ws || !tokensMatch(req.query.token, getMcpToken(ws))) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const transport = new SSEServerTransport('/mcp/messages', res)
      transports.set(transport.sessionId, { transport, ws })
      res.on('close', () => transports.delete(transport.sessionId))
      await mcpServer.connect(transport)
    })

    app.post('/mcp/messages', async (req, res) => {
      const sessionId = req.query.sessionId as string
      const entry = transports.get(sessionId)
      if (!entry) { res.status(400).json({ error: 'Unknown session' }); return }
      // Bind this request to the agent's workspace so getWorkspaceDb() and event
      // emits route to the correct DB. No binding when the workspace is unknown.
      const targetWs = entry.ws ?? activeWorkspaceId
      if (targetWs) {
        await runWithWorkspace(targetWs, () => entry.transport.handlePostMessage(req, res))
      } else {
        await entry.transport.handlePostMessage(req, res)
      }
    })

    app.get('/health', (_req, res) => res.json({ ok: true, workspace: activeWorkspaceId, port: actualPort }))

    // Try preferred port, fall back to OS-assigned
    let port = PREFERRED_PORT
    const srv = new Server(app)
    httpServer = srv

    const tryListen = (p: number) => {
      srv.listen(p, '127.0.0.1', () => {
        const addr = srv.address()
        actualPort = typeof addr === 'object' && addr ? addr.port : p
        console.log(`[MCP] Server listening on http://127.0.0.1:${actualPort}`)
        resolve()
      })

      srv.once('error', async (err: NodeJS.ErrnoException) => {
        if ((err.code === 'EACCES' || err.code === 'EADDRINUSE') && p === PREFERRED_PORT) {
          srv.removeAllListeners('error')
          // Fall back to OS-assigned port
          const freePort = await findFreePort().catch(() => 0)
          if (freePort) {
            tryListen(freePort)
          } else {
            console.warn('[MCP] Could not find free port, MCP disabled')
            httpServer = null
            resolve()
          }
        } else {
          reject(err)
        }
      })
    }

    tryListen(port)
  })
}

export function stopMcpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (httpServer) {
      httpServer.close(() => resolve())
      httpServer = null
      actualPort = null
    } else {
      resolve()
    }
  })
}
