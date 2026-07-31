// Canvas2D implementation of the scene renderer. Shapes are never DOM/SVG —
// everything paints into a GPU-composited <canvas>. The draw path is kept
// behind plain functions so a WebGPU backend can replace it (ADR-003).

import type { NodeId, Paint, SceneNode, BlendMode } from '../types'
import { isContainer } from '../types'
import type { SceneGraph } from '../scene'
import type { SpatialIndex } from '../spatial-index'
import type { AABB } from '../geometry'
import { aabbIntersects } from '../geometry'
import type { SubPath } from '../shapes'
import { nodeOutline } from '../shapes'
import { booleanRings } from '../booleans'
import { layoutText } from '../text'
import { rgbaToCss } from '../color'
import type { AssetCache } from '../assets'

export interface Camera {
  /** World coordinate at the viewport's top-left. */
  x: number
  y: number
  zoom: number
}

export interface RenderOptions {
  /** CSS pixel size of the viewport. */
  width: number
  height: number
  dpr: number
  camera: Camera
  showGrid: boolean
  assets: AssetCache
  /** Text node being edited in the DOM overlay — skipped on canvas. */
  editingTextId?: NodeId | null
  background?: string
}

const BLEND_MAP: Record<BlendMode, GlobalCompositeOperation> = {
  NORMAL: 'source-over',
  MULTIPLY: 'multiply',
  SCREEN: 'screen',
  OVERLAY: 'overlay',
  DARKEN: 'darken',
  LIGHTEN: 'lighten',
  COLOR_DODGE: 'color-dodge',
  COLOR_BURN: 'color-burn',
  HARD_LIGHT: 'hard-light',
  SOFT_LIGHT: 'soft-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
}

export function subPathsToPath2D(paths: SubPath[]): Path2D {
  const path = new Path2D()
  for (const sp of paths) {
    const n = sp.anchors.length
    if (n === 0) continue
    path.moveTo(sp.anchors[0].p.x, sp.anchors[0].p.y)
    const segCount = sp.closed ? n : n - 1
    for (let i = 0; i < segCount; i++) {
      const a = sp.anchors[i]
      const b = sp.anchors[(i + 1) % n]
      if (a.cpOut || b.cpIn) {
        const c0 = a.cpOut ?? a.p
        const c1 = b.cpIn ?? b.p
        path.bezierCurveTo(c0.x, c0.y, c1.x, c1.y, b.p.x, b.p.y)
      } else {
        path.lineTo(b.p.x, b.p.y)
      }
    }
    if (sp.closed) path.closePath()
  }
  return path
}

function ringsToPath2D(rings: { x: number; y: number }[][]): Path2D {
  const path = new Path2D()
  for (const ring of rings) {
    if (ring.length < 2) continue
    path.moveTo(ring[0].x, ring[0].y)
    for (let i = 1; i < ring.length; i++) path.lineTo(ring[i].x, ring[i].y)
    path.closePath()
  }
  return path
}

function paintStyle(
  ctx: CanvasRenderingContext2D,
  paint: Paint,
  w: number,
  h: number,
): string | CanvasGradient | null {
  if (paint.type === 'SOLID') return rgbaToCss(paint.color, paint.opacity)
  if (paint.type === 'GRADIENT_LINEAR') {
    const g = ctx.createLinearGradient(paint.start.x * w, paint.start.y * h, paint.end.x * w, paint.end.y * h)
    for (const stop of paint.stops) {
      g.addColorStop(Math.max(0, Math.min(1, stop.position)), rgbaToCss(stop.color, paint.opacity))
    }
    return g
  }
  if (paint.type === 'GRADIENT_RADIAL') {
    const cx = paint.start.x * w
    const cy = paint.start.y * h
    const r = Math.max(1e-3, Math.hypot((paint.end.x - paint.start.x) * w, (paint.end.y - paint.start.y) * h))
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    for (const stop of paint.stops) {
      g.addColorStop(Math.max(0, Math.min(1, stop.position)), rgbaToCss(stop.color, paint.opacity))
    }
    return g
  }
  return null
}

function drawImagePaint(
  ctx: CanvasRenderingContext2D,
  paint: Extract<Paint, { type: 'IMAGE' }>,
  path: Path2D,
  w: number,
  h: number,
  fillRule: CanvasFillRule,
  assets: AssetCache,
): void {
  const bmp = assets.getBitmap(paint.assetHash)
  ctx.save()
  ctx.clip(path, fillRule)
  if (!bmp) {
    ctx.fillStyle = 'rgba(128,128,128,0.35)'
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
    return
  }
  ctx.globalAlpha *= paint.opacity
  const iw = bmp.width
  const ih = bmp.height
  if (paint.scaleMode === 'STRETCH') {
    ctx.drawImage(bmp, 0, 0, w, h)
  } else if (paint.scaleMode === 'TILE') {
    const pattern = ctx.createPattern(bmp, 'repeat')
    if (pattern) {
      ctx.fillStyle = pattern
      ctx.fillRect(0, 0, w, h)
    }
  } else {
    const scale = paint.scaleMode === 'FILL' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih)
    const dw = iw * scale
    const dh = ih * scale
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh)
  }
  ctx.restore()
}

function fillPath(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  path: Path2D,
  fillRule: CanvasFillRule,
  assets: AssetCache,
): void {
  for (const paint of node.fills) {
    if (!paint.visible) continue
    if (paint.type === 'IMAGE') {
      drawImagePaint(ctx, paint, path, node.width, node.height, fillRule, assets)
    } else {
      const style = paintStyle(ctx, paint, node.width, node.height)
      if (!style) continue
      ctx.fillStyle = style
      ctx.fill(path, fillRule)
    }
    // Drop shadow (if set) should only apply to the first paint pass.
    ctx.shadowColor = 'transparent'
  }
}

function strokePath(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  path: Path2D,
  hasClosedGeometry: boolean,
): void {
  const weight = node.strokeWeight
  if (weight <= 0) return
  const align = hasClosedGeometry ? node.strokeAlign : 'CENTER'
  for (const paint of node.strokes) {
    if (!paint.visible || paint.type === 'IMAGE') continue
    const style = paintStyle(ctx, paint, node.width, node.height)
    if (!style) continue
    ctx.strokeStyle = style
    if (node.strokeDash.length > 0) ctx.setLineDash(node.strokeDash)
    if (align === 'CENTER') {
      ctx.lineWidth = weight
      ctx.stroke(path)
    } else if (align === 'INSIDE') {
      ctx.save()
      ctx.clip(path)
      ctx.lineWidth = weight * 2
      ctx.stroke(path)
      ctx.restore()
    } else {
      // OUTSIDE: clip to everything except the shape, stroke double-width.
      ctx.save()
      const outer = new Path2D()
      outer.rect(-1e6, -1e6, 2e6, 2e6)
      outer.addPath(path)
      ctx.clip(outer, 'evenodd')
      ctx.lineWidth = weight * 2
      ctx.stroke(path)
      ctx.restore()
    }
    ctx.setLineDash([])
    ctx.shadowColor = 'transparent'
  }
}

function applyEffectsBeforeDraw(ctx: CanvasRenderingContext2D, node: SceneNode, zoom: number): void {
  for (const fx of node.effects) {
    if (!fx.visible) continue
    if (fx.type === 'DROP_SHADOW') {
      ctx.shadowColor = rgbaToCss(fx.color)
      // shadow params are in device space — scale by current zoom * dpr.
      const scale = ctx.getTransform().a
      ctx.shadowOffsetX = fx.offset.x * scale
      ctx.shadowOffsetY = fx.offset.y * scale
      ctx.shadowBlur = fx.blur * scale
    } else if (fx.type === 'LAYER_BLUR' && fx.radius > 0) {
      ctx.filter = `blur(${fx.radius * zoom}px)`
    }
  }
}

function drawText(ctx: CanvasRenderingContext2D, node: Extract<SceneNode, { type: 'TEXT' }>): void {
  const layout = layoutText(node)
  const paint = node.fills.find((f) => f.visible)
  if (!paint) return
  const style =
    paint.type === 'IMAGE' ? 'rgba(0,0,0,1)' : (paintStyle(ctx, paint, node.width, node.height) ?? 'rgba(0,0,0,1)')
  ctx.fillStyle = style
  ctx.font = layout.font
  try {
    ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${node.letterSpacing}px`
  } catch {
    /* unsupported */
  }
  ctx.textBaseline = 'alphabetic'
  for (const line of layout.lines) {
    if (line.text.length === 0) continue
    ctx.fillText(line.text, line.x, line.baseline)
  }
  try {
    ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px'
  } catch {
    /* unsupported */
  }
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  id: NodeId,
  opts: RenderOptions,
  viewBox: AABB,
): void {
  const node = scene.getNode(id)
  if (!node || !node.visible || node.opacity <= 0) return
  if (!aabbIntersects(scene.worldAABB(id), viewBox)) return

  ctx.save()
  const m = scene.localMatrix(node)
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f)
  ctx.globalAlpha *= node.opacity
  if (node.blendMode !== 'NORMAL') ctx.globalCompositeOperation = BLEND_MAP[node.blendMode]
  applyEffectsBeforeDraw(ctx, node, opts.camera.zoom)

  switch (node.type) {
    case 'FRAME': {
      const path = subPathsToPath2D(nodeOutline(node))
      fillPath(ctx, node, path, 'nonzero', opts.assets)
      if (node.clipsContent) ctx.clip(path)
      for (const cid of node.children) drawNode(ctx, scene, cid, opts, viewBox)
      strokePath(ctx, node, path, true)
      break
    }
    case 'GROUP': {
      for (const cid of node.children) drawNode(ctx, scene, cid, opts, viewBox)
      break
    }
    case 'BOOLEAN': {
      const rings = booleanRings(scene, node)
      if (rings.length > 0) {
        const path = ringsToPath2D(rings)
        fillPath(ctx, node, path, 'evenodd', opts.assets)
        strokePath(ctx, node, path, true)
      }
      break
    }
    case 'TEXT': {
      if (opts.editingTextId !== node.id) drawText(ctx, node)
      break
    }
    case 'LINE': {
      const path = subPathsToPath2D(nodeOutline(node))
      strokePath(ctx, node, path, false)
      break
    }
    case 'VECTOR': {
      const subpaths = nodeOutline(node)
      const path = subPathsToPath2D(subpaths)
      const hasClosed = subpaths.some((sp) => sp.closed)
      if (hasClosed) {
        fillPath(ctx, node, path, node.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero', opts.assets)
      }
      strokePath(ctx, node, path, hasClosed)
      break
    }
    default: {
      // RECTANGLE / ELLIPSE / POLYGON / STAR
      const path = subPathsToPath2D(nodeOutline(node))
      fillPath(ctx, node, path, 'nonzero', opts.assets)
      strokePath(ctx, node, path, true)
      break
    }
  }
  ctx.restore()
}

function drawGrid(ctx: CanvasRenderingContext2D, opts: RenderOptions, viewBox: AABB): void {
  const { zoom } = opts.camera
  const spacing = opts.showGrid ? 8 : 1
  if (!opts.showGrid && zoom < 8) return
  if (opts.showGrid && zoom * spacing < 5) return
  ctx.save()
  ctx.lineWidth = 1 / zoom
  ctx.strokeStyle = opts.showGrid ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.05)'
  ctx.beginPath()
  const x0 = Math.floor(viewBox.minX / spacing) * spacing
  const y0 = Math.floor(viewBox.minY / spacing) * spacing
  for (let x = x0; x <= viewBox.maxX; x += spacing) {
    ctx.moveTo(x, viewBox.minY)
    ctx.lineTo(x, viewBox.maxY)
  }
  for (let y = y0; y <= viewBox.maxY; y += spacing) {
    ctx.moveTo(viewBox.minX, y)
    ctx.lineTo(viewBox.maxX, y)
  }
  ctx.stroke()
  ctx.restore()
}

/** Render the whole scene for the interactive viewport. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  index: SpatialIndex,
  opts: RenderOptions,
): void {
  const { camera, dpr } = opts
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = opts.background ?? '#1e1e1e'
  ctx.fillRect(0, 0, opts.width, opts.height)

  index.sync(scene)
  const viewBox: AABB = {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + opts.width / camera.zoom,
    maxY: camera.y + opts.height / camera.zoom,
  }

  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr)
  for (const id of scene.doc.rootIds) drawNode(ctx, scene, id, opts, viewBox)
  drawGrid(ctx, opts, viewBox)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

/**
 * Render a set of root nodes into a fresh canvas at `scale` (export path).
 * Bounds are the world AABB union of the nodes.
 */
export function renderNodesToCanvas(
  scene: SceneGraph,
  index: SpatialIndex,
  ids: NodeId[],
  scale: number,
  assets: AssetCache,
  background: string | null,
): HTMLCanvasElement | null {
  if (ids.length === 0) return null
  let box: AABB | null = null
  for (const id of ids) {
    const b = scene.worldAABB(id)
    box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : { ...b }
  }
  if (!box) return null
  const w = Math.max(1, Math.ceil((box.maxX - box.minX) * scale))
  const h = Math.max(1, Math.ceil((box.maxY - box.minY) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, w, h)
  }
  const opts: RenderOptions = {
    width: w,
    height: h,
    dpr: 1,
    camera: { x: box.minX, y: box.minY, zoom: scale },
    showGrid: false,
    assets,
    editingTextId: null,
  }
  const viewBox: AABB = { ...box }
  ctx.setTransform(scale, 0, 0, scale, -box.minX * scale, -box.minY * scale)
  // Draw only the requested subtrees, in scene z-order.
  const rank = scene.zRank()
  const sorted = [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
  for (const id of sorted) drawNode(ctx, scene, id, opts, viewBox)
  return canvas
}
