import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { AgentPane } from './AgentPane'
import { useWorkspaceStore, type PaneNode, type PaneLeaf, type AgentId, type PtyStatus } from '../store/workspace'
import { useT } from '../i18n'

// ── Canvas model ────────────────────────────────────────────────────────────
// A "canvas" is a free-form, pannable/zoomable board (cnvs.dev / Miro style).
// Terminal cards map 1:1 onto real rootPane leaves, so they're fully live agent
// panes — the canvas is just an alternate spatial view of the same terminals,
// plus canvas-only browsers, sticky notes, text and shapes. Everything but the
// terminal↔pane link is persisted per-workspace under the `canvas:<id>` setting.

type CanvasTool =
  | 'select' | 'hand' | 'draw' | 'connect'
  | 'terminal' | 'browser' | 'note' | 'text' | 'image'
  | 'rect' | 'ellipse' | 'triangle'

type BgType = 'dots' | 'grid' | 'solid' | 'image'

interface CanvasItem {
  id: string
  kind: 'terminal' | 'browser' | 'note' | 'text' | 'shape' | 'draw' | 'image'
  x: number
  y: number
  w: number
  h: number
  z: number
  paneId?: string          // terminal
  url?: string             // browser
  text?: string            // note / text
  color?: string           // note / text / shape fill / stroke colour
  shape?: 'rect' | 'ellipse' | 'triangle'
  points?: { x: number; y: number }[]  // draw — polyline relative to {x,y}
  strokeWidth?: number     // draw
  src?: string             // image — data URL
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
}

const GRID = 20
const snapVal = (v: number, on: boolean) => on ? Math.round(v / GRID) * GRID : Math.round(v)

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const NOTE_COLORS = ['#f4c95d', '#e8956b', '#7fc8a0', '#7fb0e8', '#c89be0', '#e88ba5']
const PEN_COLORS = ['#e8956b', '#f4c95d', '#7fc8a0', '#7fb0e8', '#c89be0', '#e88ba5', '#ece7e0', '#1a1512']
const PEN_WIDTHS = [2, 4, 8]
const DEFAULT_BG: Background = { type: 'dots', color: '#161412', image: null }
const DEFAULT_CAMERA: Camera = { x: 120, y: 100, zoom: 1 }

function getLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return node.children.flatMap(getLeaves)
}

// ── CanvasMode ──────────────────────────────────────────────────────────────

export function CanvasMode() {
  const t = useT()
  const workspace = useWorkspaceStore(s => s.workspace)
  const rootPane = useWorkspaceStore(s => s.rootPane)
  const addPane = useWorkspaceStore(s => s.addPane)
  const closePane = useWorkspaceStore(s => s.closePane)
  const getLeafIds = useWorkspaceStore(s => s.getLeafIds)
  const showTerminals = useWorkspaceStore(s => s.showTerminals)

  const rootRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<CanvasTool>('select')
  const [items, setItems] = useState<CanvasItem[]>([])
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA)
  const [background, setBackground] = useState<Background>(DEFAULT_BG)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [maximizedId, setMaximizedId] = useState<string | null>(null)
  const [bgPickerOpen, setBgPickerOpen] = useState(false)
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
  const [penColor, setPenColor] = useState(PEN_COLORS[0])
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1])
  const [draft, setDraft] = useState<{ x: number; y: number }[] | null>(null)
  const penRef = useRef({ color: penColor, width: penWidth })
  penRef.current = { color: penColor, width: penWidth }

  const [loaded, setLoaded] = useState(false)
  // Mid-interaction pointer shield: covers the viewport during a drag/resize/pan
  // so embedded <webview>s (browser cards) can't swallow the pointermove stream
  // and stall the gesture. Value doubles as the cursor to show while active.
  const [interacting, setInteracting] = useState<false | 'grabbing' | 'nwse-resize'>(false)
  const [menu, setMenu] = useState<{ x: number; y: number; wx: number; wy: number; itemId: string | null } | null>(null)
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  // A live mirror of items — drag/resize read the starting geometry from here
  // because React state updater callbacks don't run synchronously.
  const itemsRef = useRef(items)
  itemsRef.current = items
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
    setSelectedId(null)
    setSelectedConnectorId(null)
    setMaximizedId(null)
    setConnectFrom(null)
    setDraft(null)
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
      const payload: PersistShape = { items, connectors, camera, background }
      window.swarmmind.setAppSetting(`canvas:${workspace.id}`, JSON.stringify(payload)).catch(() => {})
    }, 600)
    return () => clearTimeout(id)
  }, [items, connectors, camera, background, workspace?.id, loaded])

  // Prune connectors whose endpoints no longer exist.
  useEffect(() => {
    if (!loaded) return
    setConnectors(prev => {
      const ids = new Set(items.map(i => i.id))
      const next = prev.filter(c => ids.has(c.from) && ids.has(c.to))
      return next.length === prev.length ? prev : next
    })
  }, [items, loaded])

  // ── Coordinate helpers ──
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const cam = cameraRef.current
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    return { x: (sx - left - cam.x) / cam.zoom, y: (sy - top - cam.y) / cam.zoom }
  }, [])

  const bringToFront = useCallback((id: string) => {
    zTopRef.current += 1
    const z = zTopRef.current
    setItems(prev => prev.map(it => it.id === id ? { ...it, z } : it))
  }, [])

  // ── Create an item ──
  const addItem = useCallback((partial: Omit<CanvasItem, 'id' | 'z' | 'x' | 'y'>, wx: number, wy: number) => {
    zTopRef.current += 1
    const item: CanvasItem = {
      id: uuidv4(), z: zTopRef.current,
      x: Math.round(wx - partial.w / 2), y: Math.round(wy - partial.h / 2),
      ...partial,
    }
    setItems(prev => [...prev, item])
    setSelectedId(item.id)
  }, [])

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

  // ── Canvas background pointer: pan or place ──
  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return  // only when hitting empty canvas
    if (e.button !== 0 && e.button !== 1) return  // right-click → context menu
    setBgPickerOpen(false)
    setMenu(null)
    const panning = tool === 'hand' || spaceDown || e.button === 1
    if (panning || tool === 'select') {
      setSelectedId(null)
      setSelectedConnectorId(null)
      // Pan the camera.
      const startX = e.clientX, startY = e.clientY
      const orig = { ...cameraRef.current }
      setInteracting('grabbing')
      const move = (ev: PointerEvent) => {
        setCamera({ ...orig, x: orig.x + (ev.clientX - startX), y: orig.y + (ev.clientY - startY) })
      }
      const up = () => {
        setInteracting(false)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      return
    }
    // A creation tool is active → place at the click position, then revert.
    const { x, y } = screenToWorld(e.clientX, e.clientY)
    if (tool === 'terminal') addTerminal(x, y)
    else if (tool === 'browser') addItem({ kind: 'browser', w: 640, h: 460, url: 'http://localhost:3000' }, x, y)
    else if (tool === 'note') addItem({ kind: 'note', w: 220, h: 200, text: '', color: NOTE_COLORS[0] }, x, y)
    else if (tool === 'text') addItem({ kind: 'text', w: 260, h: 60, text: '', color: 'var(--text-primary)' }, x, y)
    else if (tool === 'rect') addItem({ kind: 'shape', shape: 'rect', w: 220, h: 150, color: 'var(--accent)' }, x, y)
    else if (tool === 'ellipse') addItem({ kind: 'shape', shape: 'ellipse', w: 200, h: 200, color: '#7fb0e8' }, x, y)
    else if (tool === 'triangle') addItem({ kind: 'shape', shape: 'triangle', w: 220, h: 190, color: '#7fc8a0' }, x, y)
    else if (tool === 'image') { pendingImgPos.current = { x, y }; fileInputRef.current?.click() }
    setTool('select')
  }, [tool, spaceDown, screenToWorld, addItem, addTerminal])

  // ── Drag / resize an item ──
  const startDrag = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.button !== 0) return
    bringToFront(id)
    setSelectedId(id)
    setSelectedConnectorId(null)
    setMenu(null)
    const zoom = cameraRef.current.zoom
    const it = itemsRef.current.find(i => i.id === id)
    if (!it) return
    const startX = e.clientX, startY = e.clientY
    const ox = it.x, oy = it.y
    setInteracting('grabbing')
    const move = (ev: PointerEvent) => {
      const sn = snapRef.current
      setItems(prev => prev.map(i => i.id === id
        ? { ...i, x: snapVal(ox + (ev.clientX - startX) / zoom, sn), y: snapVal(oy + (ev.clientY - startY) / zoom, sn) }
        : i))
    }
    const up = () => {
      setInteracting(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [bringToFront])

  const startResize = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.button !== 0) return
    bringToFront(id)
    setSelectedId(id)
    setMenu(null)
    const zoom = cameraRef.current.zoom
    const it = itemsRef.current.find(i => i.id === id)
    if (!it) return
    const startX = e.clientX, startY = e.clientY
    const ow = it.w, oh = it.h
    setInteracting('nwse-resize')
    const move = (ev: PointerEvent) => {
      const sn = snapRef.current
      setItems(prev => prev.map(i => i.id === id
        ? { ...i, w: Math.max(140, snapVal(ow + (ev.clientX - startX) / zoom, sn)), h: Math.max(80, snapVal(oh + (ev.clientY - startY) / zoom, sn)) }
        : i))
    }
    const up = () => {
      setInteracting(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [bringToFront])

  // ── Remove an item (closing the pane too, for terminals) ──
  const removeItem = useCallback((id: string) => {
    setItems(prev => {
      const it = prev.find(i => i.id === id)
      if (it?.kind === 'terminal' && it.paneId) closePane(it.paneId)
      return prev.filter(i => i.id !== id)
    })
    setSelectedId(sel => sel === id ? null : sel)
    setMaximizedId(m => m === id ? null : m)
  }, [closePane])

  const updateItem = useCallback((id: string, patch: Partial<CanvasItem>) => {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it))
  }, [])

  // Duplicate an item, offset a little. Terminals spawn a fresh pane (you can't
  // clone a live PTY), everything else is a straight copy.
  const duplicateItem = useCallback((id: string) => {
    const it = itemsRef.current.find(i => i.id === id)
    if (!it) return
    if (it.kind === 'terminal') { addTerminal(it.x + 260, it.y + 200); return }
    zTopRef.current += 1
    const copy: CanvasItem = { ...it, id: uuidv4(), x: it.x + 24, y: it.y + 24, z: zTopRef.current }
    setItems(prev => [...prev, copy])
    setSelectedId(copy.id)
  }, [addTerminal])

  const sendToBack = useCallback((id: string) => {
    setItems(prev => {
      const minZ = Math.min(...prev.map(i => i.z))
      return prev.map(i => i.id === id ? { ...i, z: minZ - 1 } : i)
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
    else if (kind === 'note') addItem({ kind: 'note', w: 220, h: 200, text: '', color: NOTE_COLORS[0] }, wx, wy)
    else if (kind === 'text') addItem({ kind: 'text', w: 260, h: 60, text: '', color: 'var(--text-primary)' }, wx, wy)
    else if (kind === 'rect') addItem({ kind: 'shape', shape: 'rect', w: 220, h: 150, color: 'var(--accent)' }, wx, wy)
    else if (kind === 'ellipse') addItem({ kind: 'shape', shape: 'ellipse', w: 200, h: 200, color: '#7fb0e8' }, wx, wy)
    else if (kind === 'triangle') addItem({ kind: 'shape', shape: 'triangle', w: 220, h: 190, color: '#7fc8a0' }, wx, wy)
    setMenu(null)
  }, [addTerminal, addItem])

  // ── Images (paste / drop / file picker) ──
  const addImageFromFile = useCallback((file: File, wx: number, wy: number) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const src = String(reader.result)
      const img = new Image()
      img.onload = () => {
        // Fit within a sensible box, preserving aspect ratio.
        const maxW = 420, maxH = 360
        const scale = Math.min(1, maxW / img.width, maxH / img.height)
        const w = Math.max(80, Math.round(img.width * scale))
        const h = Math.max(60, Math.round(img.height * scale))
        zTopRef.current += 1
        setItems(prev => [...prev, {
          id: uuidv4(), kind: 'image', src,
          x: Math.round(wx - w / 2), y: Math.round(wy - h / 2), w, h, z: zTopRef.current,
        }])
      }
      img.src = src
    }
    reader.readAsDataURL(file)
  }, [])

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

  const onConnectPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const wp = screenToWorld(e.clientX, e.clientY)
    const hit = hitTestItem(wp.x, wp.y)
    setConnectFrom(prev => {
      if (!hit) return null
      if (!prev) return hit.id
      if (prev === hit.id) return prev
      setConnectors(cs => [...cs, { id: uuidv4(), from: prev, to: hit.id }])
      return null
    })
    setConnectPointer(null)
  }, [screenToWorld, hitTestItem])

  const removeConnector = useCallback((id: string) => {
    setConnectors(prev => prev.filter(c => c.id !== id))
    setSelectedConnectorId(sel => (sel === id ? null : sel))
  }, [])

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
    const move = (ev: PointerEvent) => {
      pts.push(screenToWorld(ev.clientX, ev.clientY))
      setDraft(pts.slice())
    }
    const up = () => {
      setInteracting(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraft(null)
      if (pts.length < 2) return
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      const minX = Math.min(...xs), minY = Math.min(...ys)
      const maxX = Math.max(...xs), maxY = Math.max(...ys)
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
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [screenToWorld])

  // ── Wheel: ctrl/cmd = zoom to cursor, otherwise pan ──
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
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
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); removeItem(selectedId); return }
      if (e.key === 'Escape') { setMaximizedId(null); setMenu(null); setTool('select'); setSelectedId(null); setSelectedConnectorId(null); setConnectFrom(null); return }
      // Ctrl/⌘+D duplicates the selected item.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && selectedId) { e.preventDefault(); duplicateItem(selectedId); return }
      // Arrow keys nudge the selection (Shift = coarse). No modifier needed.
      if (selectedId && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.startsWith('Arrow')) {
        e.preventDefault()
        const d = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
        const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0
        setItems(prev => prev.map(i => i.id === selectedId ? { ...i, x: i.x + dx, y: i.y + dy } : i))
        return
      }
      // Bare-key tool shortcuts only — never hijack Ctrl/⌘/Alt combos (e.g.
      // Ctrl+B broadcast, ⌘+K palette).
      if (e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break
        case 'h': setTool('hand'); break
        case 'p': setTool('draw'); break
        case 'c': setTool('connect'); break
        case 't': setTool('terminal'); break
        case 'b': setTool('browser'); break
        case 'n': setTool('note'); break
        case 'i': openImagePicker(); break
        case 'r': setTool('rect'); break
        case 'o': setTool('ellipse'); break
        case 'g': setSnap(s => !s); break
      }
    }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [selectedId, selectedConnectorId, removeItem, removeConnector, duplicateItem, openImagePicker])

  // Close the context menu on any outside click.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

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

  const cursor = tool === 'hand' || spaceDown ? 'grab'
    : tool === 'select' ? 'default'
    : 'crosshair'

  const bgStyle = backgroundLayerStyle(background, camera)
  const maximized = maximizedId ? items.find(i => i.id === maximizedId) : null

  return (
    <div style={styles.wrap}>
      {/* ── Board surface ── */}
      <div
        ref={rootRef}
        style={{ ...styles.board, cursor, background: background.type === 'solid' ? background.color : 'var(--bg-base)' }}
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
          <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 0 }} width={1} height={1}>
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
                    onPointerDown={(e) => { e.stopPropagation(); setSelectedConnectorId(c.id); setSelectedId(null) }} />
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

          {/* Skip the maximized item here — it's rendered full-size in the
              overlay below. Mounting it in both places would attach two xterms /
              webviews to one pane and they'd fight over input. */}
          {items.filter(item => item.id !== maximizedId).map(item => (
            item.kind === 'draw' ? (
              <CanvasDrawing
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onDragStart={startDrag}
                onContextMenu={(e, id) => { e.preventDefault(); e.stopPropagation(); setSelectedId(id); setMenu({ x: e.clientX, y: e.clientY, wx: 0, wy: 0, itemId: id }) }}
              />
            ) : (
              <CanvasCard
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                zoom={camera.zoom}
                onDragStart={startDrag}
                onResizeStart={startResize}
                onSelect={(id) => { setSelectedId(id); bringToFront(id) }}
                onRemove={removeItem}
                onMaximize={(id) => setMaximizedId(id)}
                onUpdate={updateItem}
                onContextMenu={(e, id) => { e.preventDefault(); e.stopPropagation(); setSelectedId(id); setMenu({ x: e.clientX, y: e.clientY, wx: 0, wy: 0, itemId: id }) }}
                noteColors={NOTE_COLORS}
                t={t}
              />
            )
          ))}

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

        {/* Pen capture layer — mounted only in draw mode so strokes can start
            anywhere (including over cards). z sits above the world's cards (their
            transformed stacking context is at level 0) but below the tool rail /
            pen bar (z ≥ 20) so those stay clickable while drawing. */}
        {tool === 'draw' && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 15, cursor: 'crosshair' }} onPointerDown={startDraw} />
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

      {/* ── Left tool rail (Miro-style) ── */}
      <div style={styles.rail}>
        <ToolButton active={tool === 'select'} label={t('canvas.tool.select')} onClick={() => setTool('select')}><IconCursor /></ToolButton>
        <ToolButton active={tool === 'hand'} label={t('canvas.tool.hand')} onClick={() => setTool('hand')}><IconHand /></ToolButton>
        <ToolButton active={tool === 'draw'} label={t('canvas.tool.pen')} onClick={() => setTool('draw')}><IconPen /></ToolButton>
        <ToolButton active={tool === 'connect'} label={t('canvas.tool.connect')} onClick={() => setTool('connect')}><IconConnect /></ToolButton>
        <div style={styles.railDivider} />
        <ToolButton active={tool === 'terminal'} label={t('canvas.tool.terminal')} onClick={() => setTool('terminal')}><IconTerminal /></ToolButton>
        <ToolButton active={tool === 'browser'} label={t('canvas.tool.browser')} onClick={() => setTool('browser')}><IconGlobe /></ToolButton>
        <ToolButton active={tool === 'note'} label={t('canvas.tool.note')} onClick={() => setTool('note')}><IconNote /></ToolButton>
        <ToolButton active={tool === 'text'} label={t('canvas.tool.text')} onClick={() => setTool('text')}><IconText /></ToolButton>
        <ToolButton active={tool === 'image'} label={t('canvas.tool.image')} onClick={openImagePicker}><IconImage /></ToolButton>
        <div style={styles.railDivider} />
        <ToolButton active={tool === 'rect'} label={t('canvas.tool.rect')} onClick={() => setTool('rect')}><IconRect /></ToolButton>
        <ToolButton active={tool === 'ellipse'} label={t('canvas.tool.ellipse')} onClick={() => setTool('ellipse')}><IconEllipse /></ToolButton>
        <ToolButton active={tool === 'triangle'} label={t('canvas.tool.triangle')} onClick={() => setTool('triangle')}><IconTriangle /></ToolButton>
      </div>

      {/* ── Pen colour / width picker (draw mode only) ── */}
      {tool === 'draw' && (
        <div style={styles.penBar}>
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
        <button
          style={{ ...styles.iconCtrl, color: snap ? 'var(--accent)' : 'var(--text-secondary)', borderColor: snap ? 'var(--accent)' : 'var(--border)' }}
          onClick={() => setSnap(s => !s)}
          title={snap ? t('canvas.snapOn') : t('canvas.snapOff')}
        ><IconSnap /></button>
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
          {menu.itemId ? (
            <>
              <button className="ctx-menu-item" onClick={() => { duplicateItem(menu.itemId!); setMenu(null) }}><span style={{ flex: 1 }}>{t('canvas.ctx.duplicate')}</span><span style={styles.ctxKey}>Ctrl+D</span></button>
              <button className="ctx-menu-item" onClick={() => { bringToFront(menu.itemId!); setMenu(null) }}>{t('canvas.ctx.front')}</button>
              <button className="ctx-menu-item" onClick={() => { sendToBack(menu.itemId!); setMenu(null) }}>{t('canvas.ctx.back')}</button>
              <div style={styles.ctxDivider} />
              <button className="ctx-menu-item" data-variant="danger" onClick={() => { removeItem(menu.itemId!); setMenu(null) }}><span style={{ flex: 1 }}>{t('canvas.ctx.delete')}</span><span style={styles.ctxKey}>Del</span></button>
            </>
          ) : (
            <>
              <div style={styles.ctxLabel}>{t('canvas.ctx.addHere')}</div>
              <button className="ctx-menu-item" onClick={() => addFromMenu('terminal', menu.wx, menu.wy)}>{t('canvas.tool.terminal')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('browser', menu.wx, menu.wy)}>{t('canvas.tool.browser')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('note', menu.wx, menu.wy)}>{t('canvas.tool.note')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('text', menu.wx, menu.wy)}>{t('canvas.tool.text')}</button>
              <div style={styles.ctxDivider} />
              <button className="ctx-menu-item" onClick={() => addFromMenu('rect', menu.wx, menu.wy)}>{t('canvas.tool.rect')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('ellipse', menu.wx, menu.wy)}>{t('canvas.tool.ellipse')}</button>
              <button className="ctx-menu-item" onClick={() => addFromMenu('triangle', menu.wx, menu.wy)}>{t('canvas.tool.triangle')}</button>
            </>
          )}
        </div>
      )}

      {/* ── Maximized overlay (fills the viewport, still the same live pane) ── */}
      {maximized && (
        <div style={styles.maxOverlay}>
          <div style={styles.maxHeader}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>{t('canvas.maximized')}</span>
            <button style={styles.maxRestore} onClick={() => setMaximizedId(null)}>{t('canvas.restore')}</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
            <CardBody item={maximized} onUpdate={updateItem} noteColors={NOTE_COLORS} t={t} maximized />
          </div>
        </div>
      )}

      {/* ── Minimap navigator (bottom-right) ── */}
      {items.length > 0 && (
        <Minimap items={items} camera={camera} rootRef={rootRef} onJump={(wx, wy) => {
          const rect = rootRef.current?.getBoundingClientRect()
          if (!rect) return
          const z = cameraRef.current.zoom
          setCamera({ zoom: z, x: rect.width / 2 - wx * z, y: rect.height / 2 - wy * z })
        }} />
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

function Minimap({ items, camera, rootRef, onJump }: {
  items: CanvasItem[]
  camera: Camera
  rootRef: React.RefObject<HTMLDivElement>
  onJump: (wx: number, wy: number) => void
}) {
  const MM_W = 190, MM_H = 130, PAD = 10
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
    k === 'terminal' ? '#7fc8a0' : k === 'browser' ? '#7fb0e8' : k === 'note' ? '#f4c95d'
    : k === 'image' ? '#c89be0' : k === 'draw' ? '#e88ba5' : '#e8956b'

  const jump = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    onJump(minX + (mx - offX) / scale, minY + (my - offY) / scale)
  }

  return (
    <div style={styles.minimap}>
      <svg width={MM_W} height={MM_H} style={{ display: 'block', cursor: 'pointer' }} onPointerDown={jump}>
        {items.map(i => {
          const p = toMini(i.x, i.y)
          return <rect key={i.id} x={p.x} y={p.y} width={Math.max(2, i.w * scale)} height={Math.max(2, i.h * scale)} rx={1.5} fill={kindColor(i.kind)} opacity={0.85} />
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
  onResizeStart: (e: React.PointerEvent, id: string) => void
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onMaximize: (id: string) => void
  onUpdate: (id: string, patch: Partial<CanvasItem>) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  noteColors: string[]
  t: (k: any, p?: any) => string
}

function CanvasCard({ item, selected, onDragStart, onResizeStart, onSelect, onRemove, onMaximize, onUpdate, onContextMenu, noteColors, t }: CanvasCardProps) {
  const isShape = item.kind === 'shape'
  const frameless = isShape || item.kind === 'text'

  return (
    <div
      data-canvas-card
      style={{
        position: 'absolute',
        left: item.x, top: item.y, width: item.w, height: item.h,
        zIndex: item.z,
        borderRadius: frameless ? 0 : 12,
        outline: selected ? '2px solid var(--accent)' : 'none',
        outlineOffset: 2,
        display: 'flex', flexDirection: 'column',
        boxShadow: frameless ? 'none' : '0 8px 30px rgba(0,0,0,0.5)',
        background: frameless ? 'transparent' : 'var(--bg-panel)',
        overflow: 'visible',
      }}
      onPointerDown={() => onSelect(item.id)}
      onContextMenu={(e) => onContextMenu(e, item.id)}
    >
      {/* Header / drag handle — shapes & text drag from anywhere */}
      {!frameless && (
        <div
          style={styles.cardHeader}
          onPointerDown={(e) => { if (e.button === 0) onDragStart(e, item.id) }}
          onDoubleClick={() => onMaximize(item.id)}
        >
          <span style={styles.grip}><GripDots /></span>
          <span style={styles.cardLabel}>{cardLabel(item, t)}</span>
          <div style={{ flex: 1 }} />
          {item.kind === 'terminal' && (
            <button style={styles.cardHdrBtn} title={t('canvas.maximize')} onPointerDown={e => e.stopPropagation()} onClick={() => onMaximize(item.id)}>⤢</button>
          )}
          <button style={styles.cardHdrBtn} title={t('canvas.removeCard')} onPointerDown={e => e.stopPropagation()} onClick={() => onRemove(item.id)}>✕</button>
        </div>
      )}

      {/* Body */}
      <div
        style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', overflow: frameless ? 'visible' : 'hidden', position: 'relative' }}
        // Shapes/text are dragged by their body since they have no header.
        onPointerDown={frameless ? (e) => { if (e.button === 0 && item.kind !== 'text') onDragStart(e, item.id) } : undefined}
      >
        <CardBody item={item} onUpdate={onUpdate} onDragStart={onDragStart} noteColors={noteColors} t={t} />
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

      {/* Resize handle */}
      <div style={styles.resizeHandle} onPointerDown={(e) => onResizeStart(e, item.id)} />
    </div>
  )
}

// ── CardBody — the type-specific content ────────────────────────────────────

function CardBody({ item, onUpdate, onDragStart, noteColors, t, maximized }: {
  item: CanvasItem
  onUpdate: (id: string, patch: Partial<CanvasItem>) => void
  onDragStart?: (e: React.PointerEvent, id: string) => void
  noteColors: string[]
  t: (k: any, p?: any) => string
  maximized?: boolean
}) {
  if (item.kind === 'terminal' && item.paneId) return <CanvasTerminal paneId={item.paneId} />
  if (item.kind === 'browser') return <CanvasBrowser item={item} onUpdate={onUpdate} t={t} />
  if (item.kind === 'note') return <CanvasNote item={item} onUpdate={onUpdate} noteColors={noteColors} />
  if (item.kind === 'text') return <CanvasText item={item} onUpdate={onUpdate} onDragStart={onDragStart} />
  if (item.kind === 'shape') return <CanvasShape item={item} onUpdate={onUpdate} />
  if (item.kind === 'image') return <CanvasImage item={item} />
  return null
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
function CanvasTerminal({ paneId }: { paneId: string }) {
  const splitPane = useWorkspaceStore(s => s.splitPane)
  const closePane = useWorkspaceStore(s => s.closePane)
  const agentId = useWorkspaceStore(s => findLeaf(s.rootPane, paneId)?.agentId ?? null) as AgentId | null
  const ptyStatus = useWorkspaceStore(s => findLeaf(s.rootPane, paneId)?.ptyStatus ?? 'idle') as PtyStatus
  const paneCwd = useWorkspaceStore(s => findLeaf(s.rootPane, paneId)?.cwd ?? null)
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', background: 'var(--bg-terminal)', borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
      <AgentPane
        paneId={paneId}
        agentId={agentId}
        ptyStatus={ptyStatus}
        paneCwd={paneCwd}
        onSplitH={() => splitPane(paneId, 'horizontal')}
        onSplitV={() => splitPane(paneId, 'vertical')}
        onClose={() => closePane(paneId)}
      />
    </div>
  )
}

// Browser — an embedded webview with a compact URL bar.
function CanvasBrowser({ item, onUpdate, t }: { item: CanvasItem; onUpdate: (id: string, patch: Partial<CanvasItem>) => void; t: (k: any, p?: any) => string }) {
  const [input, setInput] = useState(item.url ?? '')
  const webviewRef = useRef<any>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => { setInput(item.url ?? '') }, [item.url])

  const normalize = (raw: string): string => {
    const s = raw.trim()
    if (!s) return s
    if (/^https?:\/\//i.test(s)) return s
    if (/^:?\d{2,5}$/.test(s)) return 'http://localhost:' + s.replace(/^:/, '')
    if (/^localhost(:\d+)?/i.test(s) || /^\d+\.\d+\.\d+\.\d+/.test(s)) return 'http://' + s
    return 'http://' + s
  }
  const go = (raw: string) => {
    const url = normalize(raw)
    if (!url) return
    setInput(url)
    onUpdate(item.id, { url })
    const wv = webviewRef.current
    try { if (wv?.loadURL) wv.loadURL(url); else if (wv) wv.src = url } catch { /* not ready */ }
  }
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const on = () => setLoading(true)
    const off = () => setLoading(false)
    wv.addEventListener('did-start-loading', on)
    wv.addEventListener('did-stop-loading', off)
    return () => { wv.removeEventListener('did-start-loading', on); wv.removeEventListener('did-stop-loading', off) }
  }, [])

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
      <div style={styles.browserBar} onPointerDown={e => e.stopPropagation()}>
        <button style={styles.browserBtn} title={t('preview.back')} onClick={() => { try { webviewRef.current?.goBack() } catch { /* */ } }}>‹</button>
        <button style={styles.browserBtn} title={t('preview.forward')} onClick={() => { try { webviewRef.current?.goForward() } catch { /* */ } }}>›</button>
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
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {/* @ts-ignore webview is an Electron custom element */}
        <webview ref={webviewRef} src={item.url || 'about:blank'} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }} />
      </div>
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
  if (item.kind === 'browser') return item.url?.replace(/^https?:\/\//, '') || t('canvas.label.browser')
  if (item.kind === 'note') return t('canvas.label.note')
  if (item.kind === 'image') return t('canvas.label.image')
  return ''
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
  // reads as an infinite plane.
  const size = 28 * cam.zoom
  const ox = cam.x % size
  const oy = cam.y % size
  const dot = 'rgba(255,255,255,0.10)'
  if (bg.type === 'grid') {
    return {
      ...base, background: bg.color,
      backgroundImage: `linear-gradient(${dot} 1px, transparent 1px), linear-gradient(90deg, ${dot} 1px, transparent 1px)`,
      backgroundSize: `${size}px ${size}px`,
      backgroundPosition: `${ox}px ${oy}px`,
    }
  }
  return {
    ...base, background: bg.color,
    backgroundImage: `radial-gradient(${dot} ${Math.max(1, 1.4 * cam.zoom)}px, transparent ${Math.max(1, 1.4 * cam.zoom)}px)`,
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

// ── Icons ───────────────────────────────────────────────────────────────────

const svg = (children: React.ReactNode, fill = false) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IconCursor = () => svg(<><path d="m4 3 7 17 2.5-7L20 10 4 3z" /></>)
const IconHand = () => svg(<><path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></>)
const IconTerminal = () => svg(<><rect x="2.5" y="4" width="19" height="16" rx="2" /><path d="m6 9 3 3-3 3M12.5 15h4" /></>)
const IconGlobe = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 4 9 15 15 0 0 1-4 9 15 15 0 0 1-4-9 15 15 0 0 1 4-9z" /></>)
const IconNote = () => svg(<><path d="M4 4h16v11l-5 5H4z" /><path d="M15 20v-5h5" /></>)
const IconText = () => svg(<><path d="M4 6V5h16v1M12 5v14M9 19h6" /></>)
const IconRect = () => svg(<><rect x="3" y="5" width="18" height="14" rx="2" /></>)
const IconEllipse = () => svg(<><ellipse cx="12" cy="12" rx="9" ry="7" /></>)
const IconTriangle = () => svg(<><path d="M12 4 21 20H3z" /></>)
const IconPen = () => svg(<><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="m2 2 7.586 7.586" /><circle cx="11" cy="11" r="2" /></>)
const IconConnect = () => svg(<><circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M7.2 7.4 16.8 16.6" /><path d="m13.5 16.8 3.3.2-.2-3.3" /></>)
const IconImage = () => svg(<><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="8.5" cy="8.5" r="1.8" /><path d="m21 15-4.5-4.5L5 21" /></>)
const IconSnap = () => svg(<><path d="M3 3h4v4H3zM10 3h4v4h-4zM17 3h4v4h-4zM3 10h4v4H3zM17 10h4v4h-4zM3 17h4v4H3zM10 17h4v4h-4zM17 17h4v4h-4z" /></>)
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
  resizeHandle: {
    position: 'absolute', right: -3, bottom: -3, width: 18, height: 18, cursor: 'nwse-resize',
    background: 'transparent', zIndex: 5,
  },
  browserBar: {
    height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 3, padding: '0 6px',
    background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)',
  },
  browserBtn: {
    width: 22, height: 22, border: 'none', background: 'transparent', color: 'var(--text-muted)',
    cursor: 'pointer', fontSize: 15, lineHeight: 1, borderRadius: 5, flexShrink: 0,
  },
  browserInput: {
    flex: 1, minWidth: 0, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text-primary)', fontSize: 11.5, padding: '3px 8px', outline: 'none', margin: '0 4px',
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
  maxOverlay: {
    position: 'absolute', inset: 12, zIndex: 40, display: 'flex', flexDirection: 'column',
    background: 'var(--bg-panel)', border: '1px solid var(--border-active)', borderRadius: 12,
    boxShadow: '0 20px 60px rgba(0,0,0,0.7)', overflow: 'hidden',
  },
  maxHeader: {
    height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)',
  },
  maxRestore: {
    height: 24, padding: '0 12px', background: 'var(--accent)', border: 'none', borderRadius: 7,
    color: 'var(--accent-fg)', cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
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
}
