// The canvas viewport: RAF-driven scene + overlay rendering, pointer routing
// into the InteractionController, wheel zoom/pan, context menu, text overlay.

import { useEffect, useRef } from 'react'
import { drawScene } from '../engine/render/canvas2d'
import { drawOverlays, screenToWorld } from '../engine/render/overlays'
import { assetCache } from '../engine/assets'
import { documentStore } from '../state/document'
import { editor, useEditor } from '../state/editor'
import { interactionController } from '../interactions/controller'
import { hitTestAll, resolveClickTarget } from '../engine/hit-test'
import { setSelection } from '../state/actions'
import { TextEditOverlay } from './TextEditOverlay'

export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dirtyRef = useRef(true)
  const editingTextId = useEditor((s) => s.editingTextId)

  useEffect(() => {
    const canvas = canvasRef.current!
    const container = containerRef.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    let disposed = false

    const markDirty = () => {
      dirtyRef.current = true
    }

    assetCache.onLoad = markDirty
    const unsubDoc = documentStore.subscribe(markDirty)
    const unsubEditor = useEditor.subscribe(markDirty)

    const resize = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      editor.get().setViewportSize({ w: rect.width, h: rect.height })
      markDirty()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(container)
    resize()

    const frame = () => {
      if (disposed) return
      if (dirtyRef.current) {
        dirtyRef.current = false
        const state = editor.get()
        const rect = container.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        drawScene(ctx, documentStore.scene, documentStore.index, {
          width: rect.width,
          height: rect.height,
          dpr,
          camera: state.camera,
          showGrid: state.showGrid,
          assets: assetCache,
          editingTextId: state.editingTextId,
        })
        drawOverlays(ctx, documentStore.scene, {
          camera: state.camera,
          width: rect.width,
          height: rect.height,
          dpr,
          selection: state.selection,
          hover: state.hover,
          marquee: state.marquee,
          guides: state.guides,
          penDraft: state.penDraft,
          editingTextId: state.editingTextId,
        })
        canvas.style.cursor = interactionController.cursor
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    // Non-passive wheel handler (React's synthetic wheel is passive).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      interactionController.wheel(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        e.deltaX,
        e.deltaY,
        e.ctrlKey || e.metaKey,
        e.shiftKey,
      )
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      unsubDoc()
      unsubEditor()
      canvas.removeEventListener('wheel', onWheel)
      assetCache.onLoad = null
    }
  }, [])

  const pos = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden bg-[var(--pf-bg-1)]">
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          interactionController.pointerDown(
            pos(e),
            e.button,
            { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey },
            e.detail >= 2,
          )
        }}
        onPointerMove={(e) => {
          interactionController.pointerMove(pos(e), {
            shift: e.shiftKey,
            alt: e.altKey,
            ctrl: e.ctrlKey || e.metaKey,
          })
        }}
        onPointerUp={(e) => {
          interactionController.pointerUp(pos(e), {
            shift: e.shiftKey,
            alt: e.altKey,
            ctrl: e.ctrlKey || e.metaKey,
          })
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          const state = editor.get()
          const world = screenToWorld(state.camera, pos(e))
          const hits = hitTestAll(documentStore.scene, documentStore.index, world, {
            tolerancePx: 4,
            zoom: state.camera.zoom,
          })
          if (hits.length > 0) {
            const target = resolveClickTarget(documentStore.scene, hits[0], null)
            if (!state.selection.includes(target) && !hits.some((h) => state.selection.includes(h))) {
              setSelection([target])
            }
          }
          editor.set({ contextMenu: { x: e.clientX, y: e.clientY } })
        }}
      />
      {editingTextId && <TextEditOverlay key={editingTextId} nodeId={editingTextId} />}
    </div>
  )
}
