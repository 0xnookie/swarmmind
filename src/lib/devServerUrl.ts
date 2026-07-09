// Detect a local dev-server URL announced in (ANSI-stripped) terminal output —
// "Local: http://localhost:5173/", "listening on 127.0.0.1:8080", … — so the
// built-in preview browser can offer to open it the moment an agent starts a dev
// server. Pure and dependency-free (unit-tested); the impure half (scan
// scheduling, store updates) lives in usePty.ts.

// Explicit local http(s) URLs. Host is restricted to loopback/any so a printed
// GitHub/docs link never counts as a dev server.
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"`<>)\]]*)?/gi

// Fallback: a bare host:port on a line that talks about a server. Catches
// "Server listening on 127.0.0.1:8080" style announcements without a scheme.
const SERVERISH_LINE_RE = /\b(?:listen(?:ing|s)?|running|ready|serving|served|server|started|available|local)\b/i
const BARE_HOSTPORT_RE = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/i

const TRAIL_RE = /[.,;!?'"`]+$/

function normalize(url: string): string {
  const cleaned = url.replace(TRAIL_RE, '')
  // 0.0.0.0 / [::] mean "all interfaces" — browse it via localhost.
  return cleaned.replace(/\/\/(?:0\.0\.0\.0|\[::1?\])/, '//localhost')
}

/**
 * Find the most recently announced local dev-server URL in a tail of terminal
 * output, or null. Later announcements win (the tail reads oldest→newest, and a
 * server restart on a new port should supersede the old one).
 */
export function findDevServerUrl(text: string): string | null {
  if (!text) return null
  let last: string | null = null
  LOCAL_URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LOCAL_URL_RE.exec(text))) last = normalize(m[0])
  if (last) return last
  // No explicit URL — look for a serverish "host:port" line, latest first.
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!SERVERISH_LINE_RE.test(line)) continue
    const hp = BARE_HOSTPORT_RE.exec(line)
    if (hp) return `http://localhost:${hp[1]}`
  }
  return null
}
