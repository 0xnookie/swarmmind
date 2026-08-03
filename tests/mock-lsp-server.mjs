// A minimal, real LSP server over stdio — the counterpart the generic client
// (electron/lsp/stdio.ts) is driven against in tests/lsp-stdio-verify.mjs.
//
// Why a mock and not pyright: the thing under test is *our client's* protocol
// handling — framing, the initialize handshake, document sync, the reply shapes
// — not any particular server's analysis. A mock makes the test run on any
// machine with nothing installed, and lets it assert things a real server would
// never reliably produce on demand (a LocationLink-shaped definition, a
// documentChanges-shaped rename, a server→client request mid-handshake).

import { stdin, stdout } from 'node:process'

let buffer = Buffer.alloc(0)
const docs = new Map() // uri -> text

function send(payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf-8')
  stdout.write(Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'ascii'))
  stdout.write(json)
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

function publish(uri) {
  const text = docs.get(uri) ?? ''
  const lines = text.split('\n')
  const diagnostics = []
  lines.forEach((line, i) => {
    const col = line.indexOf('BAD')
    if (col !== -1) {
      diagnostics.push({
        range: { start: { line: i, character: col }, end: { line: i, character: col + 3 } },
        message: 'mock: BAD is not allowed',
        severity: 1,
        code: 42,
      })
    }
  })
  notify('textDocument/publishDiagnostics', { uri, diagnostics })
}

function handle(msg) {
  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      // Ask the client something mid-handshake. A client that doesn't answer
      // server→client requests deadlocks here, which is exactly the bug this
      // exercises.
      send({ jsonrpc: '2.0', id: 9001, method: 'client/registerCapability', params: { registrations: [] } })
      reply(id, { capabilities: { textDocumentSync: 1, hoverProvider: true, definitionProvider: true, referencesProvider: true, renameProvider: true } })
      return

    case 'initialized':
      return

    case 'textDocument/didOpen':
      docs.set(params.textDocument.uri, params.textDocument.text)
      publish(params.textDocument.uri)
      return

    case 'textDocument/didChange':
      docs.set(params.textDocument.uri, params.contentChanges[0].text)
      publish(params.textDocument.uri)
      return

    case 'textDocument/didClose':
      docs.delete(params.textDocument.uri)
      return

    case 'textDocument/hover':
      // The awkward shape on purpose: an array mixing a code block and prose.
      reply(id, {
        contents: [{ language: 'mock', value: 'def target()' }, 'Docs for target.'],
        range: {
          start: { line: params.position.line, character: 0 },
          end: { line: params.position.line, character: 4 },
        },
      })
      return

    case 'textDocument/definition':
      // LocationLink shape — the one a naive client silently drops.
      reply(id, [{
        targetUri: params.textDocument.uri,
        targetSelectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
        targetRange: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
      }])
      return

    case 'textDocument/references':
      reply(id, [
        { uri: params.textDocument.uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } } },
        { uri: params.textDocument.uri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } } },
      ])
      return

    case 'textDocument/rename':
      // documentChanges shape, with a file-operation entry mixed in that the
      // client must drop rather than act on.
      reply(id, {
        documentChanges: [
          { kind: 'create', uri: 'file:///should/not/be/created' },
          {
            textDocument: { uri: params.textDocument.uri, version: 1 },
            edits: [
              { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } }, newText: params.newName },
              { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } }, newText: params.newName },
            ],
          },
        ],
      })
      return

    case 'shutdown':
      reply(id, null)
      return

    case 'exit':
      process.exit(0)
      return

    default:
      if (id !== undefined) reply(id, null)
  }
}

stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.toString('ascii', 0, headerEnd))[1])
    const start = headerEnd + 4
    if (buffer.length - start < length) return
    const body = buffer.toString('utf-8', start, start + length)
    buffer = buffer.subarray(start + length)
    try { handle(JSON.parse(body)) } catch { /* ignore */ }
  }
})
