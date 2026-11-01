/**
 * MapView derives bins and paints them; these hooks own viewport and input state.
 * Data flows from viewport to bins, while canvas input updates the viewport or
 * sends selected ZIP codes back to the owning screen.
 */
import {
  useCallback,
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

const INITIAL_VIEWPORT: Viewport = { width: 900, height: 560, scale: 1, offsetX: 0, offsetY: 0 }

type ViewportSetter = Dispatch<SetStateAction<Viewport>>

export function useMapViewport() {
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT)

  const setWidth = useCallback((width: number) => {
    if (width < 1) return
    setViewport((current) => (current.width === width ? current : { ...current, width }))
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

  return { viewport, setViewport, setWidth, zoomAtData, reset }
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
  // Ref state keeps pointer movement from rendering until the viewport changes.
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

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLCanvasElement>) => {
      const step = 40
      switch (event.key) {
        case 'ArrowLeft':
          setViewport((current) => ({ ...current, offsetX: current.offsetX + step }))
          break
        case 'ArrowRight':
          setViewport((current) => ({ ...current, offsetX: current.offsetX - step }))
          break
        case 'ArrowUp':
          setViewport((current) => ({ ...current, offsetY: current.offsetY + step }))
          break
        case 'ArrowDown':
          setViewport((current) => ({ ...current, offsetY: current.offsetY - step }))
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
    [setViewport],
  )

  return { hover, onMouseMove, onMouseLeave, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick, onKeyDown }
}
