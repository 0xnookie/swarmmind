import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { AgentPane } from './AgentPane'
import { useWorkspaceStore, type PaneNode, type PaneLeaf, type AgentId, type PtyStatus } from '../store/workspace'
import { useT } from '../i18n'
import { confirmDialog } from './ConfirmDialog'
import { ChevronDisclosure, ChevronLeft, ChevronRight } from './Icons'
import {
  resizeRect, RESIZE_DIRS, RESIZE_CURSOR, type ResizeDir,
  GRID, gridBackgroundOffset,
} from '../lib/canvasResize'
import {
  fitBox, rectsIntersect, projectPointToImage, strokeScale, buildHandoffPrompt,
} from '../lib/canvasHandoff'
import {
  focusLayout, snapAll, tidyGrid, eraserHits, isErasableKind, ERASER_RADIUS,
  normalizeRect, marqueeHits, selectionBounds, dragDelta,
  type Rect as ScreenRect,
} from '../lib/canvasLayout'
import {
  isTileZoom, tileState, tileMetrics, tileCost, TILE_STATE_COLOR, type TileState,
} from '../lib/canvasLod'
import { deriveRoutes } from '../lib/canvasRoutes'
import {
  frameChildren, framePanes, nextFrameName, nextFrameColor, isFrameKind,
  FRAME_Z, FRAME_LABEL_Z, FRAME_HEADER_H, MIN_FRAME_W, MIN_FRAME_H,
} from '../lib/canvasFrames'
import {
  viewportWorldRect, isOffscreen, cameraToCenter, pickAttentionTarget, shouldFollow,
} from '../lib/canvasAttention'
import {
  raceEligibility, canStartRace, buildRacePrompt, attemptState, churn, contestedFiles,
  planWinner, type AttemptStat, type RacePane,
} from '../lib/race'
import type { KanbanTask } from './KanbanBoard'
import { addDep, removeDep, wouldCycle, parseDeps, taskStatusColor } from '../lib/canvasTasks'

// ── Canvas model ────────────────────────────────────────────────────────────
// A "canvas" is a free-form, pannable/zoomable board (cnvs.dev / Miro style).
// Terminal cards map 1:1 onto real rootPane leaves, so they're fully live agent
// panes — the canvas is just an alternate spatial view of the same terminals,
// plus canvas-only browsers, sticky notes, text and shapes. Everything but the
// terminal↔pane link is persisted per-workspace under the `canvas:<id>` setting.

type CanvasTool =
  | 'select' | 'hand' | 'draw' | 'erase' | 'connect'
  | 'terminal' | 'browser' | 'device' | 'note' | 'text' | 'image' | 'task' | 'frame'
  | 'rect' | 'ellipse' | 'triangle'

type BgType = 'dots' | 'grid' | 'solid' | 'image'

interface CanvasItem {
  id: string
  kind: 'terminal' | 'browser' | 'device' | 'note' | 'text' | 'shape' | 'draw' | 'image' | 'task' | 'frame'
  x: number
  y: number
  w: number
  h: number
  z: number
  paneId?: string          // terminal
  url?: string             // browser / device — the single/legacy URL
  tabs?: BrowserTab[]      // browser — when set, the card is a tab stack
  activeTab?: string       // browser — id of the visible tab
  device?: string          // device — preset id (see DEVICE_PRESETS)
  orientation?: 'portrait' | 'landscape'  // device
  text?: string            // note / text / frame name
  color?: string           // note / text / shape fill / stroke / frame accent
  shape?: 'rect' | 'ellipse' | 'triangle'
  points?: { x: number; y: number }[]  // draw — polyline relative to {x,y}
  strokeWidth?: number     // draw
  src?: string             // image — data URL
  opacity?: number         // terminal — card opacity, 0.2…1 (default 1)
  taskId?: string          // task — row id in the tasks table (see KanbanTask)
  // Pinned in place: no drag, no resize, no erase, no Delete. For the reference
  // material you draw on top of (a screenshot, a frame) which otherwise moves
  // the moment you miss the stroke.
  locked?: boolean
}

// One page inside a browser card. A card with several of these renders a tab
// strip; every tab keeps its own <webview> mounted so switching tabs preserves
// scroll position and page state, exactly like a real browser.
interface BrowserTab { id: string; url: string }

// Browser cards predate tabs, so a legacy item carries only `url`. Read every
// browser through here and the two shapes stay interchangeable.
function browserTabs(item: CanvasItem): BrowserTab[] {
  if (item.tabs?.length) return item.tabs
  return [{ id: item.id + ':0', url: item.url ?? '' }]
}

function activeBrowserTab(item: CanvasItem): BrowserTab {
  const tabs = browserTabs(item)
  return tabs.find(tb => tb.id === item.activeTab) ?? tabs[0]
}

// A connector links two items; it re-renders from their live positions, so it
// tracks them as they move. Endpoints are clipped to each item's border.
interface Connector { id: string; from: string; to: string; color?: string }

interface Camera { x: number; y: number; zoom: number }
interface Background { type: BgType; color: string; image?: string | null }

interface PersistShape {
  // Non-terminal items persist fully; terminal items persist only their
  // geometry keyed by paneId (the pane itself lives in the layout tree).
  items: CanvasItem[]
  connectors?: Connector[]
  camera: Camera
  background: Background
  rail?: { x: number; y: number } | null
  railCollapsed?: boolean
  /** Minimap placement; `null`/absent = the default bottom-right corner. */
  minimap?: { x: number; y: number } | null
  /** Board-wide terminal transparency; a card may override it per-item. */
  terminalOpacity?: number
  /** Semantic zoom: terminals become status tiles when zoomed out. Default on. */
  lod?: boolean
  /** Follow camera: pan to whichever pane just asked a question. Default off. */
  follow?: boolean
}

// Effective transparency for a terminal card: its own override if set,
// otherwise the board-wide default.
function terminalAlpha(item: CanvasItem, global: number): number {
  return item.opacity ?? global
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const MIN_ITEM_W = 140
const MIN_ITEM_H = 80

const NOTE_COLORS = ['#f4c95d', '#e8956b', '#7fc8a0', '#7fb0e8', '#c89be0', '#e88ba5']
// Race attempt states, coloured the same as RacePanel's — the two surfaces show
// the same race, so an attempt must not be green in one and grey in the other.
const RACE_STATE_COLOR: Record<string, string> = {
  ready: '#7ee787',
  working: 'var(--accent)',
  waiting: 'var(--text-muted)',
  gone: '#ff7b72',
}
const PEN_COLORS = ['#e8956b', '#f4c95d', '#7fc8a0', '#7fb0e8', '#c89be0', '#e88ba5', '#ece7e0', '#1a1512']
const PEN_WIDTHS = [2, 4, 8]
const DEFAULT_BG: Background = { type: 'dots', color: '#161412', image: null }
const DEFAULT_CAMERA: Camera = { x: 120, y: 100, zoom: 1 }

// ── Device mockups (responsive testing) ─────────────────────────────────────
// Each device card embeds a real <webview> sized to the preset's *logical*
// viewport (CSS px), so the loaded page's media queries / breakpoints react
// exactly as they would on the physical device — Chrome/Firefox device-toolbar
// style. The bezel around the screen is purely cosmetic; the whole frame is
// scaled with a CSS transform to fit the card while the guest keeps rendering
// at true device pixels.
interface DevicePreset {
  id: string
  label: string
  w: number            // logical viewport width (portrait), CSS px
  h: number            // logical viewport height (portrait), CSS px
  os: 'ios' | 'android'
  type: 'phone' | 'tablet'
}

const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'iphone-se', label: 'iPhone SE', w: 375, h: 667, os: 'ios', type: 'phone' },
  { id: 'iphone-14', label: 'iPhone 14 · 13', w: 390, h: 844, os: 'ios', type: 'phone' },
  { id: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', w: 430, h: 932, os: 'ios', type: 'phone' },
  { id: 'pixel-8', label: 'Pixel 8', w: 412, h: 915, os: 'android', type: 'phone' },
  { id: 'galaxy-s22', label: 'Galaxy S22 Ultra', w: 384, h: 854, os: 'android', type: 'phone' },
  { id: 'galaxy-fold', label: 'Galaxy Z Fold', w: 344, h: 882, os: 'android', type: 'phone' },
  { id: 'ipad-mini', label: 'iPad mini', w: 768, h: 1024, os: 'ios', type: 'tablet' },
  { id: 'ipad-air', label: 'iPad Air', w: 820, h: 1180, os: 'ios', type: 'tablet' },
  { id: 'ipad-pro-11', label: 'iPad Pro 11″', w: 834, h: 1194, os: 'ios', type: 'tablet' },
  { id: 'surface-duo', label: 'Surface Duo', w: 540, h: 720, os: 'android', type: 'tablet' },
]
const DEFAULT_DEVICE = 'iphone-14'

const DEVICE_UA: Record<DevicePreset['os'], string> = {
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
}

const getPreset = (id?: string): DevicePreset =>
  DEVICE_PRESETS.find(p => p.id === id) ?? DEVICE_PRESETS.find(p => p.id === DEFAULT_DEVICE)!

// Logical viewport in the current orientation.
function deviceViewport(preset: DevicePreset, orientation: 'portrait' | 'landscape') {
  return orientation === 'landscape' ? { w: preset.h, h: preset.w } : { w: preset.w, h: preset.h }
}

// Cosmetic bezel geometry + the full frame (bezel + screen) size.
function deviceFrame(preset: DevicePreset, orientation: 'portrait' | 'landscape') {
  const vp = deviceViewport(preset, orientation)
  const tablet = preset.type === 'tablet'
  const side = tablet ? 16 : 13
  const topB = tablet ? 16 : 14
  const botB = tablet ? 16 : 16
  const radius = tablet ? 26 : 48
  return { vp, side, topB, botB, radius, w: vp.w + side * 2, h: vp.h + topB + botB }
}

const DEVICE_CTRL_H = 64  // two control rows above the frame

// Card footprint that shows the frame at a comfortable default scale.
function deviceCardSize(preset: DevicePreset, orientation: 'portrait' | 'landscape') {
  const f = deviceFrame(preset, orientation)
  const scale = Math.min(1, 560 / f.h, 560 / f.w)
  return { w: Math.round(f.w * scale) + 28, h: Math.round(f.h * scale) + DEVICE_CTRL_H + 24 }
}

function getLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return node.children.flatMap(getLeaves)
}

// ── CanvasMode ──────────────────────────────────────────────────────────────

// Bake an image item together with any freehand strokes drawn over it into a
// single PNG data URL, at the image's *native* resolution — so the annotations
// the user scribbled (circles, arrows) are part of the screenshot handed to the
// agent. Strokes are the same `kind:'draw'` items the pen tool already makes;
// only those whose bounding box overlaps the image are baked in. Falls back to
// the untouched source if the image can't be loaded or nothing overlaps.
function compositeCapture(image: CanvasItem, draws: CanvasItem[]): Promise<string> {
  return new Promise(resolve => {
    const src = image.src ?? ''
    if (!src) { resolve(''); return }
    const imgBox = { x: image.x, y: image.y, w: image.w, h: image.h }
    const overlaps = draws.filter(d =>
      d.kind === 'draw' && (d.points?.length ?? 0) > 1 &&
      rectsIntersect(imgBox, { x: d.x, y: d.y, w: d.w, h: d.h }))
    if (!overlaps.length) { resolve(src); return }

    const img = new Image()
    img.onload = () => {
      const natW = img.naturalWidth || image.w
      const natH = img.naturalHeight || image.h
      const cv = document.createElement('canvas')
      cv.width = natW
      cv.height = natH
      const ctx = cv.getContext('2d')
      if (!ctx) { resolve(src); return }
      ctx.drawImage(img, 0, 0, natW, natH)
      const scale = strokeScale(imgBox, natW, natH)
      for (const d of overlaps) {
        ctx.strokeStyle = d.color || '#e8956b'
        ctx.lineWidth = Math.max(1, (d.strokeWidth ?? 3) * scale)
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.beginPath()
        d.points!.forEach((p, i) => {
          const px = projectPointToImage(imgBox, natW, natH, d.x + p.x, d.y + p.y)
          if (i === 0) ctx.moveTo(px.x, px.y)
          else ctx.lineTo(px.x, px.y)
        })
        ctx.stroke()
      }
      try { resolve(cv.toDataURL('image/png')) } catch { resolve(src) }
    }
    img.onerror = () => resolve(src)
    img.src = src
  })
}

// ── rAF-coalesced pointer drags ───────────────────────────────────────────────
// Every drag gesture on this board — card move, resize, marquee, pan, pen,
// eraser, the tool rail and the minimap — commits React state, and CanvasMode's
// state drives the whole item list. So one state write per pointer event means
// re-rendering every card on the board, live terminals included, at whatever
// rate the pointer reports. Chromium already aligns pointermove dispatch to
// vsync, but bursts still arrive coalesced and the handler work itself
// (hit-testing, mapping the item array, rebuilding a polyline) is pure waste
// more than once per frame.
//
// `startPointerDrag` installs the listeners and runs `move` at most once per
// animation frame with the most recent event. Handlers that need every
// intermediate position (the eraser, the pen) read `ev.getCoalescedEvents()`
// rather than being called more often.
//
// The pending frame is flushed on pointerup, so a gesture always lands on the
// exact release position instead of wherever the last painted frame was.
function startPointerDrag(
  move: (ev: PointerEvent) => void,
  end?: (ev: PointerEvent) => void,
): void {
  let pending: PointerEvent | null = null
  let frame = 0

  const flush = () => {
    frame = 0
    const ev = pending
    pending = null
    if (ev) move(ev)
  }
  const onMove = (ev: PointerEvent) => {
    pending = ev
    if (!frame) frame = requestAnimationFrame(flush)
  }
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (frame) cancelAnimationFrame(frame)
    flush()
    end?.(ev)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// Every pointer position since the last delivered event, oldest first. Used by
// the gestures that sweep across the board (pen, eraser), where skipping
// intermediate points would drop a stroke's shape or miss a small item between
// two frames. Falls back to the event itself where unsupported.
function coalescedPoints(ev: PointerEvent): { clientX: number; clientY: number }[] {
  const all = ev.getCoalescedEvents?.()
  return all && all.length ? all : [ev]
}

export function CanvasMode() {
  const t = useT()
  const workspace = useWorkspaceStore(s => s.workspace)
  const rootPane = useWorkspaceStore(s => s.rootPane)
  const addPane = useWorkspaceStore(s => s.addPane)
  const closePane = useWorkspaceStore(s => s.closePane)
  const getLeafIds = useWorkspaceStore(s => s.getLeafIds)
  const showTerminals = useWorkspaceStore(s => s.showTerminals)
  // Live swarm state the board reads: which pane is on which task (the tile's
  // subtitle), who has an unanswered question (the attention camera), and the
  // race framing — shared with RacePanel through the store so the two surfaces
  // can never disagree about who is racing on what.
  const paneTask = useWorkspaceStore(s => s.paneTask)
  const paneAttention = useWorkspaceStore(s => s.paneAttention)
  const notifications = useWorkspaceStore(s => s.notifications)
  const setPaneRoutes = useWorkspaceStore(s => s.setPaneRoutes)
  const raceGoal = useWorkspaceStore(s => s.raceGoal)
  const setRaceGoal = useWorkspaceStore(s => s.setRaceGoal)
  const racePaneIds = useWorkspaceStore(s => s.racePaneIds)
  const setRacePaneIds = useWorkspaceStore(s => s.setRacePaneIds)

  const rootRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<CanvasTool>('select')
  const [items, setItems] = useState<CanvasItem[]>([])
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA)
  const [background, setBackground] = useState<Background>(DEFAULT_BG)
  // Selection is a set, not a single id: a marquee drag can pick up several
  // items, and dragging any one of them then moves all of them together.
  // Single-item selection is just the one-element case.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // The in-progress marquee, in board-relative screen px (it's drawn as plain
  // chrome over the board, so it must not pan/zoom with the world).
  const [marquee, setMarquee] = useState<ScreenRect | null>(null)
  const [maximizedId, setMaximizedId] = useState<string | null>(null)
  // Focus mode: one terminal on the stage, the others stacked down the right
  // edge. Session-only — it's a way of looking at the board, not part of it, so
  // reopening the workspace gives you the board back rather than a view you
  // left days ago. Cleared automatically if the focused pane goes away.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // Keyboard-shortcut cheat sheet (`?`). The board leans on bare-key tools, so
  // there has to be somewhere to read them.
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [bgPickerOpen, setBgPickerOpen] = useState(false)
  // Tool rail placement. `null` = the default left-centred spot; once dragged it
  // becomes an explicit {x,y} in board coords. Collapsing shrinks it to a puck.
  const [railPos, setRailPos] = useState<{ x: number; y: number } | null>(null)
  const [railCollapsed, setRailCollapsed] = useState(false)
  // Minimap placement. `null` = the default bottom-right corner; once dragged by
  // its grip it becomes an explicit {x,y} in board (screen) coords.
  const [minimapPos, setMinimapPos] = useState<{ x: number; y: number } | null>(null)
  // Board-wide terminal transparency (1 = opaque). Individual cards can
  // override it; "apply to all" writes here and clears the overrides.
  const [terminalOpacity, setTerminalOpacity] = useState(1)
  // ── Semantic zoom ──
  // `lodEnabled` is the user's switch; `tileMode` is the current answer, kept in
  // state rather than derived because the decision is hysteretic — it reads its
  // own previous value (see canvasLod.ts) so a wheel nudge parked on the
  // threshold can't flip every terminal on the board back and forth.
  const [lodEnabled, setLodEnabled] = useState(true)
  const [tileMode, setTileMode] = useState(false)
  // ── Attention camera ──
  // Follow is opt-in: an automatic pan is exactly the right thing when you're
  // watching a swarm work and exactly the wrong thing while you're arranging
  // cards, and only the user knows which they're doing.
  const [follow, setFollow] = useState(false)
  const lastFollowedRef = useRef<string | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const [snap, setSnap] = useState(false)
  const snapRef = useRef(snap)
  snapRef.current = snap
  // Connectors + the connect-tool's in-progress endpoint / rubber-band target.
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [connectPointer, setConnectPointer] = useState<{ x: number; y: number } | null>(null)
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null)
  // Hidden file input for the image tool.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingImgPos = useRef<{ x: number; y: number } | null>(null)
  // Pen tool: current colour/width and the in-progress stroke (world coords).
  // Live eraser cursor (screen coords) — the ring that shows what a swipe would
  // catch. A plain crosshair gives no sense of the radius.
  const [eraserAt, setEraserAt] = useState<{ x: number; y: number } | null>(null)
  const [penColor, setPenColor] = useState(PEN_COLORS[0])
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1])
  const [draft, setDraft] = useState<{ x: number; y: number }[] | null>(null)
  const penRef = useRef({ color: penColor, width: penWidth })
  penRef.current = { color: penColor, width: penWidth }

  // Live board size, needed to maximize a card *in place* (see the maximize
  // note on CanvasCard) rather than mounting a second copy of it.
  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      setViewport(v => (v.w === r.width && v.h === r.height ? v : { w: r.width, h: r.height }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const [loaded, setLoaded] = useState(false)
  // Mid-interaction pointer shield: covers the viewport during a drag/resize/pan
  // so embedded <webview>s (browser cards) can't swallow the pointermove stream
  // and stall the gesture. Value doubles as the cursor to show while active.
  // Value doubles as the CSS cursor shown while the gesture is active.
  const [interacting, setInteracting] = useState<false | string>(false)
  const [menu, setMenu] = useState<{ x: number; y: number; wx: number; wy: number; itemId: string | null } | null>(null)
  // Transient status toast (capture failed, sent to agent, …), bottom-centre.
  const [toast, setToast] = useState<string | null>(null)
  // The "send screenshot to agent" composer: which image, which pane, its label.
  const [sendTarget, setSendTarget] = useState<{ imageId: string; paneId: string; agent: string } | null>(null)
  // The frame broadcast composer: one instruction to every agent inside a frame.
  const [frameSend, setFrameSend] = useState<{ frameId: string; label: string; panes: string[] } | null>(null)
  // The race composer: the goal N selected terminals will attempt in parallel.
  const [raceSetup, setRaceSetup] = useState<{ panes: RacePane[] } | null>(null)
  // Live diff stats per racing pane, polled while a race is on (see the race
  // effect below). Readiness is measured in *changed files*, not idleness.
  const [raceStats, setRaceStats] = useState<Record<string, AttemptStat>>({})
  const [raceBase, setRaceBase] = useState('')
  const [raceBusy, setRaceBusy] = useState(false)
  // Live tasks (the visual-orchestrator layer): task cards are backed by real
  // rows in the tasks table, polled here so status/assignment stay fresh.
  const [tasks, setTasks] = useState<KanbanTask[]>([])
  const tasksById = useMemo(() => new Map(tasks.map(tk => [tk.id, tk])), [tasks])
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  // A live mirror of items — drag/resize read the starting geometry from here
  // because React state updater callbacks don't run synchronously.
  const itemsRef = useRef(items)
  itemsRef.current = items
  const connectorsRef = useRef(connectors)
  connectorsRef.current = connectors
  const focusedRef = useRef(focusedId)
  focusedRef.current = focusedId
  // Pointer handlers need the live selection synchronously (a drag decides
  // "move this card" vs "move the whole selection" at pointer-down).
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  // The last eraser pass, so it can be taken back (Ctrl+Z). Erasing is the one
  // gesture here that destroys work in bulk without a confirmation, and a
  // hand-drawn annotation can't be re-created from anything.
  const lastErasedRef = useRef<CanvasItem[]>([])
  const zTopRef = useRef(1)

  const leaves = useMemo(() => getLeaves(rootPane), [rootPane])

  // ── Load persisted canvas for this workspace ──
  // The canvas is per-workspace (`canvas:<id>`). CanvasMode stays mounted across
  // a workspace switch, so we MUST reset all board state first — otherwise the
  // previous workspace's items/connectors linger and, if the new workspace has no
  // saved canvas, get re-persisted under its id (cross-contamination).
  useEffect(() => {
    setLoaded(false)
    setItems([])
    setConnectors([])
    setCamera(DEFAULT_CAMERA)
    setBackground(DEFAULT_BG)
    setSelectedIds([])
    setSelectedConnectorId(null)
    setMaximizedId(null)
    setConnectFrom(null)
    setDraft(null)
    setRailPos(null)
    setRailCollapsed(false)
    setMinimapPos(null)
    setTerminalOpacity(1)
    setLodEnabled(true)
    setFollow(false)
    setRaceStats({})
    setFrameSend(null)
    setRaceSetup(null)
    lastFollowedRef.current = null
    zTopRef.current = 1
    if (!workspace) return
    let cancelled = false
    window.swarmmind.getAppSetting(`canvas:${workspace.id}`).then(raw => {
      if (cancelled) return
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<PersistShape>
          if (Array.isArray(parsed.items)) setItems(parsed.items)
          if (Array.isArray(parsed.connectors)) setConnectors(parsed.connectors)
          if (parsed.camera) setCamera(parsed.camera)
          if (parsed.background) setBackground({ ...DEFAULT_BG, ...parsed.background })
          if (parsed.rail) setRailPos(parsed.rail)
          if (parsed.railCollapsed) setRailCollapsed(true)
          if (parsed.minimap) setMinimapPos(parsed.minimap)
          if (typeof parsed.terminalOpacity === 'number') setTerminalOpacity(parsed.terminalOpacity)
          if (typeof parsed.lod === 'boolean') setLodEnabled(parsed.lod)
          if (typeof parsed.follow === 'boolean') setFollow(parsed.follow)
          zTopRef.current = Math.max(1, ...(parsed.items ?? []).map(i => i.z || 1))
        } catch { /* ignore malformed */ }
      }
      setLoaded(true)
    }).catch(() => setLoaded(true))
    return () => { cancelled = true }
  }, [workspace?.id])

  // ── Reconcile terminal items with the live pane tree ──
  // Every leaf gets exactly one terminal card; cards for closed panes are pruned.
  useEffect(() => {
    if (!loaded) return
    setItems(prev => {
      const leafIds = new Set(leaves.map(l => l.id))
      let next = prev.filter(it => it.kind !== 'terminal' || (it.paneId && leafIds.has(it.paneId)))
      const have = new Set(next.filter(it => it.kind === 'terminal').map(it => it.paneId))
      let placed = next.filter(it => it.kind === 'terminal').length
      for (const leaf of leaves) {
        if (have.has(leaf.id)) continue
        const col = placed % 3
        const row = Math.floor(placed / 3)
        zTopRef.current += 1
        next = [...next, {
          id: uuidv4(), kind: 'terminal', paneId: leaf.id,
          x: 60 + col * 540, y: 60 + row * 400, w: 500, h: 340, z: zTopRef.current,
        }]
        placed += 1
      }
      return next
    })
  }, [leaves, loaded])

  // ── Persist (debounced) ──
  useEffect(() => {
    if (!workspace || !loaded) return
    const id = setTimeout(() => {
      const payload: PersistShape = { items, connectors, camera, background, rail: railPos, railCollapsed, minimap: minimapPos, terminalOpacity, lod: lodEnabled, follow }
      window.swarmmind.setAppSetting(`canvas:${workspace.id}`, JSON.stringify(payload)).catch(() => {})
    }, 600)
    return () => clearTimeout(id)
  }, [items, connectors, camera, background, railPos, railCollapsed, minimapPos, terminalOpacity, lodEnabled, follow, workspace?.id, loaded])

  // Prune connectors whose endpoints no longer exist.
  useEffect(() => {
    if (!loaded) return
    setConnectors(prev => {
      const ids = new Set(items.map(i => i.id))
      const next = prev.filter(c => ids.has(c.from) && ids.has(c.to))
      return next.length === prev.length ? prev : next
    })
  }, [items, loaded])

  // ── Publish the terminal↔terminal arrows as live message routes ──
  // The board owns the drawing; `useRoutes` (mounted in App.tsx) owns the
  // delivery, because this component unmounts on every view switch and wiring
  // that only worked while you were looking at it would be a trap. `deriveRoutes`
  // ignores everything that isn't a terminal→terminal arrow, so an image handoff
  // or a task dependency drawn with the same tool stays what it was.
  useEffect(() => {
    if (!loaded) return
    setPaneRoutes(deriveRoutes(items, connectors))
  }, [items, connectors, loaded, setPaneRoutes])

  // Note there is deliberately no unmount cleanup here. This component unmounts
  // on every view switch, and clearing the published routes there would undo the
  // entire reason delivery lives in App.tsx — the wiring would only work while
  // you happened to be looking at the picture of it. A workspace switch clears
  // them instead (`setWorkspace` in the store), which is the only moment the
  // pane pairs actually stop meaning anything.

  // ── Semantic zoom: cross the hysteresis band, not a single threshold ──
  useEffect(() => {
    if (!lodEnabled) { setTileMode(false); return }
    setTileMode(prev => isTileZoom(camera.zoom, prev))
  }, [camera.zoom, lodEnabled])

  // ── Coordinate helpers ──
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const cam = cameraRef.current
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    return { x: (sx - left - cam.x) / cam.zoom, y: (sy - top - cam.y) / cam.zoom }
  }, [])

  // Frames are excluded here (and from send-to-back): a frame is the backdrop
  // its contents sit on, so raising one above them — which selecting, dragging
  // or resizing it would otherwise do on every gesture — would hide the cards it
  // was drawn around behind their own container.
  const bringToFront = useCallback((id: string) => {
    zTopRef.current += 1
    const z = zTopRef.current
    setItems(prev => prev.map(it => (it.id === id && !isFrameKind(it.kind)) ? { ...it, z } : it))
  }, [])

  // ── Selection helpers ──
  // Everything that used to say "the selected item" goes through these, so a
  // one-item selection and a marquee'd set of twelve take the same code path.
  const selectOnly = useCallback((id: string | null) => setSelectedIds(id ? [id] : []), [])
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id])
  }, [])
  const clearSelection = useCallback(() => { setSelectedIds([]); setSelectedConnectorId(null) }, [])
  // Right-clicking inside a multi-selection must not collapse it to the one
  // card under the cursor — the menu is how you act on the set you just made.
  const selectForMenu = useCallback((id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev : [id])
  }, [])

  // ── Jumping the camera to a card ──
  // Declared up here rather than beside the attention logic that computes its
  // argument, because the keyboard effect (J) needs it in a dependency array and
  // a `const` referenced before its declaration is a TDZ crash, not a warning.
  // The target id rides in a ref for the same reason.
  const attentionRef = useRef<string | null>(null)
  const jumpToCard = useCallback((cardId: string) => {
    const card = itemsRef.current.find(i => i.id === cardId)
    const rect = rootRef.current?.getBoundingClientRect()
    if (!card || !rect) return
    setCamera(cameraToCenter(card, { w: rect.width, h: rect.height }, cameraRef.current.zoom))
    selectOnly(cardId)
  }, [selectOnly])

  // ── Create an item ──
  const addItem = useCallback((partial: Omit<CanvasItem, 'id' | 'z' | 'x' | 'y'>, wx: number, wy: number) => {
    zTopRef.current += 1
    const item: CanvasItem = {
      id: uuidv4(), z: zTopRef.current,
      x: Math.round(wx - partial.w / 2), y: Math.round(wy - partial.h / 2),
      ...partial,
    }
    setItems(prev => [...prev, item])
    selectOnly(item.id)
  }, [selectOnly])

  const addTerminal = useCallback((wx: number, wy: number) => {
    const before = new Set(getLeafIds())
    addPane()
    // addPane is a synchronous zustand set, so the new leaf id is available now.
    const after = getLeafIds()
    const newId = after.find(id => !before.has(id))
    if (!newId) return
    zTopRef.current += 1
    setItems(prev => [...prev, {
      id: uuidv4(), kind: 'terminal', paneId: newId,
      x: Math.round(wx - 250), y: Math.round(wy - 30), w: 500, h: 340, z: zTopRef.current,
    }])
  }, [addPane, getLeafIds])

  // Drop a device mockup (defaults to the standard phone, portrait, localhost).
  const addDevice = useCallback((wx: number, wy: number) => {
    const preset = getPreset(DEFAULT_DEVICE)
    const size = deviceCardSize(preset, 'portrait')
    addItem({ kind: 'device', device: DEFAULT_DEVICE, orientation: 'portrait', url: 'http://localhost:3000', w: size.w, h: size.h }, wx, wy)
  }, [addItem])

  // ── Frames ────────────────────────────────────────────────────────────────
  // A named region that owns what's inside it. Two things make it more than a
  // rectangle: dragging it takes its contents along (so "the auth work" moves as
  // one), and it knows which *panes* are inside, so one instruction can go to
  // all of them without hand-picking panes in the broadcast bar every time.
  //
  // Frames don't go through `addItem`: they must sit *behind* every other card
  // (FRAME_Z) rather than on top of the z-stack like everything else, or a new
  // frame would cover the cards it was drawn around.
  const addFrame = useCallback((wx: number, wy: number) => {
    const existing = itemsRef.current.filter(i => isFrameKind(i.kind))
    const w = 720, h = 520
    const id = uuidv4()
    setItems(prev => [...prev, {
      id, kind: 'frame',
      x: Math.round(wx - w / 2), y: Math.round(wy - h / 2), w, h, z: FRAME_Z,
      text: nextFrameName(existing.map(f => f.text ?? ''), t('canvas.frame.defaultName')),
      color: nextFrameColor(existing.length),
    }])
    selectOnly(id)
  }, [t, selectOnly])

  // Every id a frame drag has to carry: the frame plus whatever sits inside it.
  // Resolved at pointer-down from the live mirror, because a card that leaves
  // the frame *during* the drag must not be dropped mid-gesture.
  const expandFrameGroup = useCallback((ids: string[]): string[] => {
    const its = itemsRef.current
    const out = new Set(ids)
    for (const id of ids) {
      const f = its.find(i => i.id === id)
      if (!f || !isFrameKind(f.kind)) continue
      for (const childId of frameChildren(f, its)) out.add(childId)
    }
    return [...out]
  }, [])

  const openFrameBroadcast = useCallback((frameId: string) => {
    setMenu(null)
    const frame = itemsRef.current.find(i => i.id === frameId)
    if (!frame) return
    const panes = framePanes(frame, itemsRef.current)
      .filter(paneId => findLeaf(rootPane, paneId)?.ptyStatus === 'running')
    if (panes.length === 0) { setToast(t('canvas.frame.noAgents')); return }
    setFrameSend({ frameId, label: frame.text?.trim() || t('canvas.frame.defaultName'), panes })
  }, [rootPane, t])

  const sendToFrame = useCallback((panes: string[], text: string) => {
    const body = text.trim()
    if (!body) return
    for (const paneId of panes) {
      window.swarmmind.ptyInput(paneId, body)
      window.swarmmind.ptyInput(paneId, '\r')
    }
    setToast(t('canvas.frame.sent', { n: panes.length }))
  }, [t])

  const selectFrameContents = useCallback((frameId: string) => {
    setMenu(null)
    const frame = itemsRef.current.find(i => i.id === frameId)
    if (!frame) return
    const kids = frameChildren(frame, itemsRef.current)
    if (kids.length === 0) { setToast(t('canvas.frame.empty')); return }
    setSelectedIds(kids)
  }, [t])

  // ── Task cards (visual orchestrator) ──
  // Task cards are the board's live window onto the tasks table: creating one
  // inserts a real row, dragging it onto a terminal sets assigned_agent, and an
  // arrow between two of them writes depends_on — all fields the conductor
  // already dispatches on. Handlers live here (above the pointer/drag handlers
  // that call them) so the closures resolve in lexical order.
  const refreshTasks = useCallback(async () => {
    try {
      const list = await window.swarmmind.taskList() as KanbanTask[]
      setTasks(list ?? [])
    } catch { /* best-effort */ }
  }, [])

  // Poll while the canvas is open so status/assignment injected by the swarm
  // (or the Kanban board) show live on the cards.
  useEffect(() => {
    if (!loaded) return
    refreshTasks()
    const id = setInterval(refreshTasks, 2000)
    return () => clearInterval(id)
  }, [loaded, refreshTasks, workspace?.id])

  // Prune task cards whose backing row was deleted elsewhere (Kanban, an agent).
  useEffect(() => {
    if (!loaded || !tasks.length) return
    const live = new Set(tasks.map(tk => tk.id))
    setItems(prev => {
      const next = prev.filter(it => it.kind !== 'task' || (it.taskId && live.has(it.taskId)))
      return next.length === prev.length ? prev : next
    })
  }, [tasks, loaded])

  const addTask = useCallback(async (wx: number, wy: number) => {
    const created = await window.swarmmind.taskCreate(t('canvas.task.newTitle')) as KanbanTask | null
    if (!created?.id) { setToast(t('canvas.task.createFailed')); return }
    await refreshTasks()
    zTopRef.current += 1
    const w = 240, h = 132
    const cardId = uuidv4()
    setItems(prev => [...prev, {
      id: cardId, kind: 'task', taskId: created.id,
      x: Math.round(wx - w / 2), y: Math.round(wy - h / 2), w, h, z: zTopRef.current,
    }])
    selectOnly(cardId)
  }, [t, refreshTasks, selectOnly])

  const assignTask = useCallback(async (taskId: string, agentId: string | null, agentLabel: string) => {
    await window.swarmmind.taskEdit(taskId, { assigned_agent: agentId })
    await refreshTasks()
    if (agentId) setToast(t('canvas.task.assigned', { agent: agentLabel }))
  }, [t, refreshTasks])

  const setTaskStatus = useCallback(async (taskId: string, status: string) => {
    await window.swarmmind.taskUpdate(taskId, status)
    await refreshTasks()
  }, [refreshTasks])

  const renameTask = useCallback(async (taskId: string, title: string) => {
    const clean = title.trim()
    if (!clean) return
    // Optimistic: reflect the new title immediately, then persist.
    setTasks(prev => prev.map(tk => tk.id === taskId ? { ...tk, title: clean } : tk))
    await window.swarmmind.taskEdit(taskId, { title: clean })
    await refreshTasks()
  }, [refreshTasks])

  const deleteTask = useCallback(async (item: CanvasItem) => {
    setMenu(null)
    if (item.taskId) {
      const ok = await confirmDialog({
        title: tasksRef.current.find(tk => tk.id === item.taskId)?.title || t('canvas.task.newTitle'),
        body: t('canvas.task.deleteConfirm'),
        confirmLabel: t('canvas.ctx.delete'),
        danger: true,
      })
      if (!ok) return
      await window.swarmmind.taskDelete(item.taskId)
      await refreshTasks()
    }
    setItems(prev => prev.filter(i => i.id !== item.id))
  }, [t, refreshTasks])

  // Turn a sticky note (or a text label) into a real task, in place.
  //
  // This is how people actually use a board — scribble first, formalise later —
  // and until now the second half meant retyping the note into a task card. The
  // note is *replaced* rather than left behind: two objects saying the same
  // thing, one of them backed by the tasks table and one not, is precisely the
  // ambiguity the board is supposed to remove. The card takes the note's own
  // position so nothing you arranged moves.
  const noteToTask = useCallback(async (item: CanvasItem) => {
    setMenu(null)
    const title = (item.text ?? '').trim()
    if (!title) { setToast(t('canvas.note.empty')); return }
    // A note can hold a paragraph; a task title is one line. The first line
    // becomes the title and the rest is kept as the task's description.
    const [first, ...rest] = title.split('\n')
    const created = await window.swarmmind.taskCreate(first.trim() || title) as KanbanTask | null
    if (!created?.id) { setToast(t('canvas.task.createFailed')); return }
    const body = rest.join('\n').trim()
    if (body) await window.swarmmind.taskEdit(created.id, { description: body })
    await refreshTasks()
    zTopRef.current += 1
    const cardId = uuidv4()
    const z = zTopRef.current
    setItems(prev => [
      ...prev.filter(i => i.id !== item.id),
      { id: cardId, kind: 'task', taskId: created.id, x: item.x, y: item.y, w: Math.max(220, Math.min(item.w, 320)), h: Math.max(132, Math.min(item.h, 220)), z },
    ])
    selectOnly(cardId)
    setToast(t('canvas.note.converted'))
  }, [t, refreshTasks, selectOnly])

  // ── Race mode, on the board ──────────────────────────────────────────────
  // Best-of-N is a spatial idea: three attempts at the same task, side by side,
  // pick one. It shipped as a panel; here it runs where the agents already are.
  // The framing (goal + who is racing) lives in the *store*, shared with
  // RacePanel, so starting a race here and resolving it there is one race and
  // not two views disagreeing about who was in it.
  //
  // Everything this needs is reused: `race.ts` decides eligibility, what each
  // racer is told and what happens to the losing branches; the git calls are the
  // same ones the panel makes.
  const paneOfItem = useCallback((item: CanvasItem): RacePane | null => {
    if (item.kind !== 'terminal' || !item.paneId) return null
    const leaf = findLeaf(rootPane, item.paneId)
    if (!leaf) return null
    return {
      paneId: leaf.id,
      agentId: leaf.agentId,
      title: leaf.title?.trim() || leaf.agentId || leaf.id.slice(0, 6),
      branch: leaf.worktreeBranch ?? null,
      worktreePath: leaf.worktreePath ?? null,
      running: leaf.ptyStatus === 'running',
    }
  }, [rootPane])

  const racers = useMemo(
    () => items.map(paneOfItem).filter((p): p is RacePane => !!p && racePaneIds.includes(p.paneId)),
    [items, paneOfItem, racePaneIds],
  )
  const racersRef = useRef(racers)
  racersRef.current = racers

  useEffect(() => {
    const root = workspace?.rootPath
    if (root) void window.swarmmind.gitBaseBranch(root).then(setRaceBase).catch(() => {})
  }, [workspace?.rootPath])

  // Poll each attempt's diff stat while a race is on. Attempts land over
  // minutes, so the comparison has to keep itself current; the interval only
  // exists while there is something to compare.
  useEffect(() => {
    const root = workspace?.rootPath
    if (!root || racers.length === 0) { setRaceStats({}); return }
    let cancelled = false
    const refresh = async () => {
      const live = racersRef.current.filter(r => r.worktreePath)
      const entries = await Promise.all(live.map(async r => {
        try {
          const st = await window.swarmmind.gitWorktreeDiffStat(root, r.worktreePath!, raceBase || undefined)
          return [r.paneId, {
            files: st.files.map(f => f.path),
            additions: st.files.reduce((s, f) => s + f.additions, 0),
            deletions: st.files.reduce((s, f) => s + f.deletions, 0),
          }] as const
        } catch { return null }
      }))
      if (cancelled) return
      setRaceStats(Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => !!e)))
    }
    void refresh()
    const id = setInterval(() => { void refresh() }, 4000)
    return () => { cancelled = true; clearInterval(id) }
  }, [workspace?.rootPath, raceBase, racers.length])

  // Open the race composer for the current selection. Ineligible panes are named
  // with their reason rather than silently dropped — "my terminal isn't in the
  // race" is otherwise unexplainable, and the worktree rule is the whole reason
  // the attempts stay comparable in the first place.
  const openRaceSetup = useCallback((ids: string[]) => {
    setMenu(null)
    const picked = itemsRef.current.filter(i => ids.includes(i.id)).map(paneOfItem).filter((p): p is RacePane => !!p)
    const { eligible, ineligible } = raceEligibility(picked)
    if (eligible.length < 2) {
      setToast(ineligible.length
        ? t('canvas.race.ineligible', {
            list: ineligible.map(x => `${x.pane.title} (${x.reason === 'no-worktree' ? t('race.needsWorktree') : t('race.needsRunning')})`).join(', '),
          })
        : t('canvas.race.needTwo'))
      return
    }
    setRaceSetup({ panes: eligible })
  }, [paneOfItem, t])

  const startRace = useCallback((panes: RacePane[], goal: string) => {
    setRaceSetup(null)
    if (!canStartRace(panes.map(p => p.paneId), goal)) return
    setRaceGoal(goal)
    setRacePaneIds(panes.map(p => p.paneId))
    panes.forEach((p, i) => {
      window.swarmmind.ptyInput(p.paneId, buildRacePrompt(goal, i + 1, panes.length))
      window.swarmmind.ptyInput(p.paneId, '\r')
    })
    setToast(t('race.started', { n: String(panes.length) }))
  }, [setRaceGoal, setRacePaneIds, t])

  // Keep one attempt: merge its branch into base, then tear the others down.
  // Nothing is discarded when the merge fails — losing every attempt *and* not
  // having the winner is the worst outcome available here.
  const keepRaceWinner = useCallback(async (paneId: string) => {
    const root = workspace?.rootPath
    if (!root) return
    const plan = planWinner(racersRef.current, paneId)
    if (!plan) { setToast(t('race.winnerGone')); return }
    const ok = await confirmDialog({
      body: t('race.keepConfirm', { branch: plan.keep.branch, base: raceBase, n: String(plan.discard.length) }),
      confirmLabel: t('race.keepConfirmAction'),
      danger: true,
    })
    if (!ok) return
    setRaceBusy(true)
    const merged = await window.swarmmind.gitMergeBranch(root, plan.keep.branch)
    if (!merged.ok) {
      setRaceBusy(false)
      setToast(t('race.mergeFailed', { error: merged.error }))
      return
    }
    let dropped = 0
    for (const loser of plan.discard) {
      const res = await window.swarmmind.gitRemoveWorktree(root, loser.worktreePath, loser.branch, true)
      if (!('error' in res)) dropped++
    }
    setRaceBusy(false)
    setRacePaneIds([])
    setToast(t('race.kept', { branch: plan.keep.branch, n: String(dropped) }))
  }, [workspace?.rootPath, raceBase, setRacePaneIds, t])

  const endRace = useCallback(() => {
    setRacePaneIds([])
    setToast(t('canvas.race.ended'))
  }, [setRacePaneIds, t])

  // ── Canvas background pointer: pan or place ──
  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return  // only when hitting empty canvas
    if (e.button !== 0 && e.button !== 1) return  // right-click → context menu
    setBgPickerOpen(false)
    setMenu(null)
    const panning = tool === 'hand' || spaceDown || e.button === 1
    if (panning) {
      clearSelection()
      // Pan the camera.
      const startX = e.clientX, startY = e.clientY
      const orig = { ...cameraRef.current }
      setInteracting('grabbing')
      startPointerDrag(
        (ev) => {
          setCamera({ ...orig, x: orig.x + (ev.clientX - startX), y: orig.y + (ev.clientY - startY) })
        },
        () => setInteracting(false),
      )
      return
    }
    // ── Marquee (box) select ──
    // With the select tool, dragging bare board draws a selection box rather
    // than panning — the Figma/Miro convention, and the only gesture left that
    // can mean "these ones". Panning keeps three ways in (H, hold Space,
    // middle-drag) plus the wheel, so nothing is lost.
    if (tool === 'select') {
      // Focus mode places cards in screen space against a frozen camera, so a
      // world-space box would select things that aren't where it was drawn.
      if (focusedRef.current) { clearSelection(); return }
      const board = rootRef.current?.getBoundingClientRect()
      // Shift keeps what's already selected, so a selection can be built up out
      // of several sweeps around the cards you don't want.
      const additive = e.shiftKey
      const base = additive ? selectedIdsRef.current : []
      if (!additive) clearSelection()
      const ax = e.clientX, ay = e.clientY
      const aw = screenToWorld(ax, ay)
      setInteracting('crosshair')
      startPointerDrag(
        (ev) => {
          const box = normalizeRect(ax, ay, ev.clientX, ev.clientY)
          setMarquee({ x: box.x - (board?.left ?? 0), y: box.y - (board?.top ?? 0), w: box.w, h: box.h })
          const bw = screenToWorld(ev.clientX, ev.clientY)
          const hits = marqueeHits(itemsRef.current, normalizeRect(aw.x, aw.y, bw.x, bw.y))
          setSelectedIds(additive ? [...new Set([...base, ...hits])] : hits)
        },
        () => {
          setMarquee(null)
          setInteracting(false)
        },
      )
      return
    }
    // A creation tool is active → place at the click position, then revert.
    const { x, y } = screenToWorld(e.clientX, e.clientY)
    if (tool === 'terminal') addTerminal(x, y)
    else if (tool === 'browser') addItem({ kind: 'browser', w: 640, h: 460, url: 'http://localhost:3000' }, x, y)
    else if (tool === 'device') addDevice(x, y)
    else if (tool === 'note') addItem({ kind: 'note', w: 220, h: 200, text: '', color: NOTE_COLORS[0] }, x, y)
    else if (tool === 'text') addItem({ kind: 'text', w: 260, h: 60, text: '', color: 'var(--text-primary)' }, x, y)
    else if (tool === 'task') void addTask(x, y)
    else if (tool === 'frame') addFrame(x, y)
    else if (tool === 'rect') addItem({ kind: 'shape', shape: 'rect', w: 220, h: 150, color: 'var(--accent)' }, x, y)
    else if (tool === 'ellipse') addItem({ kind: 'shape', shape: 'ellipse', w: 200, h: 200, color: '#7fb0e8' }, x, y)
    else if (tool === 'triangle') addItem({ kind: 'shape', shape: 'triangle', w: 220, h: 190, color: '#7fc8a0' }, x, y)
    else if (tool === 'image') { pendingImgPos.current = { x, y }; fileInputRef.current?.click() }
    setTool('select')
  }, [tool, spaceDown, screenToWorld, addItem, addTerminal, addDevice, addTask, addFrame, clearSelection])

  // ── Drag / resize an item ──
  const startDrag = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.button !== 0) return
    // Shift on a card adds it to (or takes it out of) the selection instead of
    // starting a drag — how you pick up two cards with something between them
    // that a single box would also catch.
    if (e.shiftKey) { toggleSelected(id); setMenu(null); return }
    bringToFront(id)
    setSelectedConnectorId(null)
    setMenu(null)
    // Dragging a card that's part of a multi-selection moves the whole set;
    // grabbing anything else selects just that card first (Figma/Miro). Without
    // the first half, the only way to move a marquee'd group would be one card
    // at a time — which is the whole point of having selected them together.
    const selection = selectedIdsRef.current
    const picked = selection.includes(id) && selection.length > 1 ? selection : [id]
    if (picked.length === 1) selectOnly(id)
    // A frame carries its contents. Resolved here, at pointer-down, from the
    // live mirror: the membership test is "is the card's centre inside the
    // frame", and re-running it per frame would drop a card the moment the drag
    // pushed it over the edge — the group would shed cards as it moved.
    const group = expandFrameGroup(picked)
    const zoom = cameraRef.current.zoom
    const it = itemsRef.current.find(i => i.id === id)
    if (!it || it.locked) return
    // Focus mode places cards by computed geometry, so dragging one would edit
    // a position nothing is reading — and would silently move the card on the
    // board underneath.
    if (focusedRef.current) return
    const startX = e.clientX, startY = e.clientY
    // Starting positions for everything that will move. A locked card inside
    // the selection stays put rather than blocking the drag.
    const origins = new Map(
      itemsRef.current.filter(i => group.includes(i.id) && !i.locked).map(i => [i.id, { x: i.x, y: i.y }]),
    )
    let moved = false
    setInteracting('grabbing')
    startPointerDrag(
      (ev) => {
        moved = true
        // One delta for the whole group, snapped against the grabbed card — see
        // dragDelta: snapping each card on its own would change their spacing.
        const { dx, dy } = dragDelta(
          { x: it.x, y: it.y },
          (ev.clientX - startX) / zoom,
          (ev.clientY - startY) / zoom,
          snapRef.current ? GRID : null,
        )
        setItems(prev => {
          // Two levels of bail-out, both load-bearing for a smooth drag. Per
          // item: an unchanged card keeps its object identity so the memoised
          // CanvasCard skips re-rendering its live terminal. For the array:
          // returning `prev` unchanged makes React skip the render entirely —
          // which is most frames when snap is on, since a 20px grid means the
          // pointer usually moves without the cards moving at all.
          let changed = false
          const next = prev.map(i => {
            const o = origins.get(i.id)
            if (!o) return i
            const nx = o.x + dx, ny = o.y + dy
            if (i.x === nx && i.y === ny) return i
            changed = true
            return { ...i, x: nx, y: ny }
          })
          return changed ? next : prev
        })
      },
      (ev) => {
        setInteracting(false)
        // Drop a task card onto a terminal → assign it to that pane's agent.
        // The delightful path; the context menu is the discoverable one.
        if (moved && it.kind === 'task' && it.taskId) {
          const wp = screenToWorld(ev.clientX, ev.clientY)
          const under = itemsRef.current.find(i =>
            i.id !== id && i.kind === 'terminal' && i.paneId &&
            wp.x >= i.x && wp.x <= i.x + i.w && wp.y >= i.y && wp.y <= i.y + i.h)
          if (under?.paneId) {
            const leaf = findLeaf(useWorkspaceStore.getState().rootPane, under.paneId)
            if (leaf?.agentId) void assignTask(it.taskId, leaf.agentId, leaf.title?.trim() || leaf.agentId)
          }
        }
      },
    )
  }, [bringToFront, screenToWorld, assignTask, selectOnly, toggleSelected, expandFrameGroup])

  // Resize from any of the 8 handles. The dragged edge(s) follow the pointer
  // while the opposite edge stays pinned — so a west/north drag moves x/y as
  // well as w/h. Minimums are enforced against that same anchor, otherwise
  // shrinking past the limit from the west would keep sliding the card left.
  const startResize = useCallback((e: React.PointerEvent, id: string, dir: ResizeDir) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.button !== 0) return
    bringToFront(id)
    selectOnly(id)
    setMenu(null)
    const zoom = cameraRef.current.zoom
    const it = itemsRef.current.find(i => i.id === id)
    if (!it || it.locked || focusedRef.current) return
    const startX = e.clientX, startY = e.clientY
    const orig = { x: it.x, y: it.y, w: it.w, h: it.h }
    setInteracting(RESIZE_CURSOR[dir])
    startPointerDrag(
      (ev) => {
        const next = resizeRect(orig, dir, (ev.clientX - startX) / zoom, (ev.clientY - startY) / zoom, {
          // A frame shrunk to card size stops reading as a container and starts
          // stealing membership from whatever it lands on.
          minW: isFrameKind(it.kind) ? MIN_FRAME_W : MIN_ITEM_W,
          minH: isFrameKind(it.kind) ? MIN_FRAME_H : MIN_ITEM_H,
          grid: snapRef.current ? GRID : null,
        })
        setItems(prev => {
          const cur = prev.find(i => i.id === id)
          if (!cur) return prev
          // Same bail-out as the drag: with snap on, most frames resolve to the
          // geometry the card already has.
          if (cur.x === next.x && cur.y === next.y && cur.w === next.w && cur.h === next.h) return prev
          return prev.map(i => i.id === id ? { ...i, ...next } : i)
        })
      },
      () => setInteracting(false),
    )
  }, [bringToFront, selectOnly])

  // ── Remove items (closing the pane too, for terminals) ──
  // Takes a list because Delete acts on the whole selection; a locked item is
  // skipped rather than blocking the rest of the batch.
  const removeItems = useCallback((ids: string[]) => {
    const doomed = new Set(itemsRef.current.filter(i => ids.includes(i.id) && !i.locked).map(i => i.id))
    if (doomed.size === 0) return
    for (const it of itemsRef.current) {
      if (doomed.has(it.id) && it.kind === 'terminal' && it.paneId) closePane(it.paneId)
    }
    setItems(prev => prev.filter(i => !doomed.has(i.id)))
    setSelectedIds(prev => prev.filter(i => !doomed.has(i)))
    setMaximizedId(m => (m && doomed.has(m) ? null : m))
    setFocusedId(f => (f && doomed.has(f) ? null : f))
  }, [closePane])

  const removeItem = useCallback((id: string) => removeItems([id]), [removeItems])

  const updateItem = useCallback((id: string, patch: Partial<CanvasItem>) => {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it))
  }, [])

  const toggleLock = useCallback((id: string) => {
    setItems(prev => prev.map(it => it.id === id ? { ...it, locked: !it.locked } : it))
  }, [])

  // Lock/unlock a whole selection. Mixed states resolve to "lock everything"
  // (and only an all-locked selection unlocks), so pressing L twice can't leave
  // the set in the flipped-around state a per-item toggle would produce.
  const toggleLockMany = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    const set = new Set(ids)
    const picked = itemsRef.current.filter(i => set.has(i.id))
    const locked = picked.length > 0 && picked.every(i => i.locked)
    setItems(prev => prev.map(it => set.has(it.id) ? { ...it, locked: !locked } : it))
  }, [])

  // Duplicate an item, offset a little. Terminals spawn a fresh pane (you can't
  // clone a live PTY), everything else is a straight copy.
  const duplicateItem = useCallback((id: string) => {
    const it = itemsRef.current.find(i => i.id === id)
    if (!it) return
    if (it.kind === 'terminal') { addTerminal(it.x + 260, it.y + 200); return }
    // A task card is a window onto one DB row — "duplicating" means a *new*
    // task, not a second card pointing at the same row.
    if (it.kind === 'task') { void addTask(it.x + it.w / 2 + 24, it.y + it.h / 2 + 24); return }
    // A duplicated frame is an empty region, not a copy of its contents — and it
    // stays at FRAME_Z with a fresh name, so two frames are never both called
    // "Frame 1" and neither ends up in front of the cards.
    if (isFrameKind(it.kind)) {
      const frames = itemsRef.current.filter(i => isFrameKind(i.kind))
      const dup: CanvasItem = {
        ...it, id: uuidv4(), x: it.x + 32, y: it.y + 32, z: FRAME_Z,
        text: nextFrameName(frames.map(f => f.text ?? ''), t('canvas.frame.defaultName')),
        color: nextFrameColor(frames.length),
      }
      setItems(prev => [...prev, dup])
      selectOnly(dup.id)
      return
    }
    zTopRef.current += 1
    const copy: CanvasItem = { ...it, id: uuidv4(), x: it.x + 24, y: it.y + 24, z: zTopRef.current }
    setItems(prev => [...prev, copy])
    selectOnly(copy.id)
  }, [addTerminal, addTask, selectOnly, t])

  // Make one card's transparency the board default: store it globally and drop
  // every per-card override, so existing AND future terminals all match.
  const applyOpacityToAllTerminals = useCallback((alpha: number) => {
    setTerminalOpacity(alpha)
    setItems(prev => prev.map(i => i.kind === 'terminal' && i.opacity !== undefined
      ? { ...i, opacity: undefined }
      : i))
  }, [])

  // ── Browser tab stacking ──
  // Collapse every browser card on the board into `targetId`, appending their
  // tabs in board order (left-to-right, top-to-bottom) so the result matches
  // what the user saw. The target keeps its geometry; the others are removed.
  const stackBrowsers = useCallback((targetId: string) => {
    setItems(prev => {
      const target = prev.find(i => i.id === targetId)
      if (!target || target.kind !== 'browser') return prev
      const sources = prev
        .filter(i => i.kind === 'browser' && i.id !== targetId)
        .sort((a, b) => (a.y - b.y) || (a.x - b.x))
      if (!sources.length) return prev
      // Tab ids are only unique per card, so incoming ones are re-keyed to
      // avoid collisions. The *target's* ids are kept as-is: they key the
      // mounted webviews, and re-keying them would needlessly reload the page
      // the user is stacking into.
      const kept = browserTabs(target)
      const incoming = sources.flatMap(browserTabs).map(tb => ({ ...tb, id: uuidv4() }))
      const tabs = [...kept, ...incoming]
      const gone = new Set(sources.map(i => i.id))
      // Keep whichever tab was already showing selected.
      const stillActive = activeBrowserTab(target).id
      return prev
        .filter(i => !gone.has(i.id))
        .map(i => i.id === targetId
          ? { ...i, tabs, activeTab: stillActive, url: tabs.find(tb => tb.id === stillActive)?.url ?? i.url }
          : i)
    })
    selectOnly(targetId)
  }, [selectOnly])

  // Explode a stacked browser back into one card per tab, laid out in a row to
  // the right of the original so none of them land on top of each other.
  const unstackBrowser = useCallback((id: string) => {
    setItems(prev => {
      const src = prev.find(i => i.id === id)
      if (!src || src.kind !== 'browser') return prev
      const tabs = browserTabs(src)
      if (tabs.length < 2) return prev
      const rest = tabs.slice(1).map((tb, idx) => {
        zTopRef.current += 1
        return {
          ...src,
          id: uuidv4(),
          x: src.x + (idx + 1) * (src.w + 24),
          y: src.y,
          z: zTopRef.current,
          url: tb.url,
          tabs: undefined,
          activeTab: undefined,
        } as CanvasItem
      })
      return [
        ...prev.map(i => i.id === id ? { ...i, url: tabs[0].url, tabs: undefined, activeTab: undefined } : i),
        ...rest,
      ]
    })
  }, [])

  const sendToBack = useCallback((id: string) => {
    setItems(prev => {
      // Frames already live at FRAME_Z, below everything; pushing a card under
      // one would make it invisible inside its own container.
      const minZ = Math.min(...prev.filter(i => !isFrameKind(i.kind)).map(i => i.z), 1)
      return prev.map(i => (i.id === id && !isFrameKind(i.kind)) ? { ...i, z: minZ - 1 } : i)
    })
  }, [])

  // Frame every item in the viewport (zoom + centre). Empty → reset.
  const zoomToFit = useCallback(() => {
    const its = itemsRef.current
    const rect = rootRef.current?.getBoundingClientRect()
    if (!its.length || !rect) { setCamera(DEFAULT_CAMERA); return }
    const minX = Math.min(...its.map(i => i.x)), minY = Math.min(...its.map(i => i.y))
    const maxX = Math.max(...its.map(i => i.x + i.w)), maxY = Math.max(...its.map(i => i.y + i.h))
    const pad = 90
    const zoom = clamp(Math.min((rect.width - pad * 2) / Math.max(1, maxX - minX), (rect.height - pad * 2) / Math.max(1, maxY - minY)), MIN_ZOOM, MAX_ZOOM)
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    setCamera({ zoom, x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom })
  }, [])

  // Create the item a right-click context menu asked for, at the clicked point.
  const addFromMenu = useCallback((kind: CanvasTool, wx: number, wy: number) => {
    if (kind === 'terminal') addTerminal(wx, wy)
    else if (kind === 'browser') addItem({ kind: 'browser', w: 640, h: 460, url: 'http://localhost:3000' }, wx, wy)
    else if (kind === 'device') addDevice(wx, wy)
    else if (kind === 'note') addItem({ kind: 'note', w: 220, h: 200, text: '', color: NOTE_COLORS[0] }, wx, wy)
    else if (kind === 'text') addItem({ kind: 'text', w: 260, h: 60, text: '', color: 'var(--text-primary)' }, wx, wy)
    else if (kind === 'task') void addTask(wx, wy)
    else if (kind === 'frame') addFrame(wx, wy)
    else if (kind === 'rect') addItem({ kind: 'shape', shape: 'rect', w: 220, h: 150, color: 'var(--accent)' }, wx, wy)
    else if (kind === 'ellipse') addItem({ kind: 'shape', shape: 'ellipse', w: 200, h: 200, color: '#7fb0e8' }, wx, wy)
    else if (kind === 'triangle') addItem({ kind: 'shape', shape: 'triangle', w: 220, h: 190, color: '#7fc8a0' }, wx, wy)
    setMenu(null)
  }, [addTerminal, addItem, addDevice, addTask, addFrame])

  // ── Images (paste / drop / file picker / screenshot capture) ──
  // Insert an image data URL as a canvas item, fitted to a sensible box. When
  // `anchorTop` is set the item's *top* lands at wy (used to drop a capture just
  // below the card it came from); otherwise it's centred on (wx, wy).
  const placeImageSrc = useCallback((src: string, wx: number, wy: number, anchorTop = false) => {
    const img = new Image()
    img.onload = () => {
      const { w, h } = fitBox(img.width, img.height, 420, 360)
      zTopRef.current += 1
      const id = uuidv4()
      setItems(prev => [...prev, {
        id, kind: 'image', src,
        x: Math.round(wx - w / 2), y: Math.round(anchorTop ? wy : wy - h / 2), w, h, z: zTopRef.current,
      }])
      selectOnly(id)
    }
    img.src = src
  }, [selectOnly])

  const addImageFromFile = useCallback((file: File, wx: number, wy: number) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => placeImageSrc(String(reader.result), wx, wy)
    reader.readAsDataURL(file)
  }, [placeImageSrc])

  // A browser/device card was screenshotted → drop the picture just below it so
  // the "capture → scribble → hand off" flow reads top-to-bottom.
  const handleCapture = useCallback((source: CanvasItem, dataUrl: string | null) => {
    if (!dataUrl) { setToast(t('canvas.captureFailed')); return }
    placeImageSrc(dataUrl, source.x + source.w / 2, source.y + source.h + 24, true)
  }, [placeImageSrc, t])

  // Composite the image (+ overlapping annotations), save it under the
  // workspace, then inject a one-line prompt referencing the saved path into the
  // target agent pane — the same PTY-injection the loops/conductor use.
  const sendCaptureToAgent = useCallback(async (imageId: string, paneId: string, agent: string, note: string) => {
    const image = itemsRef.current.find(i => i.id === imageId)
    if (!image?.src) { setToast(t('canvas.captureFailed')); return }
    const composed = await compositeCapture(image, itemsRef.current.filter(i => i.kind === 'draw'))
    const res = await window.swarmmind.canvasSaveCapture(composed)
    if (!res.ok) { setToast(res.error); return }
    const prompt = buildHandoffPrompt(note, res.rel, t('canvas.send.default'))
    window.swarmmind.ptyInput(paneId, prompt)
    window.swarmmind.ptyInput(paneId, '\r')
    setToast(t('canvas.send.sent', { agent }))
  }, [t])

  const viewportCenterWorld = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [screenToWorld])

  const openImagePicker = useCallback(() => {
    pendingImgPos.current = viewportCenterWorld()
    fileInputRef.current?.click()
  }, [viewportCenterWorld])

  // ── Connectors ──
  const hitTestItem = useCallback((wx: number, wy: number): CanvasItem | null => {
    const hits = itemsRef.current.filter(i => i.kind !== 'draw' && wx >= i.x && wx <= i.x + i.w && wy >= i.y && wy <= i.y + i.h)
    if (!hits.length) return null
    return hits.reduce((a, b) => (b.z > a.z ? b : a))
  }, [])

  // A connector between two *task* cards is a real dependency: source → target
  // means "target depends_on source", which is exactly what the conductor
  // dispatches on. So drawing the arrow writes to the tasks table.
  const wireDependency = useCallback(async (fromItemId: string, toItemId: string) => {
    const its = itemsRef.current
    const from = its.find(i => i.id === fromItemId)
    const to = its.find(i => i.id === toItemId)
    if (from?.kind !== 'task' || to?.kind !== 'task' || !from.taskId || !to.taskId) return
    const depsOf = (id: string) => parseDeps(tasksRef.current.find(tk => tk.id === id)?.depends_on)
    if (wouldCycle(to.taskId, from.taskId, depsOf)) { setToast(t('canvas.task.cycle')); return }
    const current = tasksRef.current.find(tk => tk.id === to.taskId)?.depends_on ?? null
    const next = addDep(current, from.taskId, to.taskId)
    if (next === current) return
    await window.swarmmind.taskEdit(to.taskId, { depends_on: next ? next.split(',') : [] })
    await refreshTasks()
    setToast(t('canvas.task.depAdded'))
  }, [t, refreshTasks])

  const onConnectPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const wp = screenToWorld(e.clientX, e.clientY)
    const hit = hitTestItem(wp.x, wp.y)
    setConnectFrom(prev => {
      if (!hit) return null
      if (!prev) return hit.id
      if (prev === hit.id) return prev
      setConnectors(cs => [...cs, { id: uuidv4(), from: prev, to: hit.id }])
      void wireDependency(prev, hit.id)
      return null
    })
    setConnectPointer(null)
  }, [screenToWorld, hitTestItem, wireDependency])

  const removeConnector = useCallback((id: string) => {
    // If this arrow encoded a task dependency, drop it from the DB too.
    const conn = connectorsRef.current.find(c => c.id === id)
    setConnectors(prev => prev.filter(c => c.id !== id))
    setSelectedConnectorId(sel => (sel === id ? null : sel))
    if (conn) {
      const its = itemsRef.current
      const from = its.find(i => i.id === conn.from)
      const to = its.find(i => i.id === conn.to)
      if (from?.kind === 'task' && to?.kind === 'task' && from.taskId && to.taskId) {
        const current = tasksRef.current.find(tk => tk.id === to.taskId)?.depends_on ?? null
        const next = removeDep(current, from.taskId)
        if (next !== current) {
          void window.swarmmind.taskEdit(to.taskId, { depends_on: next ? next.split(',') : [] }).then(refreshTasks)
        }
      }
    }
  }, [refreshTasks])

  // ── Freehand pen ──
  // A full-canvas capture layer (only mounted while the pen tool is active) feeds
  // strokes here so you can draw over anything, including cards.
  const startDraw = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    setMenu(null)
    const pts: { x: number; y: number }[] = [screenToWorld(e.clientX, e.clientY)]
    setDraft(pts)
    setInteracting('grabbing')
    startPointerDrag(
      (ev) => {
        // Every coalesced position, not just the one the frame delivered — the
        // dropped ones are the difference between a smooth curve and a polygon.
        for (const p of coalescedPoints(ev)) pts.push(screenToWorld(p.clientX, p.clientY))
        setDraft(pts.slice())
      },
      () => finish(),
    )
    function finish() {
      setInteracting(false)
      setDraft(null)
      if (pts.length < 2) return
      // Folded rather than spread into Math.min/max: collecting every coalesced
      // position makes long strokes several times denser, and `Math.min(...pts)`
      // throws once the array outgrows the argument limit.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const p of pts) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
      const rel = pts.map(p => ({ x: Math.round((p.x - minX) * 100) / 100, y: Math.round((p.y - minY) * 100) / 100 }))
      const { color, width } = penRef.current
      zTopRef.current += 1
      setItems(prev => [...prev, {
        id: uuidv4(), kind: 'draw',
        x: Math.round(minX), y: Math.round(minY),
        w: Math.max(1, Math.round(maxX - minX)), h: Math.max(1, Math.round(maxY - minY)),
        z: zTopRef.current, points: rel, color, strokeWidth: width,
      }])
    }
  }, [screenToWorld])

  // ── Eraser ──
  // Swipe to remove annotation: whole strokes (tested against the real path, so
  // erasing inside the open loop of a drawn circle doesn't delete it), notes,
  // text, shapes and images. Terminals, browsers, devices and task cards are
  // immune — those are a live pty, page state and a row in the tasks table, and
  // losing one to a stray swipe isn't an "oops, redraw it". The rules live in
  // `canvasLayout.ts::eraserHits`.
  const startErase = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    setMenu(null)
    const erased: CanvasItem[] = []
    // What this swipe has already taken, tracked locally because `itemsRef` only
    // catches up after React re-renders. Several hit-tests now run before a
    // single commit, so without this an item swiped across would be collected
    // (and reported, and restored by Ctrl+Z) more than once.
    const gone = new Set<string>()
    let blockedByProtected = false

    const eraseAt = (sx: number, sy: number) => {
      const p = screenToWorld(sx, sy)
      const r = ERASER_RADIUS / cameraRef.current.zoom
      const hits = itemsRef.current.filter(i => !gone.has(i.id) && eraserHits(i, p.x, p.y, r))
      if (!hits.length) {
        // Nothing erasable under the cursor, but something protected is: worth
        // saying once, so "the eraser is broken" never becomes the conclusion.
        blockedByProtected ||= itemsRef.current.some(i =>
          !isErasableKind(i.kind) && p.x >= i.x && p.x <= i.x + i.w && p.y >= i.y && p.y <= i.y + i.h)
        return
      }
      for (const h of hits) { gone.add(h.id); erased.push(h) }
    }

    const commit = () => {
      if (!gone.size) return
      setItems(prev => prev.some(i => gone.has(i.id)) ? prev.filter(i => !gone.has(i.id)) : prev)
    }

    setInteracting('none')
    eraseAt(e.clientX, e.clientY)
    commit()
    startPointerDrag(
      (ev) => {
        setEraserAt({ x: ev.clientX, y: ev.clientY })
        // Hit-test every intermediate position — a fast swipe would otherwise
        // jump clean over a small stroke between two frames — but remove them
        // in one state commit.
        for (const p of coalescedPoints(ev)) eraseAt(p.clientX, p.clientY)
        commit()
      },
      () => {
        setInteracting(false)
        if (erased.length) {
          lastErasedRef.current = erased
          setToast(t('canvas.erase.done', { n: erased.length }))
        } else if (blockedByProtected) {
          setToast(t('canvas.erase.protected'))
        }
      },
    )
  }, [screenToWorld, t])

  // Put back everything the last eraser pass removed (Ctrl+Z).
  const undoErase = useCallback(() => {
    const back = lastErasedRef.current
    if (!back.length) return
    lastErasedRef.current = []
    setItems(prev => {
      const have = new Set(prev.map(i => i.id))
      return [...prev, ...back.filter(i => !have.has(i.id))]
    })
    setToast(t('canvas.erase.undone', { n: back.length }))
  }, [t])

  // ── Arrange ──
  // Two different wishes, so two commands: "align" quantises what's already
  // there onto the grid (positions AND sizes — a 503px-wide card never looks
  // aligned however well its corner sits), while "tidy" reflows everything into
  // an even grid, keeping each card's size and its reading order.
  // Both arrange commands leave frames and everything inside them alone. A frame
  // *is* an arrangement the user made deliberately, and reflowing its contents
  // into a global grid would march them straight out of the region that gives
  // them their meaning. Tidy arranges the loose cards; frames arrange their own.
  const inAnyFrame = useCallback((): Set<string> => {
    const its = itemsRef.current
    const out = new Set<string>()
    for (const f of its) {
      if (!isFrameKind(f.kind)) continue
      out.add(f.id)
      for (const child of frameChildren(f, its)) out.add(child)
    }
    return out
  }, [])

  const alignAllToGrid = useCallback(() => {
    const framed = inAnyFrame()
    const rects = snapAll(itemsRef.current.filter(i => i.kind !== 'draw' && !i.locked && !framed.has(i.id)), GRID)
    if (rects.size === 0) { setToast(t('canvas.arrange.nothing')); return }
    setItems(prev => prev.map(i => {
      const r = rects.get(i.id)
      return r ? { ...i, ...r } : i
    }))
    setSnap(true)
    setToast(t('canvas.arrange.aligned', { n: rects.size }))
  }, [t, inAnyFrame])

  const tidyBoard = useCallback(() => {
    // Freehand strokes are annotation *of* the cards; reflowing them into the
    // grid would scatter every scribble away from what it points at.
    const framed = inAnyFrame()
    const movable = itemsRef.current.filter(i => i.kind !== 'draw' && !i.locked && !framed.has(i.id))
    if (movable.length === 0) { setToast(t('canvas.arrange.nothing')); return }
    const pos = tidyGrid(movable, GRID)
    setItems(prev => prev.map(i => {
      const p = pos.get(i.id)
      return p ? { ...i, ...p } : i
    }))
    setToast(t('canvas.arrange.tidied', { n: pos.size }))
  }, [t, inAnyFrame])

  // ── Focus mode ──
  // Enter on a terminal card: it takes the stage, the other terminals queue up
  // the right-hand edge, everything else steps out of the way. Cards are never
  // unmounted to do this (that would rebuild the xterm and drop the pane's
  // scrollback) — only their geometry is overridden, exactly like maximize.
  const focusTerminal = useCallback((itemId: string | null) => {
    setFocusedId(prev => {
      const next = prev === itemId ? null : itemId
      if (next) { setMaximizedId(null); setTool('select') }
      return next
    })
  }, [])

  // ── Stable per-card handlers ──
  // These used to be written inline in the items.map below, which handed every
  // card a fresh function on every render and made memoising the cards pointless
  // — the props never compared equal, so a drag re-rendered every board card and
  // with them every live terminal. They all take the item id (or the item), so
  // hoisting them costs nothing but makes CanvasCard's memo actually bail out.
  const handleCardSelect = useCallback((id: string, additive: boolean) => {
    if (additive) { toggleSelected(id); return }
    selectOnly(id); bringToFront(id)
  }, [toggleSelected, selectOnly, bringToFront])

  const handleCardMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    selectForMenu(id)
    setMenu({ x: e.clientX, y: e.clientY, wx: 0, wy: 0, itemId: id })
  }, [selectForMenu])

  const handleCardMaximize = useCallback((id: string) => {
    setMaximizedId(m => (m === id ? null : id))
  }, [])

  // A focused card whose pane was closed elsewhere leaves focus mode showing an
  // empty stage, so drop out of it.
  useEffect(() => {
    if (focusedId && !items.some(i => i.id === focusedId && i.kind === 'terminal')) setFocusedId(null)
  }, [items, focusedId])

  // ── Wheel: ctrl/cmd = zoom to cursor, otherwise pan ──
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Focus mode places cards in screen space, so panning/zooming the camera
      // would move only the background — all motion, no effect.
      if (focusedRef.current) return
      const overCard = !!(e.target as HTMLElement)?.closest?.('[data-canvas-card]')
      const zooming = e.ctrlKey || e.metaKey
      // Let a card's own scroll surface (terminal history, webview, note text)
      // consume plain wheel events; only intercept for canvas zoom.
      if (overCard && !zooming) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cam = cameraRef.current
      if (zooming) {
        const mx = e.clientX - rect.left, my = e.clientY - rect.top
        const factor = Math.exp(-e.deltaY * 0.0015)
        const newZoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM)
        const k = newZoom / cam.zoom
        setCamera({ zoom: newZoom, x: mx - (mx - cam.x) * k, y: my - (my - cam.y) * k })
      } else {
        setCamera({ ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── Keyboard: space = pan, delete = remove, V/H/etc = tools ──
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest?.('.xterm') || !!el.closest?.('webview'))
    }
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) { setSpaceDown(true) }
      if (isTyping(e.target)) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedConnectorId) { e.preventDefault(); removeConnector(selectedConnectorId); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) { e.preventDefault(); removeItems(selectedIds); return }
      if (e.key === 'Escape') {
        setShortcutsOpen(false); setFocusedId(null); setMaximizedId(null); setMenu(null)
        setTool('select'); clearSelection(); setConnectFrom(null)
        return
      }
      // Ctrl/⌘+Z takes back the last eraser pass — the only gesture here that
      // destroys a batch of work without asking.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoErase(); return }
      // Ctrl/⌘+A selects everything the marquee would be able to reach — same
      // exclusions (locked items stay out, since they can't be moved anyway).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelectedIds(itemsRef.current.filter(i => !i.locked).map(i => i.id))
        return
      }
      // Ctrl/⌘+D duplicates the selection.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && selectedIds.length) {
        e.preventDefault()
        selectedIds.forEach(duplicateItem)
        return
      }
      // Arrow keys nudge the selection (Shift = coarse). No modifier needed.
      if (selectedIds.length && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.startsWith('Arrow')) {
        e.preventDefault()
        const d = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
        const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0
        const set = new Set(selectedIds)
        setItems(prev => prev.map(i => (set.has(i.id) && !i.locked ? { ...i, x: i.x + dx, y: i.y + dy } : i)))
        return
      }
      // Bare-key tool shortcuts only — never hijack Ctrl/⌘/Alt combos (e.g.
      // Ctrl+B broadcast, ⌘+K palette).
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // `?` opens the shortcut sheet — the board is full of bare-key tools, so
      // there has to be somewhere to read them.
      if (e.key === '?') { e.preventDefault(); setShortcutsOpen(o => !o); return }
      // F focuses the selected terminal (or leaves focus mode). Only one
      // terminal can hold the stage, so this stays a single-selection action.
      if (e.key.toLowerCase() === 'f') {
        const sel = selectedIds.length === 1 ? itemsRef.current.find(i => i.id === selectedIds[0]) : null
        if (focusedRef.current) { setFocusedId(null); return }
        if (sel?.kind === 'terminal') { focusTerminal(sel.id); return }
      }
      // L locks/unlocks the selection.
      if (e.key.toLowerCase() === 'l' && selectedIds.length) { toggleLockMany(selectedIds); return }
      // J jumps the camera to whichever pane is waiting on an answer. The chip
      // is the discoverable path; this is the one you use twice and keep.
      if (e.key.toLowerCase() === 'j' && attentionRef.current) { jumpToCard(attentionRef.current); return }
      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break
        case 'h': setTool('hand'); break
        case 'p': setTool('draw'); break
        case 'e': setTool('erase'); break
        case 'c': setTool('connect'); break
        case 't': setTool('terminal'); break
        case 'b': setTool('browser'); break
        case 'm': setTool('device'); break
        case 'n': setTool('note'); break
        case 'k': setTool('task'); break
        case 'a': setTool('frame'); break
        case 'i': openImagePicker(); break
        case 'r': setTool('rect'); break
        case 'o': setTool('ellipse'); break
        case 'g': e.shiftKey ? alignAllToGrid() : setSnap(s => !s); break
        case 'u': tidyBoard(); break
      }
    }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [selectedIds, selectedConnectorId, removeItems, removeConnector, duplicateItem, openImagePicker, undoErase, toggleLockMany, clearSelection, focusTerminal, alignAllToGrid, tidyBoard, jumpToCard])

  // Close the context menu on any outside click.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  // Auto-dismiss the status toast so it doesn't linger over the board.
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(id)
  }, [toast])

  // Paste an image from the clipboard → drop it at the viewport centre.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const cd = e.clipboardData
      if (!cd) return
      for (const it of Array.from(cd.items)) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile()
          if (file) { e.preventDefault(); const c = viewportCenterWorld(); addImageFromFile(file, c.x, c.y) }
          return
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addImageFromFile, viewportCenterWorld])

  const resetView = useCallback(() => setCamera(DEFAULT_CAMERA), [])
  const zoomBy = useCallback((factor: number) => {
    const el = rootRef.current
    const rect = el?.getBoundingClientRect()
    const cam = cameraRef.current
    const mx = (rect?.width ?? window.innerWidth) / 2, my = (rect?.height ?? window.innerHeight) / 2
    const newZoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM)
    const k = newZoom / cam.zoom
    setCamera({ zoom: newZoom, x: mx - (mx - cam.x) * k, y: my - (my - cam.y) * k })
  }, [])

  // ── Tool rail: drag to reposition ──
  // The rail floats above the board in *screen* space, so this is plain pixel
  // math — no camera involved. The result is clamped to the board so the rail
  // can never be dropped somewhere unreachable.
  const startRailDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    // Measure the rail itself, not the grip's wrapper — the grip sits one level
    // deeper in the expanded layout, so walking parentElement would clamp
    // against the wrong box.
    const railEl = railRef.current
    const board = rootRef.current
    if (!railEl || !board) return
    const rect = railEl.getBoundingClientRect()
    const boardRect = board.getBoundingClientRect()
    // Grab offset within the rail, so it doesn't jump to the cursor.
    const grabX = e.clientX - rect.left
    const grabY = e.clientY - rect.top
    setInteracting('grabbing')
    startPointerDrag(
      (ev) => {
        const x = clamp(ev.clientX - boardRect.left - grabX, 4, Math.max(4, boardRect.width - rect.width - 4))
        const y = clamp(ev.clientY - boardRect.top - grabY, 4, Math.max(4, boardRect.height - rect.height - 4))
        setRailPos({ x, y })
      },
      () => setInteracting(false),
    )
  }, [])

  // Rail + pen bar placement: default (left, vertically centred) until dragged,
  // then an explicit position. The pen bar rides alongside either way.
  const railStyle: React.CSSProperties = railPos
    ? { ...styles.rail, left: railPos.x, top: railPos.y, transform: 'none' }
    : styles.rail
  const penBarStyle: React.CSSProperties = railPos
    ? { ...styles.penBar, left: railPos.x + 52, top: railPos.y, transform: 'none' }
    : styles.penBar

  const cursor = tool === 'hand' || spaceDown ? 'grab'
    : tool === 'select' ? 'default'
    : 'crosshair'

  const bgStyle = backgroundLayerStyle(background, camera)
  const maximized = maximizedId ? items.find(i => i.id === maximizedId) : null
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  // The box drawn around a multi-selection, so a set picked up by the marquee
  // reads as one thing to drag rather than n cards that happen to be outlined.
  const groupBox = useMemo(
    () => (selectedIds.length > 1 ? selectionBounds(items.filter(i => selectedSet.has(i.id))) : null),
    [items, selectedIds, selectedSet],
  )

  // Focus mode geometry, recomputed from the live viewport so it re-flows on a
  // window resize. `focus.hidden` is the dock overflow — those cards stay
  // mounted (their ptys keep streaming) but are display:none'd, and the dock
  // says how many are stashed rather than drawing them off-screen.
  const focus = focusedId && viewport.w > 0
    ? focusLayout(items.filter(i => i.kind === 'terminal').map(i => i.id), focusedId, viewport)
    : null
  const focusHidden = focus ? new Set(focus.hidden) : null
  // Placement for one card while focus mode is on: the stage, a dock slot, or
  // out of the way entirely (non-terminals and dock overflow).
  const focusRectFor = (item: CanvasItem): ScreenRect | 'hidden' | null => {
    if (!focus) return null
    if (item.kind !== 'terminal') return 'hidden'
    if (item.id === focusedId) return focus.stage
    if (focusHidden!.has(item.id)) return 'hidden'
    return focus.dock.get(item.id) ?? 'hidden'
  }

  // ── Attention camera ──
  // An infinite board's own premise breaks the one signal that matters: a pane
  // three screens away asking "may I edit this file?" is invisible. The TopBar
  // bell knows; the board didn't. Note the source is the *notification* list,
  // not `paneAttention === 'waiting'` — waiting means "finished a turn", which is
  // most panes most of the time, and a camera that chased it would never settle.
  // Notifications are already question-gated in pty-manager.
  const notifiedPaneIds = useMemo(
    () => notifications.filter(n => !n.read).map(n => n.paneId),
    [notifications],
  )
  const notifiedPaneSet = useMemo(() => new Set(notifiedPaneIds), [notifiedPaneIds])
  const attentionCardId = useMemo(
    () => pickAttentionTarget(items, notifiedPaneIds),
    [items, notifiedPaneIds],
  )
  const attentionCard = attentionCardId ? items.find(i => i.id === attentionCardId) ?? null : null
  attentionRef.current = attentionCardId
  const attentionOffscreen = !!attentionCard && viewport.w > 0 && !focus &&
    isOffscreen(attentionCard, viewportWorldRect(camera, viewport), 24)

  // Follow mode: pan to the card that just asked, once. `shouldFollow` refuses
  // to re-chase a target already followed, so dismissing the chip and panning
  // away doesn't snap you straight back on the next render.
  useEffect(() => {
    if (!follow || focus) return
    if (!shouldFollow(attentionCardId, lastFollowedRef.current, attentionOffscreen)) return
    lastFollowedRef.current = attentionCardId
    if (attentionCardId) jumpToCard(attentionCardId)
  }, [follow, focus, attentionCardId, attentionOffscreen, jumpToCard])

  // Once the question is answered the target is fair game to chase again.
  useEffect(() => {
    if (!attentionCardId) lastFollowedRef.current = null
  }, [attentionCardId])

  // Attempt cards, keyed by pane, for the race chips drawn on the terminals.
  const raceIndex = useMemo(() => {
    const out = new Map<string, { index: number; total: number; state: string; stat: AttemptStat | undefined }>()
    racers.forEach((r, i) => {
      out.set(r.paneId, {
        index: i + 1,
        total: racers.length,
        state: attemptState({
          running: r.running,
          working: paneAttention[r.paneId] === 'working',
          stat: raceStats[r.paneId],
        }),
        stat: raceStats[r.paneId],
      })
    })
    return out
  }, [racers, raceStats, paneAttention])
  const raceContested = useMemo(
    () => contestedFiles(racers.map(r => ({ paneId: r.paneId, stat: raceStats[r.paneId] }))),
    [racers, raceStats],
  )

  return (
    <div style={styles.wrap}>
      {/* ── Board surface ── */}
      <div
        ref={rootRef}
        data-canvas-board
        style={{
          ...styles.board, cursor,
          background: background.type === 'solid' ? background.color : 'var(--bg-base)',
          // The maximized card lives inside this (transformed) subtree, so the
          // board itself has to out-stack the floating chrome — tool rail and
          // minimap sit at z 20 as siblings. The restore button is above both.
          ...(maximizedId || focusedId ? { zIndex: 50 } : null),
        }}
        onPointerDown={onCanvasPointerDown}
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return
          const { x, y } = screenToWorld(e.clientX, e.clientY)
          addTerminal(x, y)
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          const { x, y } = screenToWorld(e.clientX, e.clientY)
          setMenu({ x: e.clientX, y: e.clientY, wx: x, wy: y, itemId: null })
        }}
        onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
          if (!files.length) return
          e.preventDefault()
          const { x, y } = screenToWorld(e.clientX, e.clientY)
          files.forEach((f, i) => addImageFromFile(f, x + i * 30, y + i * 30))
        }}
      >
        {/* Background pattern layer (pans/zooms with the camera) */}
        <div style={bgStyle} />

        {/* World (transformed) */}
        <div
          style={{
            position: 'absolute', left: 0, top: 0,
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          {/* Connectors (arrows) — drawn under the cards so they emanate from
              card borders; the exposed segment stays clickable for selection. */}
          <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 0, display: focus ? 'none' : undefined }} width={1} height={1}>
            <defs>
              <marker id="cn-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="context-stroke" />
              </marker>
            </defs>
            {connectors.map(c => {
              const a = items.find(i => i.id === c.from), b = items.find(i => i.id === c.to)
              if (!a || !b) return null
              const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2
              const p1 = rectBorderPoint(a, bcx, bcy), p2 = rectBorderPoint(b, acx, acy)
              const sel = selectedConnectorId === c.id
              const col = c.color ?? 'var(--accent)'
              return (
                <g key={c.id}>
                  {/* fat invisible hit line for easy selection */}
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={16}
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onPointerDown={(e) => { e.stopPropagation(); setSelectedConnectorId(c.id); setSelectedIds([]) }} />
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={col} strokeWidth={sel ? 3 : 2}
                    markerEnd="url(#cn-arrow)" style={{ pointerEvents: 'none' }} />
                  {sel && (
                    <g transform={`translate(${(p1.x + p2.x) / 2}, ${(p1.y + p2.y) / 2})`} style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                      onPointerDown={(e) => { e.stopPropagation(); removeConnector(c.id) }}>
                      <circle r={9} fill="var(--bg-panel)" stroke="var(--accent)" strokeWidth={1} />
                      <path d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5" stroke="var(--accent)" strokeWidth={1.6} strokeLinecap="round" />
                    </g>
                  )}
                </g>
              )
            })}
            {/* Rubber-band while connecting */}
            {tool === 'connect' && connectFrom && connectPointer && (() => {
              const a = items.find(i => i.id === connectFrom)
              if (!a) return null
              const start = rectBorderPoint(a, connectPointer.x, connectPointer.y)
              return <line x1={start.x} y1={start.y} x2={connectPointer.x} y2={connectPointer.y} stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" />
            })()}
          </svg>

          {/* Every item is rendered exactly once, here — including the maximized
              one, which CanvasCard styles to fill the viewport in place. It used
              to be skipped here and re-mounted in a full-screen overlay, but a
              different parent means a fresh React mount: the pane's xterm was
              disposed and rebuilt (and a browser card's webview reloaded) just
              to make it bigger. */}
          {items.map(item => (
            // Freehand ink lives in world coordinates, so in focus mode — where
            // the cards are placed in screen space — it would float over the
            // stage pointing at nothing. Unmounting it is free (it's stateless
            // SVG, unlike the cards).
            item.kind === 'draw' ? (focus ? null : (
              <CanvasDrawing
                key={item.id}
                item={item}
                selected={selectedSet.has(item.id)}
                onDragStart={startDrag}
                onContextMenu={handleCardMenu}
              />
            )) : (
              <CanvasCard
                key={item.id}
                item={item}
                selected={selectedSet.has(item.id) && item.id !== maximizedId}
                zoom={camera.zoom}
                maximized={item.id === maximizedId}
                camera={camera}
                viewport={viewport}
                focusRect={focusRectFor(item)}
                isFocusStage={focus ? item.id === focusedId : false}
                onFocus={item.kind === 'terminal' ? focusTerminal : undefined}
                onDragStart={startDrag}
                onResizeStart={startResize}
                onSelect={handleCardSelect}
                onRemove={removeItem}
                onMaximize={handleCardMaximize}
                onUpdate={updateItem}
                onContextMenu={handleCardMenu}
                onCapture={handleCapture}
                task={item.kind === 'task' && item.taskId ? tasksById.get(item.taskId) : undefined}
                onTaskRename={renameTask}
                noteColors={NOTE_COLORS}
                alpha={item.kind === 'terminal' ? terminalAlpha(item, terminalOpacity) : 1}
                // Semantic zoom. Never while maximized or on the focus stage:
                // both of those exist precisely to make one terminal readable.
                tile={item.kind === 'terminal' && tileMode && item.id !== maximizedId && !focus}
                tileTask={item.paneId ? tasksById.get(paneTask[item.paneId] ?? '')?.title : undefined}
                needsAttention={!!item.paneId && notifiedPaneSet.has(item.paneId)}
                race={item.paneId ? raceIndex.get(item.paneId) : undefined}
                raceBusy={raceBusy}
                onRaceKeep={keepRaceWinner}
                frameChildCount={isFrameKind(item.kind) ? frameChildren(item, items).length : 0}
                framePaneCount={isFrameKind(item.kind) ? framePanes(item, items).length : 0}
                onFrameSend={openFrameBroadcast}
                t={t}
              />
            )
          ))}

          {/* Multi-selection outline. Lives in the world layer so it tracks the
              cards as they move, which means its border and badge have to be
              counter-scaled by 1/zoom to keep a constant on-screen size. */}
          {groupBox && !focus && (
            <div
              style={{
                position: 'absolute',
                left: groupBox.x - 6, top: groupBox.y - 6,
                width: groupBox.w + 12, height: groupBox.h + 12,
                border: `${1 / camera.zoom}px dashed var(--accent)`,
                borderRadius: 10 / camera.zoom,
                pointerEvents: 'none',
                zIndex: 9,
              }}
            >
              <span style={{ ...styles.groupCount, transform: `scale(${1 / camera.zoom})` }}>
                {t('canvas.select.count', { n: selectedIds.length })}
              </span>
            </div>
          )}

          {/* Live stroke preview while the pen is drawing (world coords) */}
          {draft && draft.length > 1 && (
            <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }} width={1} height={1}>
              <polyline
                points={draft.map(p => `${p.x},${p.y}`).join(' ')}
                fill="none" stroke={penColor} strokeWidth={penWidth}
                strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          )}
        </div>

        {/* Marquee. Screen-space chrome, not a world item — it's a gesture, so
            it must not pan or zoom while it's being drawn. */}
        {marquee && (
          <div
            data-canvas-marquee
            style={{ ...styles.marquee, left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}

        {/* Pen capture layer — mounted only in draw mode so strokes can start
            anywhere (including over cards). z sits above the world's cards (their
            transformed stacking context is at level 0) but below the tool rail /
            pen bar (z ≥ 20) so those stay clickable while drawing. */}
        {tool === 'draw' && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 15, cursor: 'crosshair' }} onPointerDown={startDraw} />
        )}

        {/* Eraser capture layer — like the pen's, so a swipe can start over a
            card as well as over empty board. Also tracks the cursor so the
            radius ring follows it before you press. */}
        {tool === 'erase' && (
          <div
            style={{ position: 'absolute', inset: 0, zIndex: 15, cursor: 'none' }}
            onPointerDown={startErase}
            onPointerMove={(e) => setEraserAt({ x: e.clientX, y: e.clientY })}
            onPointerLeave={() => setEraserAt(null)}
          />
        )}

        {/* Connect capture layer — clicking two cards links them with an arrow. */}
        {tool === 'connect' && (
          <div
            style={{ position: 'absolute', inset: 0, zIndex: 15, cursor: 'crosshair' }}
            onPointerDown={onConnectPointerDown}
            onPointerMove={(e) => { if (connectFrom) setConnectPointer(screenToWorld(e.clientX, e.clientY)) }}
          />
        )}

        {/* Connect hint */}
        {tool === 'connect' && (
          <div style={styles.connectHint}>{connectFrom ? t('canvas.connect.pickTarget') : t('canvas.connect.pickSource')}</div>
        )}

        {/* Empty hint */}
        {items.length === 0 && (
          <div style={styles.emptyHint}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('canvas.empty.title')}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>{t('canvas.empty.body')}</div>
          </div>
        )}
      </div>

      {/* ── Tool rail (Miro-style) — draggable, collapsible ──
          Hidden in focus mode: placing a new card somewhere you can't see it is
          the only thing most of these tools could do there. */}
      {focus ? null : railCollapsed ? (
        <div ref={railRef} style={{ ...railStyle, padding: 4 }}>
          <div
            onPointerDown={startRailDrag}
            title={t('canvas.rail.drag')}
            style={{ ...styles.railGrip, cursor: 'grab' }}
          ><GripDots /></div>
          <ToolButton
            active={false}
            label={t('canvas.rail.expand')}
            onClick={() => setRailCollapsed(false)}
          ><ChevronRight size={16} strokeWidth={2.2} /></ToolButton>
        </div>
      ) : (
      <div ref={railRef} style={railStyle}>
        {/* Drag grip + collapse */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <div
            onPointerDown={startRailDrag}
            title={t('canvas.rail.drag')}
            style={{ ...styles.railGrip, flex: 1, cursor: 'grab' }}
          ><GripDots /></div>
          <button
            onClick={() => setRailCollapsed(true)}
            title={t('canvas.rail.collapse')}
            style={styles.railCollapseBtn}
          ><ChevronLeft size={13} strokeWidth={2.2} /></button>
        </div>
        <div style={styles.railDivider} />
        <ToolButton active={tool === 'select'} label={t('canvas.tool.select')} onClick={() => setTool('select')}><IconCursor /></ToolButton>
        <ToolButton active={tool === 'hand'} label={t('canvas.tool.hand')} onClick={() => setTool('hand')}><IconHand /></ToolButton>
        <ToolButton active={tool === 'draw'} label={t('canvas.tool.pen')} onClick={() => setTool('draw')}><IconPen /></ToolButton>
        <ToolButton active={tool === 'erase'} label={t('canvas.tool.erase')} onClick={() => setTool('erase')}><IconEraser /></ToolButton>
        <ToolButton active={tool === 'connect'} label={t('canvas.tool.connect')} onClick={() => setTool('connect')}><IconConnect /></ToolButton>
        <div style={styles.railDivider} />
        <ToolButton active={tool === 'terminal'} label={t('canvas.tool.terminal')} onClick={() => setTool('terminal')}><IconTerminal /></ToolButton>
        <ToolButton active={tool === 'browser'} label={t('canvas.tool.browser')} onClick={() => setTool('browser')}><IconGlobe /></ToolButton>
        <ToolButton active={tool === 'device'} label={t('canvas.tool.device')} onClick={() => setTool('device')}><IconDevice /></ToolButton>
        <ToolButton active={tool === 'note'} label={t('canvas.tool.note')} onClick={() => setTool('note')}><IconNote /></ToolButton>
        <ToolButton active={tool === 'text'} label={t('canvas.tool.text')} onClick={() => setTool('text')}><IconText /></ToolButton>
        <ToolButton active={tool === 'task'} label={t('canvas.tool.task')} onClick={() => setTool('task')}><IconTask /></ToolButton>
        <ToolButton active={tool === 'frame'} label={t('canvas.tool.frame')} onClick={() => setTool('frame')}><IconFrame /></ToolButton>
        <ToolButton active={tool === 'image'} label={t('canvas.tool.image')} onClick={openImagePicker}><IconImage /></ToolButton>
        <div style={styles.railDivider} />
        <ToolButton active={tool === 'rect'} label={t('canvas.tool.rect')} onClick={() => setTool('rect')}><IconRect /></ToolButton>
        <ToolButton active={tool === 'ellipse'} label={t('canvas.tool.ellipse')} onClick={() => setTool('ellipse')}><IconEllipse /></ToolButton>
        <ToolButton active={tool === 'triangle'} label={t('canvas.tool.triangle')} onClick={() => setTool('triangle')}><IconTriangle /></ToolButton>
      </div>
      )}

      {/* ── Pen colour / width picker (draw mode only) ── */}
      {tool === 'draw' && !railCollapsed && (
        <div style={penBarStyle}>
          <span style={styles.penBarLabel}>{t('canvas.pen.color')}</span>
          <div style={{ display: 'flex', gap: 5 }}>
            {PEN_COLORS.map(c => (
              <button key={c} onClick={() => setPenColor(c)} title={c}
                style={{ width: 18, height: 18, borderRadius: '50%', background: c, cursor: 'pointer', padding: 0, border: penColor === c ? '2px solid var(--accent)' : '1px solid var(--border)' }} />
            ))}
          </div>
          <div style={styles.penBarDivider} />
          <span style={styles.penBarLabel}>{t('canvas.pen.width')}</span>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            {PEN_WIDTHS.map(w => (
              <button key={w} onClick={() => setPenWidth(w)} title={String(w)}
                style={{ width: 24, height: 24, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, background: penWidth === w ? 'var(--accent)' : 'transparent', border: '1px solid var(--border)' }}>
                <span style={{ width: w + 4, height: w + 4, borderRadius: '50%', background: penWidth === w ? 'var(--accent-fg)' : 'var(--text-secondary)' }} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Top-right controls ── */}
      <div style={styles.topControls}>
        <div style={{ position: 'relative' }}>
          <button style={styles.ctrlBtn} onClick={() => setBgPickerOpen(o => !o)} title={t('canvas.background')}>
            <IconBackground /> <span style={{ fontSize: 12 }}>{t('canvas.background')}</span>
          </button>
          {bgPickerOpen && (
            <BackgroundPicker background={background} onChange={setBackground} onClose={() => setBgPickerOpen(false)} t={t} />
          )}
        </div>
        <button style={styles.iconCtrl} onClick={() => zoomBy(1 / 1.2)} title={t('canvas.zoomOut')}>−</button>
        <button style={styles.zoomLabel} onClick={resetView} title={t('canvas.resetView')}>{Math.round(camera.zoom * 100)}%</button>
        <button style={styles.iconCtrl} onClick={() => zoomBy(1.2)} title={t('canvas.zoomIn')}>+</button>
        <button style={styles.iconCtrl} onClick={zoomToFit} title={t('canvas.fit')}><IconFit /></button>
        <button style={styles.iconCtrl} onClick={tidyBoard} title={t('canvas.arrange.tidyTitle')}><IconTidy /></button>
        <button
          style={{ ...styles.iconCtrl, color: snap ? 'var(--accent)' : 'var(--text-secondary)', borderColor: snap ? 'var(--accent)' : 'var(--border)' }}
          onClick={() => setSnap(s => !s)}
          onContextMenu={(e) => { e.preventDefault(); alignAllToGrid() }}
          title={`${snap ? t('canvas.snapOn') : t('canvas.snapOff')} — ${t('canvas.arrange.alignHint')}`}
        ><IconSnap /></button>
        {/* Semantic zoom + follow camera. Both are ways of *looking* at the
            board rather than things on it, so they live with zoom and fit
            rather than in the tool rail. */}
        <button
          style={{ ...styles.iconCtrl, color: lodEnabled ? 'var(--accent)' : 'var(--text-secondary)', borderColor: lodEnabled ? 'var(--accent)' : 'var(--border)' }}
          onClick={() => setLodEnabled(v => !v)}
          title={lodEnabled ? t('canvas.lod.on') : t('canvas.lod.off')}
        ><IconLod /></button>
        <button
          style={{ ...styles.iconCtrl, color: follow ? 'var(--accent)' : 'var(--text-secondary)', borderColor: follow ? 'var(--accent)' : 'var(--border)' }}
          onClick={() => setFollow(v => !v)}
          title={follow ? t('canvas.follow.on') : t('canvas.follow.off')}
        ><IconFollow /></button>
        <button style={styles.iconCtrl} onClick={() => setShortcutsOpen(o => !o)} title={t('canvas.shortcuts.title')}>?</button>
        <button style={styles.exitBtn} onClick={showTerminals} title={t('canvas.exit')}>
          <IconExit /> <span style={{ fontSize: 12 }}>{t('canvas.exit')}</span>
        </button>
      </div>

      {/* ── Pointer shield during drag/resize/pan (keeps webviews from eating
          the pointer stream so gestures never stall) ── */}
      {interacting && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 99998, cursor: interacting }} />
      )}

      {/* ── Context menu ── */}
      {menu && (
        <div style={{ ...styles.ctxMenu, left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 260) }} onClick={e => e.stopPropagation()}>
          {menu.itemId ? (() => {
            const target = items.find(i => i.id === menu.itemId)
            const browserCount = items.filter(i => i.kind === 'browser').length
            // Right-clicked inside a multi-selection: the set-wide actions
            // (duplicate / lock / delete) act on all of it, and the menu says
            // so. The per-kind sections below stay about the clicked card —
            // there is no sensible "set the opacity of these nine things".
            const multi = selectedIds.length > 1 && selectedIds.includes(menu.itemId!) ? selectedIds : null
            return (
            <>
              {multi && <div style={styles.ctxLabel}>{t('canvas.select.count', { n: multi.length })}</div>}
              {target?.kind === 'terminal' && !multi && (
                <button className="ctx-menu-item" onClick={() => { focusTerminal(target.id); setMenu(null) }}>
                  <span style={{ flex: 1 }}>{focusedId === target.id ? t('canvas.focus.exit') : t('canvas.focus.enter')}</span>
                  <span style={styles.ctxKey}>F</span>
                </button>
              )}
              {/* Race — best-of-N where the agents already are. Offered on a
                  selection of terminals, which is the gesture that means "these
                  ones" on this board. */}
              {multi && multi.filter(id => items.find(i => i.id === id)?.kind === 'terminal').length > 1 && (
                <button className="ctx-menu-item" onClick={() => openRaceSetup(multi)}>
                  {t('canvas.race.start', { n: multi.filter(id => items.find(i => i.id === id)?.kind === 'terminal').length })}
                </button>
              )}
              <button className="ctx-menu-item" onClick={() => { (multi ?? [menu.itemId!]).forEach(duplicateItem); setMenu(null) }}><span style={{ flex: 1 }}>{t('canvas.ctx.duplicate')}</span><span style={styles.ctxKey}>Ctrl+D</span></button>
              <button className="ctx-menu-item" onClick={() => { multi ? toggleLockMany(multi) : toggleLock(menu.itemId!); setMenu(null) }}>
                <span style={{ flex: 1 }}>{target?.locked ? t('canvas.ctx.unlock') : t('canvas.ctx.lock')}</span>
                <span style={styles.ctxKey}>L</span>
              </button>
              <button className="ctx-menu-item" onClick={() => { bringToFront(menu.itemId!); setMenu(null) }}>{t('canvas.ctx.front')}</button>
              <button className="ctx-menu-item" onClick={() => { sendToBack(menu.itemId!); setMenu(null) }}>{t('canvas.ctx.back')}</button>

              {/* Terminal transparency — background only; text stays opaque. */}
              {target?.kind === 'terminal' && (() => {
                const pct = Math.round(terminalAlpha(target, terminalOpacity) * 100)
                return (
                  <>
                    <div style={styles.ctxDivider} />
                    <div style={styles.ctxLabel}>{t('canvas.ctx.opacity')}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 10px 4px' }}>
                      <input
                        type="range"
                        min={20}
                        max={100}
                        step={5}
                        value={pct}
                        onChange={e => updateItem(target.id, { opacity: Number(e.target.value) / 100 })}
                        style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 10.5, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums', minWidth: 30, textAlign: 'right' }}>
                        {pct}%
                      </span>
                    </div>
                    <button
                      className="ctx-menu-item"
                      onClick={() => { applyOpacityToAllTerminals(pct / 100); setMenu(null) }}
                    >
                      {t('canvas.ctx.opacityAll')}
                    </button>
                  </>
                )
              })()}

              {/* Hand a screenshot off to a running agent. Terminals connected
                  to this image (an arrow drawn from it) are listed first — the
                  arrow is the pitch, but the menu also works without one. */}
              {target?.kind === 'image' && (() => {
                const connectedPanes = new Set(
                  connectors.filter(c => c.from === target.id)
                    .map(c => items.find(i => i.id === c.to)?.paneId)
                    .filter((p): p is string => !!p)
                )
                const agents = items
                  .filter(i => i.kind === 'terminal' && i.paneId)
                  .map(i => {
                    const leaf = findLeaf(rootPane, i.paneId!)
                    if (!leaf || leaf.ptyStatus !== 'running') return null
                    return { paneId: leaf.id, label: leaf.title?.trim() || leaf.agentId || t('pane.noAgent') }
                  })
                  .filter((a): a is { paneId: string; label: string } => !!a)
                  .sort((a, b) => Number(connectedPanes.has(b.paneId)) - Number(connectedPanes.has(a.paneId)))
                return (
                  <>
                    <div style={styles.ctxDivider} />
                    <div style={styles.ctxLabel}>{t('canvas.ctx.sendToAgent')}</div>
                    {agents.length === 0 ? (
                      <div style={{ ...styles.ctxLabel, opacity: 0.6, fontStyle: 'italic' }}>{t('canvas.ctx.noAgents')}</div>
                    ) : agents.map(a => (
                      <button
                        key={a.paneId}
                        className="ctx-menu-item"
                        onClick={() => { setSendTarget({ imageId: target.id, paneId: a.paneId, agent: a.label }); setMenu(null) }}
                      >
                        {connectedPanes.has(a.paneId) ? '▶ ' : ''}{a.label}
                      </button>
                    ))}
                  </>
                )
              })()}

              {/* Task card — assign to an agent, set status, delete the row.
                  Assigning writes tasks.assigned_agent, which is exactly what
                  the conductor matches a free worker pane against. */}
              {target?.kind === 'task' && target.taskId && (() => {
                const tk = tasksById.get(target.taskId)
                const agents = items
                  .filter(i => i.kind === 'terminal' && i.paneId)
                  .map(i => {
                    const leaf = findLeaf(rootPane, i.paneId!)
                    return leaf?.agentId ? { agentId: leaf.agentId as string, label: leaf.title?.trim() || leaf.agentId } : null
                  })
                  .filter((a): a is { agentId: string; label: string } => !!a)
                // De-dupe by agent id (several panes may run the same agent).
                const seen = new Set<string>()
                const uniq = agents.filter(a => (seen.has(a.agentId) ? false : (seen.add(a.agentId), true)))
                const STATUSES = ['pending', 'in_progress', 'done'] as const
                return (
                  <>
                    <div style={styles.ctxDivider} />
                    <div style={styles.ctxLabel}>{t('canvas.task.assignTo')}</div>
                    {uniq.length === 0 ? (
                      <div style={{ ...styles.ctxLabel, opacity: 0.6, fontStyle: 'italic' }}>{t('canvas.ctx.noAgents')}</div>
                    ) : uniq.map(a => (
                      <button
                        key={a.agentId}
                        className="ctx-menu-item"
                        onClick={() => { void assignTask(target.taskId!, a.agentId, a.label); setMenu(null) }}
                      >
                        {tk?.assigned_agent === a.agentId ? '✓ ' : ''}@{a.label}
                      </button>
                    ))}
                    {tk?.assigned_agent && (
                      <button className="ctx-menu-item" onClick={() => { void assignTask(target.taskId!, null, ''); setMenu(null) }}>
                        {t('canvas.task.unassign')}
                      </button>
                    )}
                    <div style={styles.ctxLabel}>{t('canvas.task.status')}</div>
                    {STATUSES.map(s => (
                      <button
                        key={s}
                        className="ctx-menu-item"
                        onClick={() => { void setTaskStatus(target.taskId!, s); setMenu(null) }}
                      >
                        {tk?.status === s ? '✓ ' : ''}{t(`kanban.col.${s}` as any)}
                      </button>
                    ))}
                    <div style={styles.ctxDivider} />
                    <button className="ctx-menu-item" data-variant="danger" onClick={() => { void deleteTask(target) }}>
                      {t('canvas.task.delete')}
                    </button>
                  </>
                )
              })()}

              {/* Frame — a named region that owns what's inside it. The two
                  actions that make it more than a rectangle: talk to every
                  agent in it, and grab everything in it as a selection. */}
              {target && isFrameKind(target.kind) && (() => {
                const kids = frameChildren(target, items).length
                const panes = framePanes(target, items).length
                return (
                  <>
                    <div style={styles.ctxDivider} />
                    <div style={styles.ctxLabel}>{t('canvas.frame.contains', { n: kids, agents: panes })}</div>
                    <button className="ctx-menu-item" disabled={panes === 0} onClick={() => openFrameBroadcast(target.id)}>
                      {t('canvas.frame.broadcast', { n: panes })}
                    </button>
                    <button className="ctx-menu-item" disabled={kids === 0} onClick={() => selectFrameContents(target.id)}>
                      {t('canvas.frame.selectContents', { n: kids })}
                    </button>
                  </>
                )
              })()}

              {/* Sticky note → real task, in place. Scribble first, formalise
                  later is how a board actually gets used. */}
              {(target?.kind === 'note' || target?.kind === 'text') && !multi && (
                <>
                  <div style={styles.ctxDivider} />
                  <button className="ctx-menu-item" onClick={() => { void noteToTask(target) }}>
                    {t('canvas.note.toTask')}
                  </button>
                </>
              )}

              {/* Browser tab stacking */}
              {target?.kind === 'browser' && (
                <>
                  <div style={styles.ctxDivider} />
                  {browserCount > 1 && (
                    <button className="ctx-menu-item" onClick={() => { stackBrowsers(target.id); setMenu(null) }}>
                      {t('canvas.ctx.stackBrowsers', { n: browserCount })}
                    </button>
                  )}
                  {browserTabs(target).length > 1 && (
                    <button className="ctx-menu-item" onClick={() => { unstackBrowser(target.id); setMenu(null) }}>
                      {t('canvas.ctx.unstackBrowsers')}
                    </button>
                  )}
                </>
              )}

              <div style={styles.ctxDivider} />
              <button className="ctx-menu-item" data-variant="danger" onClick={() => { removeItems(multi ?? [menu.itemId!]); setMenu(null) }}><span style={{ flex: 1 }}>{t('canvas.ctx.delete')}</span><span style={styles.ctxKey}>Del</span></button>
            </>
            )
          })() : (
            <>
              <div style={styles.ctxLabel}>{t('canvas.ctx.addHere')}</div>
              <button className="ctx-menu-item" onClick={() => addFromMenu('terminal', menu.wx, menu.wy)}>{t('canvas.tool.terminal')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('browser', menu.wx, menu.wy)}>{t('canvas.tool.browser')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('device', menu.wx, menu.wy)}>{t('canvas.tool.device')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('note', menu.wx, menu.wy)}>{t('canvas.tool.note')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('text', menu.wx, menu.wy)}>{t('canvas.tool.text')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('task', menu.wx, menu.wy)}>{t('canvas.tool.task')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('frame', menu.wx, menu.wy)}>{t('canvas.tool.frame')}</button>
              <div style={styles.ctxDivider} />
              <button className="ctx-menu-item" onClick={() => addFromMenu('rect', menu.wx, menu.wy)}>{t('canvas.tool.rect')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('ellipse', menu.wx, menu.wy)}>{t('canvas.tool.ellipse')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('triangle', menu.wx, menu.wy)}>{t('canvas.tool.triangle')}</button>
              <div style={styles.ctxDivider} />
              <div style={styles.ctxLabel}>{t('canvas.arrange.label')}</div>
              <button className="ctx-menu-item" onClick={() => { tidyBoard(); setMenu(null) }}>
                <span style={{ flex: 1 }}>{t('canvas.arrange.tidy')}</span><span style={styles.ctxKey}>U</span>
              </button>
              <button className="ctx-menu-item" onClick={() => { alignAllToGrid(); setMenu(null) }}>
                <span style={{ flex: 1 }}>{t('canvas.arrange.align')}</span><span style={styles.ctxKey}>Shift+G</span>
              </button>
              <button className="ctx-menu-item" onClick={() => { zoomToFit(); setMenu(null) }}>{t('canvas.fit')}</button>
            </>
          )}
        </div>
      )}

      {/* A maximized card is rendered in place by CanvasCard (see
          maximizedGeometry) — there is deliberately no overlay copy of it. */}
      {maximized && !focus && (
        <button style={styles.maxRestoreFloating} onClick={() => setMaximizedId(null)}>
          {t('canvas.restore')}
        </button>
      )}

      {/* Focus mode bar — the way out, plus the count of terminals the dock
          couldn't fit (they stay live, just off the strip). */}
      {focus && (
        <div style={styles.focusBar}>
          <IconFocus />
          <span>{t('canvas.focus.active')}</span>
          {focus.hidden.length > 0 && (
            <span style={styles.focusMore} title={t('canvas.focus.hiddenTitle')}>
              +{focus.hidden.length}
            </span>
          )}
          <button style={styles.focusExitBtn} onClick={() => setFocusedId(null)}>{t('canvas.focus.exit')}</button>
        </div>
      )}

      {/* Eraser cursor ring — shows the radius a swipe would catch. */}
      {tool === 'erase' && eraserAt && (
        <div
          aria-hidden
          style={{
            position: 'fixed', pointerEvents: 'none', zIndex: 99999,
            left: eraserAt.x - ERASER_RADIUS, top: eraserAt.y - ERASER_RADIUS,
            width: ERASER_RADIUS * 2, height: ERASER_RADIUS * 2,
            borderRadius: '50%', border: '1.5px solid var(--accent)',
            background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
          }}
        />
      )}

      {shortcutsOpen && <ShortcutSheet t={t} onClose={() => setShortcutsOpen(false)} />}

      {/* ── Race strip ──
          A race is on: what each attempt has changed, where they disagree, and
          the way out. The per-card chips say which card is which attempt; this
          says what the comparison as a whole looks like. */}
      {racers.length > 0 && !focus && (
        <div style={styles.raceBar}>
          <span style={styles.raceBarLabel}>{t('canvas.race.active', { n: racers.length })}</span>
          <span style={styles.raceBarGoal} title={raceGoal}>{raceGoal}</span>
          {raceContested.length > 0 && (
            <>
              <span style={styles.raceBarSep} />
              <span style={styles.raceBarLabel}>{t('race.contested')}</span>
              {raceContested.slice(0, 6).map(c => (
                <span key={c.path} style={styles.raceBarFile} title={c.path}>
                  {c.path.split(/[\\/]/).pop()}<span style={{ color: 'var(--accent)' }}> ×{c.count}</span>
                </span>
              ))}
            </>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.raceBarBtn} onClick={endRace}>{t('canvas.race.end')}</button>
        </div>
      )}

      {/* ── "Needs you" jump chip ──
          The board can be bigger than the screen, which is exactly what makes an
          agent's question easy to miss. Only shown when the card really is off
          screen — a chip pointing at something you can already see is noise. */}
      {attentionCard && attentionOffscreen && (
        <button
          className="canvas-attention-chip"
          style={styles.attentionChip}
          onClick={() => jumpToCard(attentionCard.id)}
          title={t('canvas.attention.hint')}
        >
          <span className="canvas-attention-dot" style={styles.attentionDot} />
          {t('canvas.attention.chip', { name: paneLabel(rootPane, attentionCard.paneId, t) })}
          <span style={styles.ctxKey}>J</span>
        </button>
      )}

      {/* ── Minimap navigator (bottom-right) ── */}
      {items.length > 0 && !focus && (
        <Minimap items={items} camera={camera} rootRef={rootRef} pos={minimapPos} onMove={setMinimapPos} onInteract={setInteracting} alerts={notifiedPaneSet} t={t} onJump={(wx, wy) => {
          const rect = rootRef.current?.getBoundingClientRect()
          if (!rect) return
          const z = cameraRef.current.zoom
          setCamera({ zoom: z, x: rect.width / 2 - wx * z, y: rect.height / 2 - wy * z })
        }} />
      )}

      {/* Send-screenshot-to-agent composer */}
      {sendTarget && (
        <SendToAgentPanel
          agent={sendTarget.agent}
          t={t}
          onCancel={() => setSendTarget(null)}
          onSend={(note) => {
            const tgt = sendTarget
            setSendTarget(null)
            void sendCaptureToAgent(tgt.imageId, tgt.paneId, tgt.agent, note)
          }}
        />
      )}

      {/* Frame broadcast composer — one instruction to every agent inside. */}
      {frameSend && (
        <PromptPanel
          title={t('canvas.frame.sendTitle', { name: frameSend.label, n: frameSend.panes.length })}
          placeholder={t('canvas.frame.sendPlaceholder')}
          hint={t('canvas.frame.sendHint', { n: frameSend.panes.length })}
          confirmLabel={t('canvas.send.send')}
          t={t}
          onCancel={() => setFrameSend(null)}
          onSubmit={(text) => {
            const target = frameSend
            setFrameSend(null)
            sendToFrame(target.panes, text)
          }}
        />
      )}

      {/* Race composer — the goal every selected terminal will attempt. */}
      {raceSetup && (
        <PromptPanel
          title={t('canvas.race.title', { n: raceSetup.panes.length })}
          placeholder={t('race.goalPlaceholder')}
          hint={raceSetup.panes.map(p => p.title).join(' · ')}
          confirmLabel={t('race.start', { n: String(raceSetup.panes.length) })}
          initial={raceGoal}
          t={t}
          onCancel={() => setRaceSetup(null)}
          onSubmit={(goal) => startRace(raceSetup.panes, goal)}
        />
      )}

      {/* Transient status toast (bottom-centre) */}
      {toast && (
        <div data-canvas-toast style={styles.toast} onClick={() => setToast(null)}>{toast}</div>
      )}

      {/* Hidden file input for image insertion */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          const pos = pendingImgPos.current ?? viewportCenterWorld()
          if (f) addImageFromFile(f, pos.x, pos.y)
          pendingImgPos.current = null
          e.target.value = ''
        }}
      />
    </div>
  )
}

// ── Minimap ─────────────────────────────────────────────────────────────────

function Minimap({ items, camera, rootRef, pos, onMove, onInteract, onJump, alerts, t }: {
  items: CanvasItem[]
  camera: Camera
  rootRef: React.RefObject<HTMLDivElement>
  /** Explicit board-coord placement, or null for the default bottom-right. */
  pos: { x: number; y: number } | null
  onMove: (pos: { x: number; y: number }) => void
  onInteract: (state: false | string) => void
  onJump: (wx: number, wy: number) => void
  /** Panes with an unanswered question — drawn pulsing, whatever their kind. */
  alerts?: Set<string>
  t: (k: any, p?: any) => string
}) {
  const MM_W = 190, MM_H = 130, PAD = 10
  const boxRef = useRef<HTMLDivElement>(null)

  // Drag the minimap by its grip. Screen-space pixel math like the tool rail —
  // no camera involved — clamped to the board so it can't be lost off-edge.
  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const box = boxRef.current, board = rootRef.current
    if (!box || !board) return
    const rect = box.getBoundingClientRect()
    const boardRect = board.getBoundingClientRect()
    const grabX = e.clientX - rect.left
    const grabY = e.clientY - rect.top
    onInteract('grabbing')
    startPointerDrag(
      (ev) => {
        const x = clamp(ev.clientX - boardRect.left - grabX, 4, Math.max(4, boardRect.width - rect.width - 4))
        const y = clamp(ev.clientY - boardRect.top - grabY, 4, Math.max(4, boardRect.height - rect.height - 4))
        onMove({ x, y })
      },
      () => onInteract(false),
    )
  }

  // Default corner until dragged, then an explicit position (right/bottom cleared
  // so left/top win).
  const boxStyle: React.CSSProperties = pos
    ? { ...styles.minimap, right: 'auto', bottom: 'auto', left: pos.x, top: pos.y }
    : styles.minimap
  const rect = rootRef.current?.getBoundingClientRect()
  const vw = rect?.width ?? 1200, vh = rect?.height ?? 800
  // Current viewport rect in world coords.
  const viewX = -camera.x / camera.zoom, viewY = -camera.y / camera.zoom
  const viewW = vw / camera.zoom, viewH = vh / camera.zoom
  // Union bounds of items + viewport.
  const xs = [viewX, viewX + viewW, ...items.map(i => i.x), ...items.map(i => i.x + i.w)]
  const ys = [viewY, viewY + viewH, ...items.map(i => i.y), ...items.map(i => i.y + i.h)]
  const minX = Math.min(...xs), minY = Math.min(...ys)
  const maxX = Math.max(...xs), maxY = Math.max(...ys)
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY)
  const scale = Math.min((MM_W - PAD * 2) / bw, (MM_H - PAD * 2) / bh)
  const offX = PAD + ((MM_W - PAD * 2) - bw * scale) / 2
  const offY = PAD + ((MM_H - PAD * 2) - bh * scale) / 2
  const toMini = (wx: number, wy: number) => ({ x: offX + (wx - minX) * scale, y: offY + (wy - minY) * scale })

  const kindColor = (k: CanvasItem['kind']) =>
    k === 'terminal' ? '#7fc8a0' : k === 'browser' ? '#7fb0e8' : k === 'device' ? '#9db0e8' : k === 'note' ? '#f4c95d'
    : k === 'image' ? '#c89be0' : k === 'draw' ? '#e88ba5' : k === 'frame' ? '#5c534c' : '#e8956b'

  const jump = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    onJump(minX + (mx - offX) / scale, minY + (my - offY) / scale)
  }

  return (
    <div ref={boxRef} style={boxStyle}>
      {/* Drag grip — the map area still jumps the camera, so dragging lives on
          this handle. */}
      <div style={styles.minimapGrip} onPointerDown={startDrag} title={t('canvas.minimap.drag')}>
        <span style={styles.minimapGripDots}>⠿</span>
      </div>
      <svg width={MM_W} height={MM_H} style={{ display: 'block', cursor: 'pointer' }} onPointerDown={jump}>
        {items.map(i => {
          const p = toMini(i.x, i.y)
          // A pane waiting on an answer can be anywhere on an infinite board;
          // the minimap is the one place that shows all of it at once, so this
          // is where the signal belongs. Pulsing rather than merely coloured:
          // the map is a field of small rectangles and a static one would be
          // just another colour among six.
          const alert = !!i.paneId && !!alerts?.has(i.paneId)
          return (
            <rect
              key={i.id}
              className={alert ? 'canvas-attention-dot' : undefined}
              x={p.x} y={p.y}
              width={Math.max(2, i.w * scale)} height={Math.max(2, i.h * scale)}
              rx={1.5}
              fill={alert ? '#f4c95d' : kindColor(i.kind)}
              stroke={alert ? '#f4c95d' : undefined}
              strokeWidth={alert ? 2 : undefined}
              opacity={0.85}
            />
          )
        })}
        {(() => { const p = toMini(viewX, viewY); return (
          <rect x={p.x} y={p.y} width={viewW * scale} height={viewH * scale} fill="rgba(232,149,107,0.12)" stroke="var(--accent)" strokeWidth={1.2} rx={2} />
        ) })()}
      </svg>
    </div>
  )
}

// ── CanvasCard ──────────────────────────────────────────────────────────────

interface CanvasCardProps {
  item: CanvasItem
  selected: boolean
  zoom: number
  onDragStart: (e: React.PointerEvent, id: string) => void
  onResizeStart: (e: React.PointerEvent, id: string, dir: ResizeDir) => void
  onSelect: (id: string, additive: boolean) => void
  onRemove: (id: string) => void
  onMaximize: (id: string) => void
  onUpdate: (id: string, patch: Partial<CanvasItem>) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  /** A browser/device card was screenshotted (null = capture failed). Takes the
   *  source item so the board can hand one stable handler to every card. */
  onCapture: (item: CanvasItem, dataUrl: string | null) => void
  /** The backing task row for a task card (live-polled), and its title editor. */
  task?: KanbanTask
  onTaskRename?: (taskId: string, title: string) => void
  noteColors: string[]
  /** Background transparency for this card (1 = opaque). Content never fades. */
  alpha: number
  /** Fill the whole board, in place — see the geometry note below. */
  maximized?: boolean
  camera?: Camera
  viewport?: { w: number; h: number }
  /** Focus mode placement: a screen rect, 'hidden', or null when focus is off. */
  focusRect?: ScreenRect | 'hidden' | null
  isFocusStage?: boolean
  /** Present only on terminal cards; takes the item id so it stays stable. */
  onFocus?: (id: string) => void
  /** Semantic zoom: render this terminal as a status tile, not a live view. */
  tile?: boolean
  /** Title of the task this pane is currently on — the tile's subtitle. */
  tileTask?: string
  /** This pane has an unanswered question (drives the card's alert ring). */
  needsAttention?: boolean
  /** Race participation, when this pane is one of the attempts. */
  race?: { index: number; total: number; state: string; stat: AttemptStat | undefined }
  raceBusy?: boolean
  onRaceKeep?: (paneId: string) => void
  /** Frame only: what it contains, and how many of those are live agents. */
  frameChildCount?: number
  framePaneCount?: number
  onFrameSend?: (id: string) => void
  t: (k: any, p?: any) => string
}

// Geometry that makes a card cover the viewport **without leaving the world
// layer** — the point being that it stays the same mounted React subtree, so a
// terminal's xterm (and its live pty subscription) and a browser's webview are
// untouched by maximizing.
//
// The world is `translate(cam) scale(zoom)`, so the viewport's top-left corner
// is at world (-cam.x/zoom, -cam.y/zoom). Sizing the card in *screen* pixels and
// counter-scaling by 1/zoom leaves its content rendering at exactly 1:1 no
// matter how far the board is zoomed — a maximized terminal must never be a
// scaled-up bitmap of a small one.
function screenAnchored(rect: ScreenRect, camera: Camera, zIndex: number): React.CSSProperties {
  return {
    left: (rect.x - camera.x) / camera.zoom,
    top: (rect.y - camera.y) / camera.zoom,
    width: rect.w,
    height: rect.h,
    transform: `scale(${1 / camera.zoom})`,
    transformOrigin: '0 0',
    zIndex,
  }
}

function maximizedGeometry(camera: Camera, viewport: { w: number; h: number }): React.CSSProperties {
  return screenAnchored({ x: 0, y: 0, w: viewport.w, h: viewport.h }, camera, 999999)
}

// Memoised, and the callers above go to some trouble to keep that meaningful:
// every handler is hoisted to a stable useCallback and the drag reducers hand
// back the *same* item object for cards they didn't move. A card that isn't
// moving therefore re-renders on none of the ~60 state commits a drag produces,
// which is what keeps the live terminals out of the drag's critical path.
//
// (Focus mode is the one exception: its geometry is recomputed each render, so
// `focusRect` is a fresh object and the cards fall back to re-rendering. Focus
// mode freezes the camera and hides all but the docked cards, so there is no
// drag going on to make it matter.)
const CanvasCard = React.memo(function CanvasCard({ item, selected, zoom, alpha, maximized, camera, viewport, focusRect, isFocusStage, onFocus, onDragStart, onResizeStart, onSelect, onRemove, onMaximize, onUpdate, onContextMenu, onCapture, task, onTaskRename, noteColors, tile, tileTask, needsAttention, race, raceBusy, onRaceKeep, frameChildCount, framePaneCount, onFrameSend, t }: CanvasCardProps) {
  const isShape = item.kind === 'shape'
  const isFrame = isFrameKind(item.kind)
  const frameless = (isShape || item.kind === 'text') && !maximized && !focusRect
  // Task cards wear their status as a coloured ring so the board reads as a
  // pipeline at a glance, even zoomed out.
  const statusRing = item.kind === 'task' && task && !selected ? taskStatusColor(task.status) : null

  // Focus mode wins over maximize: both are "place this card in screen space",
  // and entering focus clears any maximize anyway.
  //
  // A card that focus mode takes out of view is display:none'd, NOT unmounted —
  // that keeps a terminal's xterm, its pty subscription and a browser's page
  // state alive, so leaving focus mode restores the board instantly instead of
  // rebuilding every card on it.
  const focusStyle = focusRect && camera
    ? (focusRect === 'hidden'
        ? { display: 'none' as const }
        : screenAnchored(focusRect, camera, isFocusStage ? 900000 : 899000))
    : null
  const maxStyle = !focusRect && maximized && camera && viewport && viewport.w > 0
    ? maximizedGeometry(camera, viewport)
    : null
  // Both modes place the card by computed geometry, so the drag/resize
  // affordances have to stand down.
  const placed = !!maxStyle || (!!focusStyle && focusRect !== 'hidden')
  const immovable = placed || !!item.locked
  // A maximized card fills the screen, so transparency there would just show the
  // rest of the app behind it — always opaque.
  const effAlpha = maxStyle ? 1 : alpha

  // ── Frame ──
  // A different shape of object, so a different render rather than six more
  // conditionals in the card body. The critical property: the frame's *interior*
  // is pointer-transparent. It sits behind the cards, so an opaque body would
  // swallow every click on empty space inside it — no marquee select, no
  // right-click "add here", inside the very region you organise work in. Only
  // the header and the resize handles take the pointer, exactly like Figma.
  if (isFrame) {
    // Focus mode places terminals in screen space; a frame lives in world
    // coordinates and would hang over the stage outlining nothing. Unmounting is
    // free here (it's a div and an input, not a pty), same as the ink.
    if (focusRect) return null
    const accent = item.color || 'var(--accent)'
    const kids = frameChildCount ?? 0
    const panes = framePaneCount ?? 0
    // The label is a **sibling** of the region, not a child, and sits above it —
    // see FRAME_LABEL_Z. A frame is by definition underneath a pile of cards, so
    // a label inside its stacking context would be buried by the first card
    // dropped on it, leaving the frame with no way to be grabbed or renamed.
    // It's drawn just outside the top edge, like Figma's artboard name, so it
    // covers nothing the frame contains.
    const labelH = FRAME_HEADER_H / Math.max(zoom, 0.25)
    return (
      <>
        <div
          data-canvas-frame-label
          style={{
            ...styles.frameHeader,
            position: 'absolute',
            left: item.x, top: item.y - labelH - 4 / Math.max(zoom, 0.25),
            width: item.w, height: labelH,
            zIndex: FRAME_LABEL_Z,
            borderRadius: 10 / Math.max(zoom, 0.25),
            fontSize: 12.5 / Math.max(zoom, 0.25),
            color: accent,
            border: `${(selected ? 1.6 : 1) / Math.max(zoom, 0.25)}px solid ${selected ? 'var(--accent)' : `color-mix(in srgb, ${accent} 45%, transparent)`}`,
            ...(item.locked ? { cursor: 'default' } : null),
          }}
          onPointerDown={(e) => {
            onSelect(item.id, e.shiftKey)
            if (e.button === 0 && !item.locked && !e.shiftKey) onDragStart(e, item.id)
          }}
          onContextMenu={(e) => onContextMenu(e, item.id)}
        >
          {item.locked && <span style={{ ...styles.lockMark, position: 'static' }}><IconLock /></span>}
          <FrameName
            value={item.text ?? ''}
            accent={accent}
            placeholder={t('canvas.frame.defaultName')}
            onChange={(text) => onUpdate(item.id, { text })}
          />
          <span style={{ ...styles.frameCount, fontSize: '0.85em' }} title={t('canvas.frame.contains', { n: kids, agents: panes })}>
            {kids}{panes > 0 ? ` · ${panes}◍` : ''}
          </span>
          {panes > 0 && onFrameSend && (
            <button
              style={{ ...styles.cardHdrBtn, color: accent, width: '1.7em', height: '1.7em' }}
              title={t('canvas.frame.broadcast', { n: panes })}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onFrameSend(item.id)}
            ><IconSend /></button>
          )}
          <button
            style={{ ...styles.cardHdrBtn, width: '1.7em', height: '1.7em' }}
            title={t('canvas.removeCard')}
            onPointerDown={e => e.stopPropagation()}
            onClick={() => onRemove(item.id)}
          >✕</button>
        </div>
        <div
          data-canvas-card
          data-canvas-frame
          style={{
            position: 'absolute',
            left: item.x, top: item.y, width: item.w, height: item.h,
            zIndex: FRAME_Z,
            borderRadius: 14,
            border: `${selected ? 2 : 1.5}px solid ${selected ? 'var(--accent)' : accent}`,
            background: `color-mix(in srgb, ${accent} 5%, transparent)`,
            // The interior is deliberately pointer-transparent. The frame sits
            // *behind* the cards, so an opaque body would swallow every click on
            // empty space inside it — no marquee select, no right-click "add
            // here" — inside the very region you organise work in.
            pointerEvents: 'none',
          }}
        >
          {!item.locked && RESIZE_DIRS.map(dir => (
            <div
              key={dir}
              onPointerDown={(e) => onResizeStart(e, item.id, dir)}
              style={{ ...resizeHandleStyle(dir, zoom), pointerEvents: 'auto', ...(selected ? selectedHandleSkin(dir, zoom) : null) }}
            />
          ))}
        </div>
      </>
    )
  }

  return (
    <div
      data-canvas-card
      style={{
        position: 'absolute',
        left: item.x, top: item.y, width: item.w, height: item.h,
        zIndex: item.z,
        borderRadius: frameless ? 0 : 12,
        // A pane with an unanswered question outranks its task-status ring: one
        // is "where this is in the pipeline", the other is "you are the blocker".
        outline: isFocusStage ? '2px solid var(--accent)'
          : selected ? '2px solid var(--accent)'
          : needsAttention ? `2px solid ${TILE_STATE_COLOR.waiting}`
          : statusRing ? `2px solid ${statusRing}` : 'none',
        outlineOffset: 2,
        display: 'flex', flexDirection: 'column',
        boxShadow: frameless ? 'none' : '0 8px 30px rgba(0,0,0,0.5)',
        // Transparency is NOT applied here as `opacity`: that would fade the
        // terminal text along with the background and make it unreadable. The
        // card paints nothing itself and a separate backdrop layer below
        // carries the alpha, leaving all content at full opacity.
        background: 'transparent',
        overflow: 'visible',
        ...maxStyle,
        ...focusStyle,
      }}
      // Shift is forwarded so clicking a card's *body* adds to the selection
      // exactly like clicking its header does — the drag handler owns the
      // header (it stops propagation), so without this the two halves of the
      // same card would disagree about what Shift means.
      //
      // **Primary button only.** A right-click reaches here too (the header's
      // handler ignores non-primary buttons and doesn't stop propagation), and
      // selecting on it collapsed a multi-selection to the one card under the
      // cursor *before* `onContextMenu` ran — which silently disabled every
      // set-wide action in the menu (`selectForMenu` exists precisely to
      // preserve the selection, and never saw one bigger than 1). Right-click
      // selection is that handler's job, not this one's.
      onPointerDown={(e) => { if (e.button === 0) onSelect(item.id, e.shiftKey) }}
      onContextMenu={(e) => onContextMenu(e, item.id)}
    >
      {/* Backdrop — the ONLY thing transparency touches. Sits behind every
          sibling (they're later in the flow and form the stacking order), so
          the terminal's glyphs, the header and the buttons all stay fully
          opaque and readable no matter how low the alpha goes. */}
      {!frameless && (
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0, borderRadius: 12,
            background: 'var(--bg-panel)', opacity: effAlpha, pointerEvents: 'none',
            // Explicit 0 against the content's 1: a positioned child would
            // otherwise paint *over* its in-flow siblings and hide them.
            zIndex: 0,
          }}
        />
      )}

      {/* Race chip — which attempt this card is, how big it is, and the button
          that ends the race in its favour. Anchored above the card rather than
          squeezed into the header: at the zoom where you compare attempts the
          header is a few pixels tall, and this has to stay hittable. */}
      {race && !focusRect && !maxStyle && (
        <div style={{ ...styles.raceChip, transform: `scale(${1 / Math.max(zoom, 0.2)})` }} onPointerDown={e => e.stopPropagation()}>
          <span style={{ ...styles.raceChipDot, background: RACE_STATE_COLOR[race.state] ?? 'var(--text-muted)' }} />
          <span style={styles.raceChipIdx}>{race.index}/{race.total}</span>
          <span style={styles.raceChipStat}>
            {race.stat && race.stat.files.length > 0
              ? t('race.stat', { files: String(race.stat.files.length), churn: String(churn(race.stat)) })
              : t('race.noChanges')}
          </span>
          {onRaceKeep && item.paneId && (
            <button
              style={{ ...styles.raceChipBtn, ...(race.state === 'ready' && !raceBusy ? null : { opacity: 0.45, cursor: 'default' }) }}
              disabled={race.state !== 'ready' || !!raceBusy}
              onClick={() => onRaceKeep(item.paneId!)}
            >{t('race.keep')}</button>
          )}
        </div>
      )}

      {/* Header / drag handle — shapes & text drag from anywhere.
          Hidden in tile mode: at the zoom where tiles exist the header is a
          three-pixel strip nobody can read or click, and the tile below says
          everything it would have. */}
      {!frameless && !tile && (
        <div
          style={{
            ...styles.cardHeader, position: 'relative', zIndex: 1,
            // Let the faded backdrop show through the title bar too, so the
            // whole card reads as translucent — its text stays fully opaque.
            ...(effAlpha < 1 ? { background: 'transparent' } : null),
            ...(immovable ? { cursor: 'default' } : null),
          }}
          // Dragging/resizing a card that's placed by computed geometry
          // (maximized or in focus mode) is meaningless and would fight that
          // geometry, so both are inert — as they are for a locked card.
          onPointerDown={(e) => { if (e.button === 0 && !immovable) onDragStart(e, item.id) }}
          onDoubleClick={() => { if (!focusRect) onMaximize(item.id) }}
        >
          {!immovable && <span style={styles.grip}><GripDots /></span>}
          {item.locked && <span style={styles.lockMark} title={t('canvas.ctx.unlock')}><IconLock /></span>}
          <span style={styles.cardLabel}>{cardLabel(item, t)}</span>
          <div style={{ flex: 1 }} />
          {/* Focus: this terminal takes the stage, the others queue up on the
              right. Offered on every terminal card, including the docked ones —
              clicking one there is how you swap which is on stage. */}
          {onFocus && (
            <button
              style={{ ...styles.cardHdrBtn, ...(isFocusStage ? { color: 'var(--accent)' } : null) }}
              title={isFocusStage ? t('canvas.focus.exit') : t('canvas.focus.enter')}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onFocus(item.id)}
            ><IconFocus /></button>
          )}
          {(item.kind === 'terminal' || maxStyle) && !focusRect && (
            <button
              style={styles.cardHdrBtn}
              title={maxStyle ? t('canvas.restore') : t('canvas.maximize')}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onMaximize(item.id)}
            >{maxStyle ? '⤡' : '⤢'}</button>
          )}
          {!focusRect && (
            <button style={styles.cardHdrBtn} title={t('canvas.removeCard')} onPointerDown={e => e.stopPropagation()} onClick={() => onRemove(item.id)}>✕</button>
          )}
        </div>
      )}

      {/* Body */}
      <div
        style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', overflow: frameless ? 'visible' : 'hidden', position: 'relative', zIndex: 1 }}
        // Shapes/text are dragged by their body since they have no header — and
        // so is a tile, whose header is hidden. Without this, zooming out far
        // enough to see the whole board would be exactly the point at which the
        // cards stopped being movable, which is backwards.
        onPointerDown={
          tile ? (e) => { if (e.button === 0 && !immovable) onDragStart(e, item.id) }
          : frameless ? (e) => { if (e.button === 0 && item.kind !== 'text' && !immovable) onDragStart(e, item.id) }
          : undefined
        }
        // Same gesture the (hidden) header offers: double-click to maximize, so
        // a tile you want to read is one action away from being readable.
        onDoubleClick={tile ? () => onMaximize(item.id) : undefined}
      >
        <CardBody item={item} onUpdate={onUpdate} onDragStart={onDragStart} onCapture={(d) => onCapture(item, d)} task={task} onTaskRename={onTaskRename} noteColors={noteColors} alpha={effAlpha} t={t} maximized={!!maxStyle || isFocusStage} tile={!!tile} tileTask={tileTask} zoom={zoom} />
        {/* frameless move/delete affordances when selected (text can't drag from
            its body — the textarea captures the pointer for editing). */}
        {frameless && selected && (
          <>
            <span
              style={{ ...styles.cardHdrBtn, position: 'absolute', top: -26, left: 0, background: 'var(--bg-panel)', borderRadius: 6, cursor: 'grab', color: 'var(--text-dim)' }}
              onPointerDown={(e) => { if (e.button === 0) onDragStart(e, item.id) }}
              title={t('canvas.tool.select')}
            ><GripDots /></span>
            <button
              style={{ ...styles.cardHdrBtn, position: 'absolute', top: -26, right: 0, background: 'var(--bg-panel)', borderRadius: 6 }}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onRemove(item.id)}
              title={t('canvas.removeCard')}
            >✕</button>
          </>
        )}
      </div>

      {/* Resize handles — all 8 edges/corners. Sized in *screen* px (divided by
          zoom) so they stay grabbable when zoomed far out, and only painted
          while the card is selected so the board stays clean. */}
      {!immovable && RESIZE_DIRS.map(dir => (
        <div
          key={dir}
          onPointerDown={(e) => onResizeStart(e, item.id, dir)}
          style={{ ...resizeHandleStyle(dir, zoom), ...(selected ? selectedHandleSkin(dir, zoom) : null) }}
        />
      ))}
    </div>
  )
})

// Geometry for one resize handle. Corners are square grab targets pinned to the
// corner; edges are thin strips spanning the side between them.
function resizeHandleStyle(dir: ResizeDir, zoom: number): React.CSSProperties {
  const grab = 14 / zoom      // corner hit box
  const thick = 8 / zoom      // edge strip thickness
  const inset = -thick / 2    // straddle the border so both sides are grabbable
  const base: React.CSSProperties = {
    position: 'absolute', zIndex: 6, cursor: RESIZE_CURSOR[dir], touchAction: 'none',
  }
  const corner = { width: grab, height: grab }
  switch (dir) {
    case 'nw': return { ...base, ...corner, left: -grab / 2, top: -grab / 2 }
    case 'ne': return { ...base, ...corner, right: -grab / 2, top: -grab / 2 }
    case 'sw': return { ...base, ...corner, left: -grab / 2, bottom: -grab / 2 }
    case 'se': return { ...base, ...corner, right: -grab / 2, bottom: -grab / 2 }
    // Edges stop short of the corners so the corner handles win the overlap.
    case 'n': return { ...base, top: inset, left: grab / 2, right: grab / 2, height: thick }
    case 's': return { ...base, bottom: inset, left: grab / 2, right: grab / 2, height: thick }
    case 'w': return { ...base, left: inset, top: grab / 2, bottom: grab / 2, width: thick }
    case 'e': return { ...base, right: inset, top: grab / 2, bottom: grab / 2, width: thick }
  }
}

// Visible dot on the four corners when selected — the edges stay invisible
// (their cursor is the affordance) so the card outline isn't cluttered.
function selectedHandleSkin(dir: ResizeDir, zoom: number): React.CSSProperties | null {
  if (dir.length !== 2) return null
  const d = 8 / zoom
  return {
    background: 'var(--accent)',
    border: `${1 / zoom}px solid var(--bg-panel)`,
    borderRadius: d,
    width: d, height: d,
    // Re-centre on the corner now that the box shrank from `grab` to `d`.
    marginLeft: dir.includes('w') ? (14 / zoom - d) / 2 : 0,
    marginRight: dir.includes('e') ? (14 / zoom - d) / 2 : 0,
    marginTop: dir.includes('n') ? (14 / zoom - d) / 2 : 0,
    marginBottom: dir.includes('s') ? (14 / zoom - d) / 2 : 0,
  }
}

// ── CardBody — the type-specific content ────────────────────────────────────

function CardBody({ item, onUpdate, onDragStart, onCapture, task, onTaskRename, noteColors, alpha = 1, t, maximized, tile, tileTask, zoom = 1 }: {
  item: CanvasItem
  onUpdate: (id: string, patch: Partial<CanvasItem>) => void
  onDragStart?: (e: React.PointerEvent, id: string) => void
  onCapture?: (dataUrl: string | null) => void
  task?: KanbanTask
  onTaskRename?: (taskId: string, title: string) => void
  noteColors: string[]
  alpha?: number
  t: (k: any, p?: any) => string
  maximized?: boolean
  tile?: boolean
  tileTask?: string
  zoom?: number
}) {
  // Maximized fills the screen, so transparency there would just show the app
  // behind it — always render the maximized view opaque.
  if (item.kind === 'terminal' && item.paneId) {
    // Semantic zoom. The live terminal is **kept mounted** behind a
    // `display:none` — the whole reason the tile is affordable is that swapping
    // to it costs nothing: unmounting would dispose the xterm and rebuild it on
    // the way back in, which is exactly the thrash the tile exists to avoid.
    return (
      <>
        <div style={{ display: tile ? 'none' : 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
          <CanvasTerminal paneId={item.paneId} alpha={maximized ? 1 : alpha} />
        </div>
        {tile && <CanvasTerminalTile paneId={item.paneId} card={item} zoom={zoom} taskTitle={tileTask} t={t} />}
      </>
    )
  }
  if (item.kind === 'browser') return <CanvasBrowser item={item} onUpdate={onUpdate} onCapture={onCapture} t={t} />
  if (item.kind === 'device') return <CanvasDevice item={item} onUpdate={onUpdate} onCapture={onCapture} t={t} />
  if (item.kind === 'note') return <CanvasNote item={item} onUpdate={onUpdate} noteColors={noteColors} />
  if (item.kind === 'text') return <CanvasText item={item} onUpdate={onUpdate} onDragStart={onDragStart} />
  if (item.kind === 'shape') return <CanvasShape item={item} onUpdate={onUpdate} />
  if (item.kind === 'image') return <CanvasImage item={item} />
  if (item.kind === 'task') return <CanvasTask task={task} onRename={(title) => item.taskId && onTaskRename?.(item.taskId, title)} t={t} />
  return null
}

// Task card — the board's window onto a real row in the tasks table. Shows the
// (inline-editable) title, a live status badge, and the assigned agent; the
// coloured ring around the whole card (in CanvasCard) carries the status at a
// glance. Assignment / status / dependencies are driven from the context menu
// and connectors — this is just the display + title editor.
function CanvasTask({ task, onRename, t }: { task?: KanbanTask; onRename: (title: string) => void; t: (k: any, p?: any) => string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (!task) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 11 }}>…</div>
  }
  const color = taskStatusColor(task.status)
  const deps = parseDeps(task.depends_on).length
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg-panel)', borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onRename(draft); setEditing(false) }
            else if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
          }}
          onBlur={() => { onRename(draft); setEditing(false) }}
          style={{ resize: 'none', flex: 1, minHeight: 0, background: 'var(--bg-base)', border: '1px solid var(--accent)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', lineHeight: 1.4, padding: '5px 7px', outline: 'none' }}
        />
      ) : (
        <div
          onDoubleClick={() => { setDraft(task.title); setEditing(true) }}
          title={t('canvas.task.editHint')}
          style={{ flex: 1, minHeight: 0, overflow: 'auto', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.35, cursor: 'text', wordBreak: 'break-word' }}
        >
          {task.title}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color, padding: '2px 8px', borderRadius: 999, background: 'color-mix(in srgb, currentColor 14%, transparent)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
          {t(`kanban.col.${task.status}` as any)}
        </span>
        {task.assigned_agent && (
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-secondary)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)' }}>
            @{task.assigned_agent}
          </span>
        )}
        {deps > 0 && (
          <span title={t('canvas.task.deps', { n: deps })} style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-dim)' }}>⟝ {deps}</span>
        )}
      </div>
    </div>
  )
}

// Image card — a pasted / dropped / picked picture.
function CanvasImage({ item }: { item: CanvasItem }) {
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
      {item.src
        ? <img src={item.src} alt="" draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', userSelect: 'none' }} />
        : <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>—</span>}
    </div>
  )
}

// Terminal — a real, live agent pane bound to a rootPane leaf.
//
// Transparency is background-only: the terminal's own backdrop is a separate
// faded layer and xterm is told to paint no background of its own
// (`transparentBg`), so glyphs render at full opacity over it and stay readable
// at any alpha.
// Memoised on two scalar props, which makes it the backstop for the whole
// board: whatever else re-renders — a card whose memo missed, focus mode's fresh
// geometry — an AgentPane and its xterm are only rebuilt when this pane's id or
// transparency actually changes.
const CanvasTerminal = React.memo(function CanvasTerminal({ paneId, alpha = 1 }: { paneId: string; alpha?: number }) {
  const splitPane = useWorkspaceStore(s => s.splitPane)
  const closePane = useWorkspaceStore(s => s.closePane)
  const agentId = useWorkspaceStore(s => findLeaf(s.rootPane, paneId)?.agentId ?? null) as AgentId | null
  const ptyStatus = useWorkspaceStore(s => findLeaf(s.rootPane, paneId)?.ptyStatus ?? 'idle') as PtyStatus
  const paneCwd = useWorkspaceStore(s => findLeaf(s.rootPane, paneId)?.cwd ?? null)
  const translucent = alpha < 1
  return (
    <div style={{
      flex: 1, minWidth: 0, minHeight: 0, display: 'flex', position: 'relative',
      background: translucent ? 'transparent' : 'var(--bg-terminal)',
      borderRadius: '0 0 12px 12px', overflow: 'hidden',
    }}>
      {translucent && (
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
            background: 'var(--bg-terminal)', opacity: alpha,
          }}
        />
      )}
      {/* zIndex 1 keeps the pane above the positioned backdrop. */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', position: 'relative', zIndex: 1 }}>
        <AgentPane
          paneId={paneId}
          agentId={agentId}
          ptyStatus={ptyStatus}
          paneCwd={paneCwd}
          transparentBg={translucent}
          onSplitH={() => splitPane(paneId, 'horizontal')}
          onSplitV={() => splitPane(paneId, 'vertical')}
          onClose={() => closePane(paneId)}
        />
      </div>
    </div>
  )
})

// A frame's name: a label until you double-click it, then an input.
//
// It cannot be a permanently-live input, even though that reads simpler: the
// name spans nearly the whole label strip, and an input swallows the pointer for
// text selection — so the one element you grab a frame by would be the one
// element you can't drag it with. Double-click to edit is the same contract
// every other title on this board uses (pane titles, task cards).
function FrameName({ value, accent, placeholder, onChange }: {
  value: string
  accent: string
  placeholder: string
  onChange: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  if (!editing) {
    return (
      <span
        onDoubleClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true) }}
        title={placeholder}
        style={{
          ...styles.frameName, color: accent, fontSize: 'inherit',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          opacity: value ? 1 : 0.6,
        }}
      >{value || placeholder}</span>
    )
  }
  const commit = () => { onChange(draft.trim()); setEditing(false) }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') setEditing(false)
      }}
      onBlur={commit}
      placeholder={placeholder}
      style={{ ...styles.frameName, color: accent, fontSize: 'inherit' }}
    />
  )
}

// ── Terminal status tile (semantic zoom) ────────────────────────────────────
//
// What a terminal card becomes when the board is zoomed out past the point
// where its text can be read: agent, state, current task, spend. The board stops
// being eight smears of unreadable glyphs and becomes a dashboard — same cards,
// same running ptys, different altitude.
//
// Every size here comes from `tileMetrics`, in *world* units derived from a
// screen target: the tile is inside the camera-scaled world layer, so a literal
// `fontSize: 13` would render at four pixels at the only zooms where this
// component is ever mounted.
const CanvasTerminalTile = React.memo(function CanvasTerminalTile({ paneId, card, zoom, taskTitle, t }: {
  paneId: string
  card: { w: number; h: number }
  zoom: number
  taskTitle?: string
  t: (k: any, p?: any) => string
}) {
  const leaf = useWorkspaceStore(s => findLeaf(s.rootPane, paneId))
  const attention = useWorkspaceStore(s => s.paneAttention[paneId] ?? null)
  const cost = useWorkspaceStore(s => s.paneCost[paneId]?.usd)
  const state: TileState = tileState({ ptyStatus: leaf?.ptyStatus ?? 'idle', attention })
  const color = TILE_STATE_COLOR[state]
  const m = tileMetrics(zoom, card)
  const title = leaf?.title?.trim() || leaf?.agentId || t('pane.noAgent')
  const spend = tileCost(cost)

  return (
    <div
      data-canvas-tile={state}
      style={{
        flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        justifyContent: 'center', gap: m.gap, padding: m.pad, overflow: 'hidden',
        background: 'var(--bg-panel)', borderRadius: 12,
        // A hairline of the state colour down the left edge, so a wall of tiles
        // can be read as a status column before any of the text is.
        boxShadow: `inset ${Math.max(2, m.dot / 2)}px 0 0 ${color}`,
      }}
    >
      {m.showTitle && (
        <div style={{ display: 'flex', alignItems: 'center', gap: m.gap, minWidth: 0 }}>
          <span style={{ width: m.dot, height: m.dot, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{
            fontSize: m.title, fontWeight: 700, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{title}</span>
        </div>
      )}
      {m.showMeta && (
        <>
          <div style={{
            fontSize: m.meta, color, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: m.meta * 0.06, whiteSpace: 'nowrap',
          }}>
            {t(`canvas.tile.${state}` as 'canvas.tile.idle')}
          </div>
          {taskTitle && (
            <div style={{
              fontSize: m.meta, color: 'var(--text-secondary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{taskTitle}</div>
          )}
          {spend && (
            <div style={{ fontSize: m.meta, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>{spend}</div>
          )}
        </>
      )}
    </div>
  )
})

const normalizeUrl = (raw: string): string => {
  const s = raw.trim()
  if (!s) return s
  if (/^https?:\/\//i.test(s)) return s
  if (/^:?\d{2,5}$/.test(s)) return 'http://localhost:' + s.replace(/^:/, '')
  if (/^localhost(:\d+)?/i.test(s) || /^\d+\.\d+\.\d+\.\d+/.test(s)) return 'http://' + s
  return 'http://' + s
}

const tabTitle = (url: string): string =>
  url.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'about:blank'

// Browser — one or more pages behind a tab strip, each an embedded webview.
// Every tab stays mounted and only the active one is visible, so switching
// tabs preserves scroll position, form state and any running app in the page.
function CanvasBrowser({ item, onUpdate, onCapture, t }: { item: CanvasItem; onUpdate: (id: string, patch: Partial<CanvasItem>) => void; onCapture?: (dataUrl: string | null) => void; t: (k: any, p?: any) => string }) {
  const tabs = browserTabs(item)
  const active = activeBrowserTab(item)
  const [input, setInput] = useState(active.url)
  const [loading, setLoading] = useState(false)
  // One webview handle per tab id, so nav buttons address the visible page.
  const viewRefs = useRef<Record<string, any>>({})

  // Follow the active tab's URL (tab switch, or an external update).
  useEffect(() => { setInput(active.url) }, [active.id, active.url])

  // Track load state of the *active* tab only; re-bound on every tab switch.
  useEffect(() => {
    const wv = viewRefs.current[active.id]
    if (!wv) return
    const on = () => setLoading(true)
    const off = () => setLoading(false)
    wv.addEventListener('did-start-loading', on)
    wv.addEventListener('did-stop-loading', off)
    return () => {
      wv.removeEventListener('did-start-loading', on)
      wv.removeEventListener('did-stop-loading', off)
    }
  }, [active.id])

  // Write a patch to one tab, keeping the legacy single-URL field in sync with
  // whichever tab is active so an un-stacked / older reader still sees a url.
  const patchTab = (tabId: string, url: string) => {
    const next = tabs.map(tb => tb.id === tabId ? { ...tb, url } : tb)
    onUpdate(item.id, {
      tabs: next,
      activeTab: item.activeTab ?? tabs[0].id,
      ...(tabId === active.id ? { url } : null),
    })
  }

  const go = (raw: string) => {
    const url = normalizeUrl(raw)
    if (!url) return
    setInput(url)
    patchTab(active.id, url)
    const wv = viewRefs.current[active.id]
    try { if (wv?.loadURL) wv.loadURL(url); else if (wv) wv.src = url } catch { /* not ready */ }
  }

  const selectTab = (id: string) => onUpdate(item.id, {
    tabs, activeTab: id, url: tabs.find(tb => tb.id === id)?.url ?? item.url,
  })

  const addTab = () => {
    const tb: BrowserTab = { id: uuidv4(), url: 'http://localhost:3000' }
    onUpdate(item.id, { tabs: [...tabs, tb], activeTab: tb.id, url: tb.url })
  }

  const closeTab = (id: string) => {
    if (tabs.length <= 1) return  // never leave a browser card with no page
    const idx = tabs.findIndex(tb => tb.id === id)
    const next = tabs.filter(tb => tb.id !== id)
    delete viewRefs.current[id]
    const nextActive = id === active.id ? next[Math.min(idx, next.length - 1)] : active
    onUpdate(item.id, { tabs: next, activeTab: nextActive.id, url: nextActive.url })
  }

  const withActive = (fn: (wv: any) => void) => {
    try { const wv = viewRefs.current[active.id]; if (wv) fn(wv) } catch { /* not ready */ }
  }

  // Screenshot the visible page → a canvas image item (see handleCapture).
  const capture = async () => {
    const wv = viewRefs.current[active.id]
    try {
      const img = wv?.capturePage ? await wv.capturePage() : null
      const url = img?.toDataURL?.()
      onCapture?.(url && url.length > 200 ? url : null)
    } catch { onCapture?.(null) }
  }

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
      {/* Tab strip — only once there's more than one page to choose between. */}
      {tabs.length > 1 && (
        <div style={styles.tabStrip} onPointerDown={e => e.stopPropagation()}>
          {tabs.map(tb => {
            const on = tb.id === active.id
            return (
              <div
                key={tb.id}
                onClick={() => selectTab(tb.id)}
                title={tb.url}
                style={{ ...styles.browserTab, ...(on ? styles.browserTabActive : null) }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tabTitle(tb.url)}</span>
                <span
                  onClick={e => { e.stopPropagation(); closeTab(tb.id) }}
                  title={t('common.close')}
                  style={styles.browserTabClose}
                >×</span>
              </div>
            )
          })}
          <button style={styles.browserTabAdd} onClick={addTab} title={t('canvas.browser.newTab')}>+</button>
        </div>
      )}

      <div style={styles.browserBar} onPointerDown={e => e.stopPropagation()}>
        <button style={styles.browserBtn} title={t('preview.back')} onClick={() => withActive(wv => wv.goBack())}><ChevronLeft size={13} /></button>
        <button style={styles.browserBtn} title={t('preview.forward')} onClick={() => withActive(wv => wv.goForward())}><ChevronRight size={13} /></button>
        <button style={styles.browserBtn} title={t('preview.reload')} onClick={() => withActive(wv => wv.reload())}>⟳</button>
        <input
          style={styles.browserInput}
          value={input}
          spellCheck={false}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); go(input) } }}
          placeholder="localhost:3000"
        />
        {loading && <span style={{ fontSize: 10, color: 'var(--accent)' }}>●</span>}
        <button style={styles.browserBtn} title={t('canvas.capture')} onClick={capture}><IconCapture /></button>
        {tabs.length === 1 && (
          <button style={styles.browserBtn} onClick={addTab} title={t('canvas.browser.newTab')}>+</button>
        )}
      </div>

      {/* All tabs stay mounted; inactive ones are hidden rather than unmounted
          so their pages keep running and keep their scroll position. */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {tabs.map(tb => (
          <div
            key={tb.id}
            style={{
              position: 'absolute', inset: 0,
              visibility: tb.id === active.id ? 'visible' : 'hidden',
              zIndex: tb.id === active.id ? 1 : 0,
            }}
          >
            {/* @ts-ignore webview is an Electron custom element */}
            <webview
              ref={(el: any) => { if (el) viewRefs.current[tb.id] = el; else delete viewRefs.current[tb.id] }}
              src={tb.url || 'about:blank'}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// Device mockup — an embedded webview sized to a device's *logical* viewport
// inside a cosmetic bezel, for responsive testing (Chrome/Firefox device-bar
// style). The guest renders at true device px; the frame is scaled to fit.
function CanvasDevice({ item, onUpdate, onCapture, t }: { item: CanvasItem; onUpdate: (id: string, patch: Partial<CanvasItem>) => void; onCapture?: (dataUrl: string | null) => void; t: (k: any, p?: any) => string }) {
  const preset = getPreset(item.device)
  const orientation = item.orientation ?? 'portrait'
  const frame = deviceFrame(preset, orientation)
  const ua = DEVICE_UA[preset.os]

  const [input, setInput] = useState(item.url ?? '')
  const [loading, setLoading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [area, setArea] = useState({ w: 0, h: 0 })
  const webviewRef = useRef<any>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const lastUa = useRef(ua)

  useEffect(() => { setInput(item.url ?? '') }, [item.url])

  // Measure the frame area so the fixed device-px frame can be scaled to fit.
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect
      setArea({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Switching device family changes the guest UA (iOS ⇄ Android) → reapply and
  // reload so the page re-negotiates its mobile layout.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || lastUa.current === ua) return
    lastUa.current = ua
    try { wv.setUserAgent?.(ua) } catch { /* method may be unavailable */ }
    try { wv.reload?.() } catch { /* not ready */ }
  }, [ua])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const on = () => setLoading(true)
    const off = () => setLoading(false)
    wv.addEventListener('did-start-loading', on)
    wv.addEventListener('did-stop-loading', off)
    return () => { wv.removeEventListener('did-start-loading', on); wv.removeEventListener('did-stop-loading', off) }
  }, [])

  const go = (raw: string) => {
    const url = normalizeUrl(raw)
    if (!url) return
    setInput(url)
    onUpdate(item.id, { url })
    const wv = webviewRef.current
    try { if (wv?.loadURL) wv.loadURL(url); else if (wv) wv.src = url } catch { /* not ready */ }
  }

  const pad = 14
  const rawScale = Math.min((area.w - pad * 2) / frame.w, (area.h - pad * 2) / frame.h)
  const k = clamp(Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 0.001, 0.05, 2)

  const chooseDevice = (id: string) => {
    const p = getPreset(id)
    const size = deviceCardSize(p, orientation)
    onUpdate(item.id, { device: id, w: size.w, h: size.h })
    setPickerOpen(false)
  }
  const rotate = () => {
    const next = orientation === 'portrait' ? 'landscape' : 'portrait'
    const size = deviceCardSize(preset, next)
    onUpdate(item.id, { orientation: next, w: size.w, h: size.h })
  }

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
      {/* URL row */}
      <div style={styles.browserBar} onPointerDown={e => e.stopPropagation()}>
        <button style={styles.browserBtn} title={t('preview.back')} onClick={() => { try { webviewRef.current?.goBack() } catch { /* */ } }}><ChevronLeft size={13} /></button>
        <button style={styles.browserBtn} title={t('preview.forward')} onClick={() => { try { webviewRef.current?.goForward() } catch { /* */ } }}><ChevronRight size={13} /></button>
        <button style={styles.browserBtn} title={t('preview.reload')} onClick={() => { try { webviewRef.current?.reload() } catch { /* */ } }}>⟳</button>
        <input
          style={styles.browserInput}
          value={input}
          spellCheck={false}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); go(input) } }}
          placeholder="localhost:3000"
        />
        {loading && <span style={{ fontSize: 10, color: 'var(--accent)' }}>●</span>}
        <button
          style={styles.browserBtn}
          title={t('canvas.capture')}
          onClick={async () => {
            const wv = webviewRef.current
            try {
              const img = wv?.capturePage ? await wv.capturePage() : null
              const url = img?.toDataURL?.()
              onCapture?.(url && url.length > 200 ? url : null)
            } catch { onCapture?.(null) }
          }}
        ><IconCapture /></button>
      </div>
      {/* Device row */}
      <div style={styles.deviceBar} onPointerDown={e => e.stopPropagation()}>
        <div style={{ position: 'relative', minWidth: 0 }}>
          <button style={styles.deviceSelect} onClick={() => setPickerOpen(o => !o)} title={t('canvas.device.choose')}>
            <IconDevice />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preset.label}</span>
            <ChevronDisclosure open={pickerOpen} size={10} style={{ opacity: 0.55 }} />
          </button>
          {pickerOpen && <DevicePicker current={preset.id} onPick={chooseDevice} onClose={() => setPickerOpen(false)} t={t} />}
        </div>
        <button style={styles.deviceIconBtn} onClick={rotate} title={t('canvas.device.rotate')}><IconRotate /></button>
        <div style={{ flex: 1 }} />
        <span style={styles.deviceDims}>{frame.vp.w} × {frame.vp.h}</span>
      </div>
      {/* Frame area (scaled to fit) */}
      <div
        ref={areaRef}
        style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: 'var(--bg-elevated)' }}
      >
        <div style={{ width: frame.w * k, height: frame.h * k, flexShrink: 0 }}>
          <div
            style={{
              width: frame.w, height: frame.h, boxSizing: 'border-box', position: 'relative',
              transform: `scale(${k})`, transformOrigin: 'top left',
              background: '#0a0a0c', borderRadius: frame.radius,
              padding: `${frame.topB}px ${frame.side}px ${frame.botB}px`,
              boxShadow: '0 12px 44px rgba(0,0,0,0.55), inset 0 0 0 2px #26262b',
            }}
          >
            {/* notch (phone) / front camera (tablet) */}
            {preset.type === 'phone' ? (
              <div style={{ position: 'absolute', top: Math.max(3, frame.topB - 11), left: '50%', transform: 'translateX(-50%)', width: Math.min(130, frame.vp.w * 0.34), height: 22, background: '#0a0a0c', borderRadius: 13, zIndex: 2 }} />
            ) : (
              <div style={{ position: 'absolute', top: frame.topB / 2 - 2.5, left: '50%', transform: 'translateX(-50%)', width: 5, height: 5, background: '#2c2c32', borderRadius: '50%', zIndex: 2 }} />
            )}
            {/* screen */}
            <div style={{ width: frame.vp.w, height: frame.vp.h, borderRadius: preset.type === 'tablet' ? 4 : 8, overflow: 'hidden', background: '#fff' }}>
              {/* @ts-ignore webview is an Electron custom element */}
              <webview ref={webviewRef} src={item.url || 'about:blank'} useragent={ua} style={{ width: frame.vp.w, height: frame.vp.h, border: 'none', display: 'flex' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Device preset picker — grouped phone / tablet list (Chrome device-bar style).
function DevicePicker({ current, onPick, onClose, t }: {
  current: string
  onPick: (id: string) => void
  onClose: () => void
  t: (k: any, p?: any) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const id = setTimeout(() => document.addEventListener('mousedown', h), 0)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', h) }
  }, [onClose])

  const row = (p: DevicePreset) => (
    <button
      key={p.id}
      className="ctx-menu-item"
      onClick={() => onPick(p.id)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, ...(p.id === current ? { color: 'var(--accent)' } : {}) }}
    >
      <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
      <span style={{ fontSize: 10.5, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>{p.w}×{p.h}</span>
    </button>
  )

  return (
    <div ref={ref} style={styles.devicePicker} onPointerDown={e => e.stopPropagation()}>
      <div style={styles.ctxLabel}>{t('canvas.device.phones')}</div>
      {DEVICE_PRESETS.filter(p => p.type === 'phone').map(row)}
      <div style={styles.ctxDivider} />
      <div style={styles.ctxLabel}>{t('canvas.device.tablets')}</div>
      {DEVICE_PRESETS.filter(p => p.type === 'tablet').map(row)}
    </div>
  )
}

// Sticky note.
function CanvasNote({ item, onUpdate, noteColors }: { item: CanvasItem; onUpdate: (id: string, patch: Partial<CanvasItem>) => void; noteColors: string[] }) {
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: item.color ?? noteColors[0], borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
      <textarea
        value={item.text ?? ''}
        onChange={e => onUpdate(item.id, { text: e.target.value })}
        onPointerDown={e => e.stopPropagation()}
        placeholder="…"
        style={{
          flex: 1, resize: 'none', border: 'none', outline: 'none',
          background: 'transparent', color: '#1a1512', padding: 12,
          fontSize: 14, lineHeight: 1.4, fontFamily: 'inherit', fontWeight: 500,
        }}
      />
      <div style={{ display: 'flex', gap: 5, padding: '4px 8px' }} onPointerDown={e => e.stopPropagation()}>
        {noteColors.map(c => (
          <button key={c} onClick={() => onUpdate(item.id, { color: c })}
            style={{ width: 14, height: 14, borderRadius: '50%', background: c, border: item.color === c ? '2px solid #1a1512' : '1px solid rgba(0,0,0,0.2)', cursor: 'pointer', padding: 0 }} />
        ))}
      </div>
    </div>
  )
}

// Free text label.
function CanvasText({ item, onUpdate, onDragStart }: { item: CanvasItem; onUpdate: (id: string, patch: Partial<CanvasItem>) => void; onDragStart?: (e: React.PointerEvent, id: string) => void }) {
  return (
    <textarea
      value={item.text ?? ''}
      onChange={e => onUpdate(item.id, { text: e.target.value })}
      onPointerDown={e => { e.stopPropagation() }}
      placeholder="Text…"
      style={{
        flex: 1, resize: 'none', border: 'none', outline: 'none',
        background: 'transparent', color: 'var(--text-primary)',
        fontSize: 22, fontWeight: 700, lineHeight: 1.25, fontFamily: 'inherit',
        textShadow: '0 1px 4px rgba(0,0,0,0.4)',
      }}
    />
  )
}

// Shape (rect / ellipse / triangle) as an SVG fill.
function CanvasShape({ item, onUpdate }: { item: CanvasItem; onUpdate: (id: string, patch: Partial<CanvasItem>) => void }) {
  const color = item.color ?? 'var(--accent)'
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
        {item.shape === 'ellipse' && <ellipse cx="50" cy="50" rx="49" ry="49" fill={color} opacity={0.9} />}
        {item.shape === 'triangle' && <polygon points="50,2 98,98 2,98" fill={color} opacity={0.9} />}
        {(!item.shape || item.shape === 'rect') && <rect x="1" y="1" width="98" height="98" rx="6" fill={color} opacity={0.9} />}
      </svg>
    </div>
  )
}

// Freehand pen stroke — an SVG polyline. Only the drawn line is interactive
// (pointerEvents on the stroke), so the stroke's bounding box doesn't block
// clicks/pans over the transparent area around it.
function CanvasDrawing({ item, selected, onDragStart, onContextMenu }: {
  item: CanvasItem
  selected: boolean
  onDragStart: (e: React.PointerEvent, id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
}) {
  const pts = item.points ?? []
  const vbW = Math.max(1, item.w), vbH = Math.max(1, item.h)
  return (
    <svg
      data-canvas-draw
      style={{ position: 'absolute', left: item.x, top: item.y, overflow: 'visible', zIndex: item.z, pointerEvents: 'none' }}
      width={vbW} height={vbH} viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="none"
    >
      {selected && (
        <rect x={0} y={0} width={vbW} height={vbH} fill="none" stroke="var(--accent)" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      )}
      <polyline
        points={pts.map(p => `${p.x},${p.y}`).join(' ')}
        fill="none" stroke={item.color ?? '#e8956b'} strokeWidth={item.strokeWidth ?? 3}
        strokeLinecap="round" strokeLinejoin="round"
        style={{ pointerEvents: 'stroke', cursor: 'grab' }}
        onPointerDown={(e) => onDragStart(e, item.id)}
        onContextMenu={(e) => onContextMenu(e, item.id)}
      />
    </svg>
  )
}

// ── Background picker ───────────────────────────────────────────────────────

function BackgroundPicker({ background, onChange, onClose, t }: {
  background: Background
  onChange: (bg: Background) => void
  onClose: () => void
  t: (k: any, p?: any) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    // Defer so the opening click doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener('mousedown', h), 0)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', h) }
  }, [onClose])

  const swatches = ['#161412', '#0f1419', '#141821', '#1a1420', '#101a14', '#1e1a16', '#242028']
  const types: { id: BgType; label: string }[] = [
    { id: 'dots', label: t('canvas.bg.dots') },
    { id: 'grid', label: t('canvas.bg.grid') },
    { id: 'solid', label: t('canvas.bg.solid') },
    { id: 'image', label: t('canvas.bg.image') },
  ]

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => onChange({ ...background, type: 'image', image: String(reader.result) })
    reader.readAsDataURL(f)
  }

  return (
    <div ref={ref} style={styles.bgPicker}>
      <div style={styles.bgSectionLabel}>{t('canvas.bg.pattern')}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {types.map(ty => (
          <button key={ty.id} onClick={() => onChange({ ...background, type: ty.id })}
            style={{ ...styles.bgTypeBtn, ...(background.type === ty.id ? styles.bgTypeBtnActive : {}) }}>
            {ty.label}
          </button>
        ))}
      </div>

      <div style={styles.bgSectionLabel}>{t('canvas.bg.color')}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {swatches.map(c => (
          <button key={c} onClick={() => onChange({ ...background, color: c })}
            style={{ width: 22, height: 22, borderRadius: 6, background: c, cursor: 'pointer', border: background.color === c ? '2px solid var(--accent)' : '1px solid var(--border)' }} />
        ))}
        <label style={{ ...styles.bgTypeBtn, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(background.color) ? background.color : '#161412'}
            onChange={e => onChange({ ...background, color: e.target.value })}
            style={{ width: 20, height: 20, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }} />
        </label>
      </div>

      <div style={styles.bgSectionLabel}>{t('canvas.bg.image')}</div>
      <label style={{ ...styles.bgTypeBtn, cursor: 'pointer', textAlign: 'center' }}>
        {t('canvas.bg.chooseImage')}
        <input type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
      </label>
      {background.image && (
        <button onClick={() => onChange({ ...background, image: null, type: 'dots' })} style={{ ...styles.bgTypeBtn, marginTop: 4 }}>
          {t('canvas.bg.clearImage')}
        </button>
      )}
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  for (const c of node.children) { const f = findLeaf(c, id); if (f) return f }
  return null
}

function cardLabel(item: CanvasItem, t: (k: any, p?: any) => string): string {
  if (item.kind === 'terminal') return t('canvas.label.terminal')
  if (item.kind === 'browser') {
    const tabs = browserTabs(item)
    const head = tabTitle(activeBrowserTab(item).url) || t('canvas.label.browser')
    return tabs.length > 1 ? `${head}  (${tabs.length})` : head
  }
  if (item.kind === 'device') return getPreset(item.device).label
  if (item.kind === 'note') return t('canvas.label.note')
  if (item.kind === 'image') return t('canvas.label.image')
  if (item.kind === 'task') return t('canvas.label.task')
  if (isFrameKind(item.kind)) return item.text?.trim() || t('canvas.frame.defaultName')
  return ''
}

// What to call a pane in prose: its custom title, else its agent, else a short
// id — the same fallback chain the pane header and RacePanel use, so the "needs
// you" chip never names a pane differently from the card it points at.
function paneLabel(root: PaneNode, paneId: string | undefined, t: (k: any, p?: any) => string): string {
  if (!paneId) return t('pane.noAgent')
  const leaf = findLeaf(root, paneId)
  return leaf?.title?.trim() || leaf?.agentId || paneId.slice(0, 6)
}

// Point on `item`'s border along the direction toward (tx,ty) — used to clip
// connector endpoints to card edges instead of centres.
function rectBorderPoint(item: CanvasItem, tx: number, ty: number): { x: number; y: number } {
  const cx = item.x + item.w / 2, cy = item.y + item.h / 2
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = item.w / 2, hh = item.h / 2
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

function backgroundLayerStyle(bg: Background, cam: Camera): React.CSSProperties {
  const base: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none' }
  if (bg.type === 'image' && bg.image) {
    return { ...base, backgroundImage: `url(${bg.image})`, backgroundSize: 'cover', backgroundPosition: 'center', opacity: 0.9 }
  }
  if (bg.type === 'solid') return { ...base, background: bg.color }
  // dots / grid — tiled pattern that scrolls & scales with the camera so it
  // reads as an infinite plane. Tiling at GRID (not a separate literal) is what
  // makes the drawn cells land on exactly the world coordinates snap produces:
  // the pattern is offset by cam.x % size, so lines fall on world multiples of
  // size/zoom === GRID.
  // Tile edges land on world multiples of GRID — exactly the coordinates
  // snapToGrid() produces — so a snapped card corner sits on a drawn feature.
  // gridBackgroundOffset applies the half-cell shift the dot pattern needs.
  const size = GRID * cam.zoom
  const kind = bg.type === 'grid' ? 'grid' : 'dots'
  const ox = gridBackgroundOffset(cam.x, cam.zoom, kind)
  const oy = gridBackgroundOffset(cam.y, cam.zoom, kind)
  const dot = 'rgba(255,255,255,0.10)'
  if (kind === 'grid') {
    return {
      ...base, background: bg.color,
      backgroundImage: `linear-gradient(${dot} 1px, transparent 1px), linear-gradient(90deg, ${dot} 1px, transparent 1px)`,
      backgroundSize: `${size}px ${size}px`,
      backgroundPosition: `${ox}px ${oy}px`,
    }
  }
  const r = Math.max(1, 1.4 * cam.zoom)
  return {
    ...base, background: bg.color,
    backgroundImage: `radial-gradient(${dot} ${r}px, transparent ${r}px)`,
    backgroundSize: `${size}px ${size}px`,
    backgroundPosition: `${ox}px ${oy}px`,
  }
}

// ── Tool button ─────────────────────────────────────────────────────────────

function ToolButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      style={{
        width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 9, border: 'none', cursor: 'pointer',
        color: active ? 'var(--accent-fg)' : 'var(--text-secondary)',
        background: active ? 'var(--accent)' : 'transparent',
        transition: 'background 120ms, color 120ms',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget.style.background = 'var(--overlay-hover)') }}
      onMouseLeave={e => { if (!active) (e.currentTarget.style.background = 'transparent') }}
    >
      {children}
    </button>
  )
}

// ── Shortcut sheet ──────────────────────────────────────────────────────────
// The board is driven by bare single keys, which is fast once you know them and
// undiscoverable until you do. `?` (or the ? button) lists them.
const SHORTCUT_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'canvas.shortcuts.tools',
    items: [
      ['V', 'canvas.tool.select'], ['H', 'canvas.tool.hand'], ['P', 'canvas.tool.pen'],
      ['E', 'canvas.tool.erase'], ['C', 'canvas.tool.connect'], ['T', 'canvas.tool.terminal'],
      ['B', 'canvas.tool.browser'], ['M', 'canvas.tool.device'], ['N', 'canvas.tool.note'],
      ['K', 'canvas.tool.task'], ['A', 'canvas.tool.frame'], ['I', 'canvas.tool.image'],
      ['R', 'canvas.tool.rect'], ['O', 'canvas.tool.ellipse'],
    ],
  },
  {
    title: 'canvas.shortcuts.layout',
    items: [
      ['F', 'canvas.focus.enter'], ['U', 'canvas.arrange.tidy'], ['Shift+G', 'canvas.arrange.align'],
      ['G', 'canvas.shortcuts.snapToggle'], ['L', 'canvas.ctx.lock'],
    ],
  },
  {
    title: 'canvas.shortcuts.selection',
    items: [
      ['Drag', 'canvas.shortcuts.marquee'], ['Shift+drag', 'canvas.shortcuts.marqueeAdd'],
      ['Shift+click', 'canvas.shortcuts.toggleOne'], ['Ctrl+A', 'canvas.shortcuts.selectAll'],
    ],
  },
  {
    title: 'canvas.shortcuts.editing',
    items: [
      ['Ctrl+D', 'canvas.ctx.duplicate'], ['Ctrl+Z', 'canvas.shortcuts.undoErase'],
      ['Del', 'canvas.ctx.delete'], ['↑↓←→', 'canvas.shortcuts.nudge'], ['Esc', 'canvas.shortcuts.escape'],
    ],
  },
  {
    title: 'canvas.shortcuts.view',
    items: [
      ['Space', 'canvas.shortcuts.pan'], ['Ctrl+wheel', 'canvas.shortcuts.zoom'],
      ['Double-click', 'canvas.shortcuts.dblclick'], ['J', 'canvas.shortcuts.jump'],
    ],
  },
]

function ShortcutSheet({ t, onClose }: { t: (k: any, p?: any) => string; onClose: () => void }) {
  return (
    <div style={styles.sendOverlay} onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={styles.shortcutCard} onPointerDown={e => e.stopPropagation()}>
        <div style={styles.sendTitle}>{t('canvas.shortcuts.title')}</div>
        <div style={styles.shortcutGrid}>
          {SHORTCUT_GROUPS.map(g => (
            <div key={g.title}>
              <div style={styles.ctxLabel}>{t(g.title as any)}</div>
              {g.items.map(([key, label]) => (
                <div key={key + label} style={styles.shortcutRow}>
                  <kbd style={styles.kbd}>{key}</kbd>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t(label as any)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button style={styles.focusExitBtn} onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}

// ── Send-to-agent composer ──────────────────────────────────────────────────
// A small modal for handing a captured (and possibly annotated) screenshot to a
// running agent: the note becomes the prompt, and the image is saved and
// referenced by path. Enter (without Shift) sends; Escape cancels.
function SendToAgentPanel({ agent, t, onCancel, onSend }: {
  agent: string
  t: (k: any, p?: any) => string
  onCancel: () => void
  onSend: (note: string) => void
}) {
  const [note, setNote] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return (
    <div style={styles.sendOverlay} onPointerDown={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={styles.sendDialog} onPointerDown={e => e.stopPropagation()}>
        <div style={styles.sendTitle}>{t('canvas.send.title', { agent })}</div>
        <textarea
          ref={ref}
          value={note}
          onChange={e => setNote(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(note) }
          }}
          placeholder={t('canvas.send.placeholder')}
          rows={3}
          style={styles.sendTextarea}
        />
        <div style={styles.sendHint}>{t('canvas.send.attach')}</div>
        <div style={styles.sendActions}>
          <button style={styles.sendCancel} onClick={onCancel}>{t('canvas.send.cancel')}</button>
          <button style={styles.sendSubmit} onClick={() => onSend(note)}>{t('canvas.send.send')}</button>
        </div>
      </div>
    </div>
  )
}

// A one-field composer for the board's "type something and send it" moments —
// a frame broadcast, a race goal. Deliberately the same shell as
// SendToAgentPanel (which stays as-is because it also explains the attachment):
// three prompts that each invented their own dialog would drift apart, and the
// Escape/Enter handling below is the part that has to be identical everywhere.
function PromptPanel({ title, placeholder, hint, confirmLabel, initial = '', t, onCancel, onSubmit }: {
  title: string
  placeholder: string
  hint?: string
  confirmLabel: string
  initial?: string
  t: (k: any, p?: any) => string
  onCancel: () => void
  onSubmit: (text: string) => void
}) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  // Captured on the window so the board's own bare-key tool shortcuts can't see
  // the Escape first and take the user out to the select tool instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const submit = () => { if (text.trim()) onSubmit(text) }

  return (
    <div style={styles.sendOverlay} onPointerDown={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={styles.sendDialog} onPointerDown={e => e.stopPropagation()}>
        <div style={styles.sendTitle}>{title}</div>
        <textarea
          ref={ref}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
          }}
          placeholder={placeholder}
          rows={3}
          style={styles.sendTextarea}
        />
        {hint && <div style={styles.sendHint}>{hint}</div>}
        <div style={styles.sendActions}>
          <button style={styles.sendCancel} onClick={onCancel}>{t('canvas.send.cancel')}</button>
          <button style={{ ...styles.sendSubmit, ...(text.trim() ? null : { opacity: 0.5, cursor: 'default' }) }} onClick={submit}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

// ── Icons ───────────────────────────────────────────────────────────────────

const svg = (children: React.ReactNode, fill = false) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IconCursor = () => svg(<><path d="m4 3 7 17 2.5-7L20 10 4 3z" /></>)
const IconHand = () => svg(<><path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></>)
const IconTerminal = () => svg(<><rect x="2.5" y="4" width="19" height="16" rx="2" /><path d="m6 9 3 3-3 3M12.5 15h4" /></>)
const IconGlobe = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 4 9 15 15 0 0 1-4 9 15 15 0 0 1-4-9 15 15 0 0 1 4-9z" /></>)
const IconDevice = () => svg(<><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M10.5 5.5h3" /></>)
const IconRotate = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" />
  </svg>
)
const IconNote = () => svg(<><path d="M4 4h16v11l-5 5H4z" /><path d="M15 20v-5h5" /></>)
const IconTask = () => svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="m8 11 2.5 2.5L16 8" /></>)
const IconText = () => svg(<><path d="M4 6V5h16v1M12 5v14M9 19h6" /></>)
const IconRect = () => svg(<><rect x="3" y="5" width="18" height="14" rx="2" /></>)
const IconEllipse = () => svg(<><ellipse cx="12" cy="12" rx="9" ry="7" /></>)
const IconTriangle = () => svg(<><path d="M12 4 21 20H3z" /></>)
const IconPen = () => svg(<><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="m2 2 7.586 7.586" /><circle cx="11" cy="11" r="2" /></>)
const IconConnect = () => svg(<><circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M7.2 7.4 16.8 16.6" /><path d="m13.5 16.8 3.3.2-.2-3.3" /></>)
const IconImage = () => svg(<><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="8.5" cy="8.5" r="1.8" /><path d="m21 15-4.5-4.5L5 21" /></>)
// Small camera glyph sized to sit in a browser/device toolbar button.
const IconCapture = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13" r="3.2" />
  </svg>
)
const IconSnap = () => svg(<><path d="M3 3h4v4H3zM10 3h4v4h-4zM17 3h4v4h-4zM3 10h4v4H3zM17 10h4v4h-4zM3 17h4v4H3zM10 17h4v4h-4zM17 17h4v4h-4z" /></>)
// A tilted eraser block with the swept surface it rides on — reads at 16px,
// where the usual "rubber with a shaded half" does not.
const IconEraser = () => svg(<><path d="M8.5 20.5H20" /><path d="m14.6 3.9 5.5 5.5a1.5 1.5 0 0 1 0 2.1l-7.2 7.2a1.5 1.5 0 0 1-2.1 0l-5.5-5.5a1.5 1.5 0 0 1 0-2.1l7.2-7.2a1.5 1.5 0 0 1 2.1 0z" /><path d="m9 8.5 6.5 6.5" /></>)
// Focus: one full frame with the queue of smaller ones beside it — the layout
// the button produces, which is more legible than a target/eye glyph.
// Two dock boxes, not three: at the 13-14px this renders at, three of them and
// their gaps antialias into a single grey bar.
const IconFocus = () => svg(<><rect x="2.5" y="5" width="11" height="14" rx="1.6" /><rect x="16.5" y="5" width="5" height="6" rx="1.2" /><rect x="16.5" y="13" width="5" height="6" rx="1.2" /></>)
const IconLock = () => svg(<><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></>)
// A frame: the artboard cross — two rules through a rectangle, which is what
// distinguishes it from the plain "rectangle" shape tool sitting three buttons
// away. Same 24-box, same stroke weight, so it reads as one family with them.
const IconFrame = () => svg(<><path d="M7 2v20M17 2v20M2 7h20M2 17h20" /></>)
// Semantic zoom: a big pane and two condensed rows — "the same thing, less of
// it". Not a magnifier, which would read as the zoom control it sits beside.
const IconLod = () => svg(<><rect x="3" y="3.5" width="8" height="17" rx="1.5" /><rect x="14" y="3.5" width="7" height="7" rx="1.5" /><path d="M14 14.5h7M14 18h4.5" /></>)
// Follow camera: a viewfinder locked onto a point.
const IconFollow = () => svg(<><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3.4M12 18.6V22M2 12h3.4M18.6 12H22" /><circle cx="12" cy="12" r="8" /></>)
const IconSend = () => svg(<><path d="M21.5 2.5 11 13" /><path d="M21.5 2.5 15 21.5l-4-8.5-8.5-4z" /></>)
// Tidy: scattered boxes resolving into aligned ones.
const IconTidy = () => svg(<><rect x="3" y="3" width="7" height="7" rx="1.4" /><rect x="14" y="3" width="7" height="7" rx="1.4" /><rect x="3" y="14" width="7" height="7" rx="1.4" /><rect x="14" y="14" width="7" height="7" rx="1.4" /></>)
const IconBackground = () => svg(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>)
const IconExit = () => svg(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>)
const IconFit = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
  </svg>
)
const GripDots = () => (
  <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
    <circle cx="2.5" cy="3" r="1.2" /><circle cx="7.5" cy="3" r="1.2" />
    <circle cx="2.5" cy="7" r="1.2" /><circle cx="7.5" cy="7" r="1.2" />
    <circle cx="2.5" cy="11" r="1.2" /><circle cx="7.5" cy="11" r="1.2" />
  </svg>
)

// ── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden', background: 'var(--bg-base)' },
  board: { position: 'absolute', inset: 0, overflow: 'hidden', touchAction: 'none' },
  // Rubber-band box. Above the cards (their transformed layer stacks at 0) but
  // below the tool rail and minimap at 20, and never a pointer target itself.
  marquee: {
    position: 'absolute', zIndex: 14, pointerEvents: 'none', borderRadius: 3,
    border: '1px solid var(--accent)',
    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
  },
  groupCount: {
    position: 'absolute', left: 0, bottom: '100%', transformOrigin: 'left bottom',
    marginBottom: 4, padding: '2px 7px', borderRadius: 6, whiteSpace: 'nowrap',
    background: 'var(--accent)', color: 'var(--accent-fg)',
    fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3,
  },
  emptyHint: {
    position: 'absolute', top: '42%', left: '50%', transform: 'translate(-50%,-50%)',
    textAlign: 'center', pointerEvents: 'none', maxWidth: 360,
  },
  rail: {
    position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
    display: 'flex', flexDirection: 'column', gap: 4, padding: 6,
    background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 14,
    boxShadow: '0 10px 34px rgba(0,0,0,0.55)', zIndex: 20,
  },
  railDivider: { height: 1, background: 'var(--border)', margin: '3px 6px' },
  railGrip: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', height: 18,
    color: 'var(--text-dim)', borderRadius: 6, touchAction: 'none',
  },
  railCollapseBtn: {
    width: 20, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', color: 'var(--text-dim)',
    cursor: 'pointer', borderRadius: 5, padding: 0,
  },
  penBar: {
    position: 'absolute', left: 66, top: '50%', transform: 'translateY(-50%)',
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
    background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 12,
    boxShadow: '0 10px 34px rgba(0,0,0,0.55)', zIndex: 21,
  },
  penBarLabel: { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)' },
  penBarDivider: { width: 1, height: 22, background: 'var(--border)', margin: '0 2px' },
  topControls: {
    position: 'absolute', top: 12, right: 14, display: 'flex', alignItems: 'center', gap: 6, zIndex: 20,
  },
  ctrlBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px',
    background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 9,
    color: 'var(--text-secondary)', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
  },
  iconCtrl: {
    width: 32, height: 32, background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 9,
    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, lineHeight: 1, boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
  },
  zoomLabel: {
    minWidth: 52, height: 32, background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 9,
    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
    boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
  },
  exitBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', marginLeft: 4,
    background: 'var(--accent)', border: 'none', borderRadius: 9, color: 'var(--accent-fg)',
    cursor: 'pointer', fontWeight: 600, boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
  },
  cardHeader: {
    height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
    background: 'var(--bg-elevated)', borderRadius: '12px 12px 0 0', cursor: 'grab',
    borderBottom: '1px solid var(--border-subtle)', userSelect: 'none',
  },
  grip: { color: 'var(--text-dim)', display: 'flex', flexShrink: 0 },
  cardLabel: { fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 },
  cardHdrBtn: {
    width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
    borderRadius: 5, fontSize: 12,
  },
  // ── Frames ──
  frameHeader: {
    flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.5em', padding: '0 0.5em 0 0.8em',
    cursor: 'grab', userSelect: 'none', background: 'var(--bg-panel)',
    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
  },
  frameName: {
    flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
    fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', padding: 0, letterSpacing: 0.2,
  },
  frameCount: {
    fontSize: 10.5, fontWeight: 600, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums',
    padding: '1px 6px', borderRadius: 999, background: 'var(--bg-base)', whiteSpace: 'nowrap',
  },
  // ── Race ──
  // Counter-scaled by the caller so the chip keeps a constant on-screen size at
  // the zoomed-out altitude where attempts are actually compared.
  raceChip: {
    position: 'absolute', top: -30, left: 0, zIndex: 8,
    display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px 2px 8px',
    borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
    boxShadow: '0 4px 14px rgba(0,0,0,0.45)', whiteSpace: 'nowrap',
    transformOrigin: '0 100%',
  },
  raceChipDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  raceChipIdx: { fontSize: 10.5, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' },
  raceChipStat: { fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)' },
  raceChipBtn: {
    border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)',
    borderRadius: 6, fontSize: 10, padding: '1px 7px', cursor: 'pointer', fontFamily: 'inherit',
  },
  raceBar: {
    position: 'absolute', left: '50%', bottom: 54, transform: 'translateX(-50%)', zIndex: 30,
    display: 'flex', alignItems: 'center', gap: 8, maxWidth: 'min(880px, 90%)',
    padding: '6px 8px 6px 12px', borderRadius: 10,
    background: 'var(--bg-panel)', border: '1px solid var(--border-strong)',
    boxShadow: '0 8px 26px rgba(0,0,0,0.5)', overflow: 'hidden',
  },
  raceBarLabel: { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' },
  raceBarGoal: { fontSize: 11.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 },
  raceBarSep: { width: 1, height: 16, background: 'var(--border)', flexShrink: 0 },
  raceBarFile: {
    fontSize: 10, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-secondary)',
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6,
    padding: '1px 6px', whiteSpace: 'nowrap',
  },
  raceBarBtn: {
    border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
    borderRadius: 6, fontSize: 10.5, padding: '2px 9px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
  },
  // ── Attention ──
  attentionChip: {
    position: 'absolute', left: '50%', bottom: 96, transform: 'translateX(-50%)', zIndex: 40,
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
    borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
    background: 'var(--bg-panel)', color: 'var(--text-primary)',
    border: '1px solid #f4c95d', boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
  },
  attentionDot: { width: 8, height: 8, borderRadius: '50%', background: '#f4c95d', flexShrink: 0 },
  tabStrip: {
    height: 26, flexShrink: 0, display: 'flex', alignItems: 'stretch', gap: 2, padding: '0 4px',
    background: 'var(--bg-panel)', borderBottom: '1px solid var(--border-subtle)',
    overflowX: 'auto', overflowY: 'hidden',
  },
  browserTab: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px 0 8px', marginTop: 3,
    maxWidth: 150, minWidth: 60, flexShrink: 0, cursor: 'pointer',
    borderRadius: '6px 6px 0 0', background: 'transparent',
    color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap',
  },
  browserTabActive: { background: 'var(--bg-base)', color: 'var(--text-primary)' },
  browserTabClose: {
    width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 3, flexShrink: 0, fontSize: 12, lineHeight: 1, color: 'var(--text-dim)',
  },
  browserTabAdd: {
    width: 22, flexShrink: 0, marginTop: 3, border: 'none', background: 'transparent',
    color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, borderRadius: 5,
  },
  browserBar: {
    height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 3, padding: '0 6px',
    background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)',
  },
  browserBtn: {
    width: 22, height: 22, border: 'none', background: 'transparent', color: 'var(--text-muted)',
    cursor: 'pointer', fontSize: 15, lineHeight: 1, borderRadius: 5, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  browserInput: {
    flex: 1, minWidth: 0, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text-primary)', fontSize: 11.5, padding: '3px 8px', outline: 'none', margin: '0 4px',
  },
  deviceBar: {
    height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
    background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)',
  },
  deviceSelect: {
    display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 200, height: 22, padding: '0 8px',
    background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11.5, fontWeight: 500,
  },
  deviceIconBtn: {
    width: 24, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text-secondary)', cursor: 'pointer',
  },
  deviceDims: {
    fontSize: 10.5, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0,
  },
  devicePicker: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, width: 210, maxHeight: 320, overflowY: 'auto', padding: 4,
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10,
    boxShadow: '0 12px 40px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', gap: 1, zIndex: 50,
  },
  bgPicker: {
    position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 250, padding: 12,
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12,
    boxShadow: '0 12px 40px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 30,
  },
  bgSectionLabel: { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', marginTop: 2 },
  bgTypeBtn: {
    padding: '5px 10px', background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 7,
    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11.5, flex: '1 1 auto',
  },
  bgTypeBtnActive: { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--accent)' },
  // Escape hatch for a maximized card. It floats above the card (which itself
  // sits at a very high z within the world layer) so there's always a visible
  // way back, whatever the card is rendering.
  // Focus mode chrome. Sits above the board (which is raised while a card is
  // placed in screen space) so the way out is always reachable.
  focusBar: {
    position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 60,
    display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 8px 0 12px',
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 999,
    boxShadow: '0 8px 26px rgba(0,0,0,0.5)', color: 'var(--text-secondary)', fontSize: 11.5, fontWeight: 600,
  },
  focusMore: {
    padding: '1px 7px', borderRadius: 999, background: 'var(--bg-panel)',
    border: '1px solid var(--border-strong)', color: 'var(--text-dim)', fontSize: 10.5,
  },
  focusExitBtn: {
    height: 22, padding: '0 10px', background: 'var(--accent)', border: 'none', borderRadius: 999,
    color: 'var(--accent-fg)', cursor: 'pointer', fontSize: 11, fontWeight: 600,
  },
  lockMark: { display: 'flex', flex: '0 0 auto', color: 'var(--text-dim)', width: 12, height: 12 },
  shortcutCard: {
    width: 'min(760px, 92vw)', maxHeight: '84vh', overflowY: 'auto', padding: 18,
    display: 'flex', flexDirection: 'column', gap: 12,
    background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 14,
    boxShadow: '0 24px 70px rgba(0,0,0,0.6)',
  },
  shortcutGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '4px 22px',
  },
  shortcutRow: { display: 'flex', alignItems: 'center', gap: 9, padding: '2px 10px' },
  kbd: {
    flex: '0 0 auto', minWidth: 26, textAlign: 'center', padding: '2px 6px', borderRadius: 5,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
    color: 'var(--text-primary)', fontSize: 10.5, fontFamily: 'var(--font-mono, monospace)',
  },
  maxRestoreFloating: {
    position: 'absolute', top: 10, right: 12, zIndex: 60,
    height: 26, padding: '0 12px', background: 'var(--accent)', border: 'none', borderRadius: 7,
    color: 'var(--accent-fg)', cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
    boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
  },
  ctxMenu: {
    position: 'fixed', minWidth: 190, padding: 4, zIndex: 99999,
    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10,
    boxShadow: '0 12px 40px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', gap: 1,
  },
  ctxKey: { marginLeft: 8, color: 'var(--text-dim)', fontSize: 10.5 },
  ctxLabel: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', padding: '6px 10px 3px' },
  ctxDivider: { height: 1, background: 'var(--border)', margin: '3px 4px' },
  connectHint: {
    position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 22,
    padding: '6px 14px', background: 'var(--bg-panel)', border: '1px solid var(--accent)', borderRadius: 999,
    color: 'var(--text-secondary)', fontSize: 12, fontWeight: 500, boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
    pointerEvents: 'none', whiteSpace: 'nowrap',
  },
  minimap: {
    position: 'absolute', right: 14, bottom: 14, zIndex: 20,
    background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 10,
    boxShadow: '0 8px 26px rgba(0,0,0,0.5)', overflow: 'hidden', padding: 2,
  },
  minimapGrip: {
    height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'grab', color: 'var(--text-dim)', touchAction: 'none',
    borderBottom: '1px solid var(--border)', marginBottom: 2,
  },
  minimapGripDots: { fontSize: 11, lineHeight: 1, letterSpacing: 2, userSelect: 'none' },
  toast: {
    position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 40,
    padding: '8px 16px', background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
    borderRadius: 999, color: 'var(--text-primary)', fontSize: 12.5, fontWeight: 500,
    boxShadow: '0 8px 26px rgba(0,0,0,0.55)', cursor: 'pointer', maxWidth: '70%',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  sendOverlay: {
    position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  sendDialog: {
    width: 420, maxWidth: 'calc(100vw - 48px)', background: 'var(--bg-elevated)',
    border: '1px solid var(--border)', borderRadius: 12, padding: 18,
    display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
  },
  sendTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  sendTextarea: {
    fontSize: 13, padding: '9px 11px', borderRadius: 8, resize: 'vertical', minHeight: 60,
    background: 'var(--bg-base)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)',
    fontFamily: 'inherit', lineHeight: 1.5, outline: 'none',
  },
  sendHint: { fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 },
  sendActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
  sendCancel: {
    fontSize: 12.5, fontWeight: 600, padding: '6px 14px', borderRadius: 7, cursor: 'pointer',
    background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-strong)',
  },
  sendSubmit: {
    fontSize: 12.5, fontWeight: 600, padding: '6px 16px', borderRadius: 7, cursor: 'pointer',
    background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
  },
}
