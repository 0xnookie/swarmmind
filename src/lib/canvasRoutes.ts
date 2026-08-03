/**
 * Canvas routes — an arrow drawn between two terminal cards is a live message
 * route. Pure decision logic; the impure shell is `src/hooks/useRoutes.ts`.
 *
 * The board already understood arrows between *task* cards (they write
 * `depends_on`). Between terminals an arrow meant nothing, which is a strange
 * gap: the picture of the swarm was on screen, but the wiring it depicted had
 * to be re-created by hand every turn. Now the arrow *is* the wiring — when the
 * source pane finishes a turn, the tail of what it said is handed to the target
 * pane as input. Reviewer downstream of builder, drawn once.
 *
 * Three guards decide whether a relay fires, and every one of them exists
 * because the naive version breaks in a way that costs the user real money:
 *
 *  - **The ping-pong guard.** A→B and B→A is a legitimate thing to draw (two
 *    agents reviewing each other) and, unguarded, it is an infinite loop of two
 *    CLIs prompting each other for as long as the app is open. A pane that
 *    *received* a relay recently cannot *emit* one.
 *  - **The cooldown.** Agents go quiet more than once per turn (a permission
 *    prompt, a tool result, a pause for thought), and every quiet moment would
 *    otherwise be a fresh dispatch downstream.
 *  - **The unchanged-body check.** The relay body is a tail of the terminal, so
 *    a pane that goes quiet twice without printing anything new would send the
 *    same paragraph twice — which reads to the receiving agent as a second,
 *    subtly different instruction rather than a repeat.
 *
 * Dependency-free (see CLAUDE.md), asserted in tests/lib-units.mts.
 */

/** A route is between *panes*, not cards — the card is just how it was drawn. */
export interface RouteEdge {
  from: string
  to: string
}

/** How long after finishing a turn a pane may relay again. */
export const RELAY_COOLDOWN_MS = 20_000
/** How long a pane that just received a relay is barred from emitting one. */
export const RELAY_QUIET_MS = 45_000
/** Tail of the source pane's output handed downstream. */
export const RELAY_MAX_CHARS = 1800

/**
 * The routes a board's arrows describe.
 *
 * Only terminal→terminal arrows count: an arrow from an image to a terminal is
 * the screenshot-handoff affordance, and one between task cards is a
 * dependency. Self-routes and duplicates are dropped, since both would fire a
 * pane at itself.
 */
export function deriveRoutes(
  items: readonly { id: string; kind: string; paneId?: string }[],
  connectors: readonly { from: string; to: string }[],
): RouteEdge[] {
  const paneOf = new Map<string, string>()
  for (const it of items) {
    if (it.kind === 'terminal' && it.paneId) paneOf.set(it.id, it.paneId)
  }
  const seen = new Set<string>()
  const out: RouteEdge[] = []
  for (const c of connectors) {
    const from = paneOf.get(c.from)
    const to = paneOf.get(c.to)
    if (!from || !to || from === to) continue
    const key = `${from}>${to}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from, to })
  }
  return out
}

/** Does anything downstream of this pane exist? Cheap pre-check for the hook. */
export function hasRoutesFrom(routes: readonly RouteEdge[], paneId: string): boolean {
  return routes.some(r => r.from === paneId)
}

export interface RelayMemo {
  /** When each source pane last emitted. */
  sentAt: Record<string, number>
  /** When each target pane last received — the ping-pong guard reads this. */
  receivedAt: Record<string, number>
  /** Last body per `from>to`, so an unchanged tail isn't sent twice. */
  lastBody: Record<string, string>
}

export function emptyRelayMemo(): RelayMemo {
  return { sentAt: {}, receivedAt: {}, lastBody: {} }
}

/**
 * The chunk of a pane's output that gets handed downstream.
 *
 * A terminal tail is mostly noise — box-drawing, spinner frames, the prompt the
 * agent is now sitting at — so blank runs are collapsed and the leading partial
 * line is dropped (the tail cut lands mid-line by definition, and half a
 * sentence at the top reads as a corrupted instruction). Something too short to
 * be a report returns empty, which the planner treats as "nothing to say".
 */
export function relayBody(raw: string, maxChars = RELAY_MAX_CHARS): string {
  const tail = raw.length > maxChars ? raw.slice(raw.length - maxChars) : raw
  const lines = tail.split('\n')
  // Only when the text really was cut: an untruncated first line is content.
  if (raw.length > maxChars) lines.shift()
  const cleaned = lines
    .map(l => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.length < 12 ? '' : cleaned
}

export interface PlannedRelay {
  to: string
  body: string
}

export interface RelayOptions {
  cooldownMs?: number
  quietMs?: number
}

/**
 * Which downstream panes should hear about this turn.
 *
 * Returns the empty list rather than throwing on every degenerate case — the
 * caller runs this on a state transition it does not control, and "no relay" is
 * always a safe answer.
 */
export function planRelay(
  routes: readonly RouteEdge[],
  from: string,
  body: string,
  memo: RelayMemo,
  now: number,
  opts: RelayOptions = {},
): PlannedRelay[] {
  if (!body) return []
  const cooldownMs = opts.cooldownMs ?? RELAY_COOLDOWN_MS
  const quietMs = opts.quietMs ?? RELAY_QUIET_MS
  // This pane is very likely echoing something it was just handed. Emitting
  // here is how a two-way pair of arrows becomes a perpetual motion machine.
  const received = memo.receivedAt[from]
  if (received !== undefined && now - received < quietMs) return []
  const sent = memo.sentAt[from]
  if (sent !== undefined && now - sent < cooldownMs) return []
  const out: PlannedRelay[] = []
  for (const r of routes) {
    if (r.from !== from || r.to === from) continue
    if (memo.lastBody[`${r.from}>${r.to}`] === body) continue
    out.push({ to: r.to, body })
  }
  return out
}

/** The memo after a set of relays went out. Pure — returns a new object. */
export function markRelayed(
  memo: RelayMemo,
  from: string,
  relays: readonly PlannedRelay[],
  now: number,
): RelayMemo {
  if (relays.length === 0) return memo
  const sentAt = { ...memo.sentAt, [from]: now }
  const receivedAt = { ...memo.receivedAt }
  const lastBody = { ...memo.lastBody }
  for (const r of relays) {
    receivedAt[r.to] = now
    lastBody[`${from}>${r.to}`] = r.body
  }
  return { sentAt, receivedAt, lastBody }
}

/**
 * What the downstream agent is actually told.
 *
 * Single-line-prefixed and explicitly marked as relayed output, for the same
 * reason the conductor's dispatch prompt is: an agent that can't tell a handed
 * transcript from a human instruction will try to *obey* the other agent's
 * thinking-out-loud. It's also told not to reply back down the wire, which is
 * the human-readable half of the ping-pong guard.
 */
export function buildRelayPrompt(fromLabel: string, body: string): string {
  return (
    `[SwarmMind relay ← ${fromLabel}] The agent upstream of you just finished a turn. ` +
    `Below is the tail of its output. Treat it as a report to act on, not as instructions to repeat, ` +
    `and do not send anything back to that agent. ` +
    `--- ${body.replace(/\s*\n\s*/g, ' ⏎ ')} ---`
  )
}
