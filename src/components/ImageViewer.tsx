import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'

export interface ImageViewerProps {
  filePath: string
  fileName: string
  /** Path relative to the workspace root, for the status-bar breadcrumb. */
  relPath: string | null
  dataUrl: string
  mime: string
  /** File size in bytes. */
  size: number
  /** Last-modified time (epoch ms). */
  mtimeMs: number
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 32

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ''
  }
}

export function ImageViewer({
  filePath,
  fileName,
  relPath,
  dataUrl,
  mime,
  size,
  mtimeMs,
}: ImageViewerProps) {
  const t = useT()
  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  // Content-box size of the scroll area, tracked so we can compute the fit scale.
  const [viewport, setViewport] = useState<{ w: number; h: number } | null>(null)
  // null zoom = "fit to view"; a number = explicit scale factor.
  const [zoom, setZoom] = useState<number | null>(null)

  const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

  // The scale that "fit" actually renders at: shrink large images to fit the
  // viewport, never upscale small ones (matches max-width/height: 100%).
  const fitScale = useMemo(() => {
    if (!dims || !viewport || viewport.w <= 0 || viewport.h <= 0) return null
    return Math.min(1, viewport.w / dims.w, viewport.h / dims.h)
  }, [dims, viewport])

  // Effective scale currently on screen, whether in fit or explicit mode.
  const effectiveZoom = zoom ?? fitScale

  // Keep the latest fit scale reachable from the (one-shot) wheel listener so
  // the first zoom step continues smoothly from the visible fit view.
  const fitScaleRef = useRef<number | null>(null)
  fitScaleRef.current = fitScale

  // Track the viewport size so the fit scale stays accurate on resize.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setViewport({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // After a cursor-anchored zoom, remember the image point that was under the
  // cursor so the layout effect below can keep it pinned there.
  const zoomAnchor = useRef<{ fx: number; fy: number; clientX: number; clientY: number } | null>(
    null
  )

  // Mouse wheel zooms (no modifier needed), keeping the point under the cursor
  // fixed. Native non-passive listener so preventDefault stops page scroll.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const img = imgRef.current
      if (img) {
        const r = img.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          zoomAnchor.current = {
            fx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
            fy: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
            clientX: e.clientX,
            clientY: e.clientY,
          }
        }
      }
      setZoom((prev) => {
        const base = prev ?? fitScaleRef.current ?? 1
        return clamp(base * (e.deltaY < 0 ? 1.1 : 1 / 1.1))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Once the new zoom has been laid out, scroll so the anchored image point
  // lands back under the cursor (zoom-to-cursor). Only has an effect when the
  // image overflows the viewport; otherwise it stays centred.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    const el = wrapRef.current
    const img = imgRef.current
    if (!anchor || !el || !img) return
    zoomAnchor.current = null
    const r = img.getBoundingClientRect()
    el.scrollLeft += r.left + anchor.fx * r.width - anchor.clientX
    el.scrollTop += r.top + anchor.fy * r.height - anchor.clientY
  }, [effectiveZoom])

  // Drag to pan when the image overflows the viewport.
  const [dragging, setDragging] = useState(false)
  const panStart = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)

  const overflowing =
    !!dims &&
    effectiveZoom !== null &&
    !!viewport &&
    (dims.w * effectiveZoom > viewport.w + 0.5 || dims.h * effectiveZoom > viewport.h + 0.5)

  const onPointerDown = (e: React.PointerEvent) => {
    const el = wrapRef.current
    if (e.button !== 0 || !el || !overflowing) return
    panStart.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
    setDragging(true)
    el.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const s = panStart.current
    const el = wrapRef.current
    if (!s || !el) return
    el.scrollLeft = s.sl - (e.clientX - s.x)
    el.scrollTop = s.st - (e.clientY - s.y)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!panStart.current) return
    panStart.current = null
    setDragging(false)
    wrapRef.current?.releasePointerCapture?.(e.pointerId)
  }

  // Reset zoom when switching images.
  useEffect(() => {
    setZoom(null)
    setDims(null)
  }, [filePath])

  const zoomPct = effectiveZoom === null ? null : Math.round(effectiveZoom * 100)

  // Always render at an explicit pixel size once we know the dimensions and the
  // effective scale. `margin: auto` centres the image while still letting the
  // scroll container reach every edge when it overflows (unlike flex centering,
  // which clips the top/left). `flexShrink: 0` stops flex from shrinking it.
  const imgStyle: React.CSSProperties =
    dims && effectiveZoom !== null
      ? {
          width: dims.w * effectiveZoom,
          height: dims.h * effectiveZoom,
          maxWidth: 'none',
          maxHeight: 'none',
          margin: 'auto',
          flexShrink: 0,
        }
      : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', margin: 'auto' }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--bg-base)',
        overflow: 'hidden',
      }}
    >
      {/* Image canvas (checkerboard reveals transparency) */}
      <div
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          padding: 16,
          cursor: dragging ? 'grabbing' : overflowing ? 'grab' : 'default',
          userSelect: 'none',
          backgroundColor: '#15130f',
          backgroundImage:
            'linear-gradient(45deg, #211e1a 25%, transparent 25%), linear-gradient(-45deg, #211e1a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #211e1a 75%), linear-gradient(-45deg, transparent 75%, #211e1a 75%)',
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
        }}
      >
        <img
          ref={imgRef}
          src={dataUrl}
          alt={fileName}
          draggable={false}
          onLoad={(e) =>
            setDims({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          style={{ display: 'block', ...imgStyle }}
        />
      </div>

      {/* Status bar */}
      <div
        style={{
          height: 24,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px',
          gap: 14,
          background: 'var(--bg-panel)',
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 11,
          color: 'var(--text-muted)',
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {/* Breadcrumb */}
        <span
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={filePath}
        >
          {(relPath ?? fileName).split(/[\\/]/).join('  ›  ')}
        </span>

        {dims && (
          <span title={t('image.dimensions')}>
            {dims.w} × {dims.h}
          </span>
        )}
        <span title={t('image.fileSize')}>{formatSize(size)}</span>
        <span title={t('image.modified')}>{formatDate(mtimeMs)}</span>
        <span style={{ textTransform: 'uppercase' }}>{mime.replace('image/', '')}</span>

        {/* Zoom controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <ZoomButton
            label="−"
            title={t('image.zoomOut')}
            onClick={() => setZoom((z) => clamp((z ?? fitScale ?? 1) / 1.25))}
          />
          <button
            onClick={() => setZoom((z) => (z === null ? 1 : null))}
            title={zoom === null ? t('image.actualSize') : t('image.fit')}
            style={{
              minWidth: 46,
              height: 18,
              padding: '0 6px',
              fontSize: 10.5,
              fontWeight: 600,
              border: 'none',
              borderRadius: 3,
              cursor: 'pointer',
              background: 'transparent',
              color: 'var(--text-secondary)',
            }}
          >
            {zoom === null ? t('image.fit') : `${zoomPct ?? ''}%`}
          </button>
          <ZoomButton
            label="+"
            title={t('image.zoomIn')}
            onClick={() => setZoom((z) => clamp((z ?? fitScale ?? 1) * 1.25))}
          />
        </div>
      </div>
    </div>
  )
}

function ZoomButton({
  label,
  title,
  onClick,
}: {
  label: string
  title: string
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 18,
        height: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        lineHeight: 1,
        border: 'none',
        borderRadius: 3,
        cursor: 'pointer',
        background: hovered ? 'var(--overlay-hover)' : 'transparent',
        color: 'var(--text-secondary)',
      }}
    >
      {label}
    </button>
  )
}
