// JSON-RPC framing and URI conversion for the external language-server client
// (electron/lsp/stdio.ts).
//
// This is the base-protocol layer of LSP: every message is
//
//     Content-Length: <bytes>\r\n\r\n<json>
//
// and two things about it are easy to get subtly wrong in a way that only shows
// up on someone else's machine:
//
//  1. **The length is in BYTES, not characters.** A single non-ASCII character
//     in a hover result or a file path makes a char-counted split cut the JSON
//     mid-message, and from then on the stream is permanently desynchronised —
//     the server appears to hang rather than to fail. Everything here therefore
//     works on Buffers.
//  2. **A stdout chunk is not a message.** Reads arrive split anywhere, and
//     several replies routinely land in one chunk. The decoder consumes as many
//     complete messages as are present and hands back the remainder.
//
// Pure and dependency-free (Buffer is a Node builtin), so it strip-and-runs in
// tests/lib-units.mts.

export function encodeMessage(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf-8')
  return Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'ascii'), json])
}

export interface DecodeResult {
  /** Complete messages, parsed. Unparseable payloads are dropped, not thrown. */
  messages: unknown[]
  /** Bytes belonging to a message that hasn't fully arrived yet. */
  rest: Buffer
}

const HEADER_END = Buffer.from('\r\n\r\n', 'ascii')

export function decodeMessages(buf: Buffer): DecodeResult {
  const messages: unknown[] = []
  let offset = 0

  for (;;) {
    const headerEnd = buf.indexOf(HEADER_END, offset)
    if (headerEnd === -1) break

    const header = buf.toString('ascii', offset, headerEnd)
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) {
      // A header block with no Content-Length can't be framed. Skip past it
      // rather than stalling forever on bytes that will never become a message.
      offset = headerEnd + HEADER_END.length
      continue
    }

    const length = Number(match[1])
    const start = headerEnd + HEADER_END.length
    if (buf.length - start < length) break // body still in flight

    const body = buf.toString('utf-8', start, start + length)
    try {
      messages.push(JSON.parse(body))
    } catch {
      // A malformed body must not take the connection down; the framing is
      // still intact, so keep reading.
    }
    offset = start + length
  }

  return { messages, rest: buf.subarray(offset) }
}

// ── file:// URIs ─────────────────────────────────────────────────────────────
// Windows is the whole reason these are functions and not template literals:
// `D:\a\b.ts` has to become `file:///d%3A/a/b.ts`-ish, the drive letter gets an
// extra leading slash, and separators flip. Servers echo URIs back verbatim in
// definitions and rename edits, so a round-trip that isn't lossless turns into
// "go to definition opens nothing" with no error anywhere.

export function pathToUri(path: string): string {
  let p = path.replace(/\\/g, '/')
  if (!p.startsWith('/')) p = '/' + p // drive-letter paths need the third slash
  // encodeURI leaves '/' and ':' alone, which is what we want for a drive letter,
  // but escapes spaces and non-ASCII, which is what servers expect.
  return 'file://' + encodeURI(p).replace(/[?#]/g, c => '%' + c.charCodeAt(0).toString(16))
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  let p = decodeURIComponent(uri.slice('file://'.length))
  // Strip the extra slash in front of a drive letter (/D:/x → D:/x).
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
  return p
}
