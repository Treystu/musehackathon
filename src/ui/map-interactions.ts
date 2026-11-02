/**
 * MapView derives bins and paints them; these hooks own viewport and input state.
 * Data flows from viewport to bins, while canvas input updates the viewport or
 * sends selected ZIP codes back to the owning screen.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react'

import { hexRadius, type HexBin } from '../core/map/binning'
import { zoomAround, type Viewport } from '../core/map/projection'

const INITIAL_VIEWPORT: Viewport = { width: 900, height: 504, scale: 1, offsetX: 0, offsetY: 0 }

type ViewportSetter = Dispatch<SetStateAction<Viewport>>

/**
 * The canvas height for a given width: the internal map box's aspect
 * (960x500), floored so a phone still gets a usable map and capped at the
 * 560 the desktop layout was designed around.
 *
 * Height used to be a fixed 560 at every width. The fit is width-bound on a
 * phone (screenTransform takes min(width/960, height/500)), so at 380px
 * wide the country drew about 200px tall, centred in 560px of canvas, and
 * most of the panel was blank above and below it — measured in a fresh
 * session at 412px on 2026-11-02 against the owner's phone screenshots
 * showing the same dead space. Deriving height from width keeps the map
 * filling its box at every size.
 */
export function heightForWidth(width: number): number {
  return Math.min(560, Math.max(240, Math.round(width * 0.56)))
}

export function useMapViewport() {
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT)

  const setSize = useCallback((width: number) => {
    if (width < 1) return
    const height = heightForWidth(width)
    setViewport((current) =>
      current.width === width && current.height === height ? current : { ...current, width, height },
    )
  }, [])

  const zoomAtData = useCallback((geoms: readonly HexBin[], factor: number) => {
    setViewport((current) => {
      const drawn = geoms.filter(
        (bin) => bin.cx >= 0 && bin.cx <= current.width && bin.cy >= 0 && bin.cy <= current.height,
      )
      if (drawn.length === 0) {
        return zoomAround(current, factor, current.width / 2, current.height / 2)
      }

      let x = 0
      let y = 0
      for (const bin of drawn) {
        x += bin.cx
        y += bin.cy
      }
      return zoomAround(
        current,
        factor,
        x / drawn.length - current.width / 2,
        y / drawn.length - current.height / 2,
      )
    })
  }, [])

  const reset = useCallback(() => {
    setViewport((current) => ({ ...INITIAL_VIEWPORT, width: current.width, height: current.height }))
  }, [])

  return { viewport, setViewport, setSize, zoomAtData, reset }
}

/**
 * The zoom factor for one wheel event.
 *
 * Wheel deltas arrive in three units (pixels, lines, pages) depending on the
 * device and browser, so the delta is normalised to pixels first. The factor
 * is exponential in the delta — a trackpad's stream of small events and a
 * mouse wheel's coarse notches then both land at a usable speed — and clamped
 * per event, so one flick cannot jump the whole zoom range in a single frame.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  if (!Number.isFinite(pixels) || pixels === 0) return 1
  return Math.max(0.5, Math.min(2, Math.exp(-pixels * 0.002)))
}

/** The identity of a bin across repaints: the ZIP codes it covers. */
export function binKey(bin: HexBin): string {
  return bin.zctas.join(',')
}

/**
 * The bin a keyboard reader lands on when focus first enters the map: the one
 * nearest the given canvas point (the centre, in practice).
 */
export function binNearestToPoint(bins: readonly HexBin[], x: number, y: number): HexBin | null {
  let best: HexBin | null = null
  let bestDistance = Infinity
  for (const bin of bins) {
    const d = (bin.cx - x) ** 2 + (bin.cy - y) ** 2
    if (d < bestDistance) {
      bestDistance = d
      best = bin
    }
  }
  return best
}

/**
 * The next bin in a compass direction, for arrow-key movement.
 *
 * Candidates must lie inside a 45-degree cone around the direction and at
 * least a few pixels along it; among those, the score rewards travelling
 * mostly along the direction, so focus steps to the visual neighbour rather
 * than to a bin that is merely closest in Euclidean distance but sits
 * diagonally off-axis. Returns null when nothing lies that way, so the caller
 * can leave focus where it is instead of wrapping somewhere surprising.
 */
export function nearestBinInDirection(
  bins: readonly HexBin[],
  from: HexBin,
  dx: number,
  dy: number,
): HexBin | null {
  let best: HexBin | null = null
  let bestScore = Infinity
  for (const bin of bins) {
    if (bin === from) continue
    const vx = bin.cx - from.cx
    const vy = bin.cy - from.cy
    const primary = vx * dx + vy * dy
    if (primary <= 2) continue
    const cross = Math.abs(vx * dy - vy * dx)
    if (cross > primary) continue
    const score = primary + cross * 1.5
    if (score < bestScore) {
      bestScore = score
      best = bin
    }
  }
  return best
}

interface CanvasInteractionOptions {
  canvasRef: { current: HTMLCanvasElement | null }
  geoms: readonly HexBin[]
  viewport: Viewport
  setViewport: ViewportSetter
  onSelect: (zctas: string[]) => void
}

export function useMapCanvasInteractions({
  canvasRef,
  geoms,
  viewport,
  setViewport,
  onSelect,
}: CanvasInteractionOptions) {
  const [hover, setHover] = useState<HexBin | null>(null)
  /*
   * The keyboard-focused bin, held by key rather than by object: panning,
   * zooming and changing the metric all rebuild the bin list, and a stored
   * object would point at a bin that no longer exists, while the key finds
   * the same area again in the new list.
   */
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const focused = useMemo(
    () => (focusedKey === null ? null : (geoms.find((g) => binKey(g) === focusedKey) ?? null)),
    [geoms, focusedKey],
  )
  // Ref state keeps pointer movement from rendering until the viewport changes.
  // Pointer handling is deliberately single-pointer: drag pans, and a second
  // pointer is ignored rather than half-tracked. Pinch zoom would need a
  // two-pointer state machine plus touch-action: none, which would also trap
  // page scrolling over the map on a phone — so pinch is not offered, and the
  // on-canvas copy says exactly that (wheel, buttons and keys only).
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null)
  const dragged = useRef(false)

  const hit = useCallback(
    (clientX: number, clientY: number): HexBin | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      const radius = hexRadius(viewport.scale)

      for (const bin of geoms) {
        const dx = x - bin.cx
        const dy = y - bin.cy
        if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue
        // Exact containment for a regular hexagon, using its apothem.
        if (Math.abs(dx) * 0.866 + Math.abs(dy) * 0.5 <= radius) return bin
      }
      return null
    },
    [canvasRef, geoms, viewport.scale],
  )

  /*
   * Wheel zoom, attached natively rather than through React's onWheel:
   * React attaches wheel listeners as passive at the root, so a
   * preventDefault there is ignored and the page would scroll while the map
   * zoomed. A non-passive listener on the canvas itself is the documented
   * way to claim the gesture. The zoom centres on the pointer, using the
   * same zoomAround arithmetic as the buttons (which pass a point relative
   * to the canvas centre).
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode)
      if (factor === 1) return
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      setViewport((current) =>
        zoomAround(current, factor, x - current.width / 2, y - current.height / 2),
      )
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [canvasRef, setViewport])

  const onMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => setHover(hit(event.clientX, event.clientY)),
    [hit],
  )
  const onMouseLeave = useCallback(() => setHover(null), [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    // Primary button only; a click remains a click until the pointer moves.
    if (event.button !== 0) return
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const currentDrag = drag.current
      if (!currentDrag || currentDrag.pointerId !== event.pointerId) return
      const dx = event.clientX - currentDrag.x
      const dy = event.clientY - currentDrag.y
      if (Math.abs(event.clientX - currentDrag.startX) + Math.abs(event.clientY - currentDrag.startY) < 4) return
      currentDrag.x = event.clientX
      currentDrag.y = event.clientY
      dragged.current = true
      setViewport((current) => ({ ...current, offsetX: current.offsetX + dx, offsetY: current.offsetY + dy }))
    },
    [setViewport],
  )

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null
  }, [])
  const onPointerCancel = useCallback(() => {
    drag.current = null
    dragged.current = false
  }, [])

  const onClick = useCallback(() => {
    // Browsers emit click after a drag too; do not select an area the user panned past.
    if (dragged.current) {
      dragged.current = false
      return
    }
    if (hover && hover.zctas.length > 0) onSelect(hover.zctas)
  }, [hover, onSelect])

  /*
   * Keyboard control. Selection used to be pointer-only: the arrows panned,
   * + and - zoomed, and no key could choose an area, so a keyboard reader
   * could look at the map but never act on it. The arrows now move a focused
   * bin instead (the view layer draws its outline and announces it): the
   * first arrow press focuses the bin nearest the centre, later presses step
   * to the neighbouring bin in that direction, Enter or Space selects the
   * focused bin, and Escape clears the focus. Panning stays available by
   * drag, and zoom by + and -, so no shipped capability is lost — the arrows
   * are the one reassignment, and they are what the on-canvas copy states.
   */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLCanvasElement>) => {
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }
      const arrow = arrows[event.key]
      if (arrow) {
        if (geoms.length === 0) return
        if (!focused) {
          const centre = binNearestToPoint(geoms, viewport.width / 2, viewport.height / 2)
          if (centre) setFocusedKey(binKey(centre))
        } else {
          const next = nearestBinInDirection(geoms, focused, arrow[0], arrow[1])
          if (next) setFocusedKey(binKey(next))
        }
        event.preventDefault()
        return
      }
      switch (event.key) {
        case 'Enter':
        case ' ':
          if (!focused) return
          onSelect(focused.zctas)
          break
        case 'Escape':
          if (!focused) return
          setFocusedKey(null)
          break
        case '+':
        case '=':
          setViewport((current) => ({ ...current, scale: current.scale * 1.4 }))
          break
        case '-':
        case '_':
          setViewport((current) => ({ ...current, scale: current.scale / 1.4 }))
          break
        case '0':
          setViewport((current) => ({ ...current, scale: 1, offsetX: 0, offsetY: 0 }))
          break
        default:
          return
      }
      event.preventDefault()
    },
    [focused, geoms, viewport.width, viewport.height, setViewport, onSelect],
  )

  return {
    hover,
    focused,
    onMouseMove,
    onMouseLeave,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClick,
    onKeyDown,
  }
}
