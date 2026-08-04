// Draggable panel widths, for both side panels.
//
// The width lives in localStorage rather than the document: it is a property of
// this person at this window size, not of the design, and a `.poly` bundle
// copied to another machine should not carry someone else's panel widths.
//
// The handle is a 5px strip that sits ON the panel's inner edge (half over the
// border, half over the content) so the target is wider than the 1px line it
// appears to be — the same reason a window's resize border is thicker than its
// visible frame.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface PanelWidth {
  width: number
  /** Attach to the drag handle element. */
  onPointerDown: (e: React.PointerEvent) => void
  /** True while dragging, for the handle's active styling. */
  dragging: boolean
}

/**
 * @param key       localStorage key, so each panel remembers its own width
 * @param initial   width before anything is stored
 * @param edge      which edge the handle is on: 'right' for a left-hand panel
 * @param min/max   clamped so a panel can neither vanish nor eat the canvas
 */
export function usePanelWidth(
  key: string,
  initial: number,
  edge: 'left' | 'right',
  min = 180,
  max = 560,
): PanelWidth {
  const clamp = useCallback((w: number) => Math.max(min, Math.min(max, Math.round(w))), [min, max])
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(key))
      return Number.isFinite(stored) && stored > 0 ? clamp(stored) : initial
    } catch {
      return initial
    }
  })
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ x: 0, w: 0 })

  // A window narrow enough to make the stored width unreasonable wins over it.
  useEffect(() => {
    const onResize = () => setWidth((w) => Math.min(w, Math.max(min, window.innerWidth * 0.4)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [min])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      startRef.current = { x: e.clientX, w: width }
      setDragging(true)
      // Pointer capture on the window, not the handle: the pointer leaves a 5px
      // strip immediately, and a capture that fails silently is how the layers
      // drag lost its drops (see LayersPanel).
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startRef.current.x
        setWidth(clamp(startRef.current.w + (edge === 'right' ? dx : -dx)))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setDragging(false)
        setWidth((w) => {
          try {
            localStorage.setItem(key, String(w))
          } catch {
            // Session-only when storage is unavailable; the panel still resizes.
          }
          return w
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [clamp, edge, key, width],
  )

  return { width, onPointerDown, dragging }
}

/** The grab strip itself: invisible until hovered, accent while dragging. */
export function ResizeHandle({
  edge,
  dragging,
  onPointerDown,
  title,
}: {
  edge: 'left' | 'right'
  dragging: boolean
  onPointerDown: (e: React.PointerEvent) => void
  title: string
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={title}
      onPointerDown={onPointerDown}
      className={`absolute top-0 bottom-0 ${edge === 'right' ? '-right-[2px]' : '-left-[2px]'} w-[5px] z-20 cursor-ew-resize
        ${dragging ? 'bg-[var(--pf-accent)]' : 'bg-transparent hover:bg-[var(--pf-accent)]/60'}`}
    />
  )
}
