// The canvas viewport: RAF-driven scene + overlay rendering, pointer routing
// into the InteractionController, wheel zoom/pan, context menu, text overlay.
//
// Two stacked canvases: the SCENE canvas below (Canvas2D, or WebGPU when the
// beta GPU renderer is enabled — remounted via key because a canvas cannot
// change context type), and the OVERLAY canvas above (always Canvas2D:
// selection chrome, rulers, guides — plus the grid in GPU mode). Pointer
// events live on the container so both modes behave identically.

import { useEffect, useRef, useState } from 'react'
import { drawGridInto, drawScene } from '../engine/render/canvas2d'
import { WebGPURenderer } from '../engine/render/webgpu/renderer'
import { drawOverlays, screenToWorld } from '../engine/render/overlays'
import { assetCache } from '../engine/assets'
import { onFontsChanged } from '../engine/fontstore'
import { onSnapshotChange } from '../render3d/snapshots'
import { documentStore } from '../state/document'
import { editor, useEditor } from '../state/editor'
import { interactionController } from '../interactions/controller'
import { hitTestAll, resolveClickTarget } from '../engine/hit-test'
import { setSelection } from '../state/actions'
import { TextEditOverlay } from './TextEditOverlay'

/** Windows/macOS double-click windows are ~500ms; 400ms with a small slop
 *  is the usual editor compromise between responsive and accidental. */
const DOUBLE_CLICK_MS = 400
const DOUBLE_CLICK_SLOP = 6

export function CanvasView() {
  const sceneCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  /** Click-count tracking for double-click gestures (see F-19). */
  const clickRef = useRef({ t: 0, x: 0, y: 0, count: 0 })
  const dirtyRef = useRef(true)
  const editingTextId = useEditor((s) => s.editingTextId)
  const gpuRender = useEditor((s) => s.gpuRender)
  const [gpuFailed, setGpuFailed] = useState(false)
  const useGpu = gpuRender && !gpuFailed && WebGPURenderer.isSupported()

  useEffect(() => {
    const sceneCanvas = sceneCanvasRef.current!
    const overlayCanvas = overlayCanvasRef.current!
    const container = containerRef.current!
    let raf = 0
    let disposed = false
    let gpu: WebGPURenderer | null = null
    const ctx2d = useGpu ? null : sceneCanvas.getContext('2d')!
    const overlayCtx = overlayCanvas.getContext('2d')!

    const markDirty = () => {
      dirtyRef.current = true
    }

    if (useGpu) {
      void WebGPURenderer.create(sceneCanvas).then((renderer) => {
        if (disposed) {
          renderer?.dispose()
          return
        }
        if (!renderer) {
          console.warn('[polyform] WebGPU unavailable — staying on Canvas2D rendering.')
          setGpuFailed(true)
          return
        }
        gpu = renderer
        markDirty()
      })
    }

    assetCache.onLoad = () => {
      gpu?.invalidate()
      markDirty()
    }
    // 3D snapshots land asynchronously like image decodes (ADR-020).
    const unsubModels = onSnapshotChange(() => {
      gpu?.invalidate()
      markDirty()
    })
    // Font bytes arriving flips text nodes from the legacy path to shaped
    // layout: re-run derived passes (auto-resize re-measures) and repaint.
    const unsubFonts = onFontsChanged(() => {
      gpu?.invalidate()
      documentStore.transient()
      markDirty()
    })
    const unsubDoc = documentStore.subscribe(markDirty)
    const unsubEditor = useEditor.subscribe(markDirty)

    const resize = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      for (const canvas of [sceneCanvas, overlayCanvas]) {
        canvas.width = Math.max(1, Math.round(rect.width * dpr))
        canvas.height = Math.max(1, Math.round(rect.height * dpr))
        canvas.style.width = `${rect.width}px`
        canvas.style.height = `${rect.height}px`
      }
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
        const renderOpts = {
          width: rect.width,
          height: rect.height,
          dpr,
          camera: state.camera,
          showGrid: state.showGrid,
          assets: assetCache,
          editingTextId: state.editingTextId,
        }
        if (gpu) {
          try {
            gpu.render(documentStore.scene, renderOpts)
          } catch (err) {
            console.warn('[polyform] WebGPU render failed — falling back to Canvas2D.', err)
            gpu.dispose()
            gpu = null
            setGpuFailed(true)
            return
          }
        } else if (ctx2d) {
          drawScene(ctx2d, documentStore.scene, documentStore.index, renderOpts)
        }
        overlayCtx.setTransform(1, 0, 0, 1, 0, 0)
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
        if (gpu) drawGridInto(overlayCtx, renderOpts)
        drawOverlays(overlayCtx, documentStore.scene, {
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
          pageGuides: documentStore.scene.activePage.guides,
          showRulers: state.showRulers,
          vectorEditId: state.vectorEditId,
          vectorSelection: state.vectorSelection,
        })
        container.style.cursor = interactionController.cursor
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    // Non-passive wheel handler (React's synthetic wheel is passive).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = container.getBoundingClientRect()
      interactionController.wheel(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        e.deltaX,
        e.deltaY,
        e.ctrlKey || e.metaKey,
        e.shiftKey,
      )
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      unsubFonts()
      unsubModels()
      unsubDoc()
      unsubEditor()
      container.removeEventListener('wheel', onWheel)
      assetCache.onLoad = null
      gpu?.dispose()
    }
  }, [useGpu])

  const pos = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden bg-[var(--pf-bg-1)]"
      onPointerDown={(e) => {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        const p = pos(e)
        // PointerEvent.detail is ALWAYS 0 per spec (only mouse events carry
        // a click count), so double-clicks must be timed here — reading
        // e.detail silently disabled every double-click gesture (F-19).
        const now = performance.now()
        const prev = clickRef.current
        const repeat =
          now - prev.t < DOUBLE_CLICK_MS && Math.hypot(p.x - prev.x, p.y - prev.y) < DOUBLE_CLICK_SLOP
        const count = repeat ? prev.count + 1 : 1
        clickRef.current = { t: now, x: p.x, y: p.y, count }
        interactionController.pointerDown(
          p,
          e.button,
          { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey },
          count >= 2,
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
    >
      <canvas key={useGpu ? 'gpu' : '2d'} ref={sceneCanvasRef} className="absolute inset-0" />
      <canvas ref={overlayCanvasRef} className="pointer-events-none absolute inset-0" />
      {editingTextId && <TextEditOverlay key={editingTextId} nodeId={editingTextId} />}
    </div>
  )
}
