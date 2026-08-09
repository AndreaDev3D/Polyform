// Canvas2D implementation of the scene renderer. Shapes are never DOM/SVG —
// everything paints into a GPU-composited <canvas>. The draw path is kept
// behind plain functions so a WebGPU backend can replace it (ADR-003).

import type { NodeId, Paint, SceneNode, BlendMode, Model3dNode, DropShadowEffect } from '../types'
import { isContainer } from '../types'
import type { SceneGraph } from '../scene'
import type { SpatialIndex } from '../spatial-index'
import type { AABB } from '../geometry'
import { aabbIntersects, matInvert } from '../geometry'
import type { SubPath } from '../shapes'
import { fillPaintBox, paintPoint, strokePaintBox, type PaintBox } from '../paintbox'
import { nodeOutline } from '../shapes'
import { booleanRings } from '../booleans'
import { layoutText } from '../text'
import { glyphOutline } from '../glyphs'
import { rgbaToCss } from '../color'
import type { AssetCache } from '../assets'
import {
  getSnapshot,
  getStaleSnapshot,
  requestSnapshot,
  snapshotError,
  snapshotSpec,
} from '../../render3d/snapshots'

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

/**
 * A paint as a Canvas2D style, with the gradient mapped through `box` rather than
 * through the node's size. The box matters: a stroke on a LINE has to use the box
 * the STROKE covers, because the node's own height is 0 and a gradient mapped
 * through it collapses to a zero-length one, which Canvas2D paints as fully
 * transparent (see engine/paintbox.ts).
 */
function paintStyle(
  ctx: CanvasRenderingContext2D,
  paint: Paint,
  box: PaintBox,
): string | CanvasGradient | null {
  if (paint.type === 'SOLID') return rgbaToCss(paint.color, paint.opacity)
  if (paint.type === 'GRADIENT_LINEAR') {
    const from = paintPoint(box, paint.start)
    const to = paintPoint(box, paint.end)
    const g = ctx.createLinearGradient(from.x, from.y, to.x, to.y)
    for (const stop of paint.stops) {
      g.addColorStop(Math.max(0, Math.min(1, stop.position)), rgbaToCss(stop.color, paint.opacity))
    }
    return g
  }
  if (paint.type === 'GRADIENT_RADIAL') {
    const from = paintPoint(box, paint.start)
    const to = paintPoint(box, paint.end)
    const r = Math.max(1e-3, Math.hypot(to.x - from.x, to.y - from.y))
    const g = ctx.createRadialGradient(from.x, from.y, 0, from.x, from.y, r)
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
  // Non-destructive adjustments via canvas filters.
  const adj = paint.adjust
  if (adj && (adj.exposure !== 0 || adj.contrast !== 0 || adj.saturation !== 0)) {
    const clamp01 = (v: number) => Math.max(0, 1 + v)
    ctx.filter = `brightness(${clamp01(adj.exposure)}) contrast(${clamp01(adj.contrast)}) saturate(${clamp01(adj.saturation)})`
  }
  const iw = bmp.width
  const ih = bmp.height
  // Crop rect (normalized to the source image).
  const crop = paint.crop
  let sx = 0
  let sy = 0
  let sw = iw
  let sh = ih
  if (crop && crop.w > 0.001 && crop.h > 0.001) {
    sx = Math.max(0, Math.min(1, crop.x)) * iw
    sy = Math.max(0, Math.min(1, crop.y)) * ih
    sw = Math.max(0.001, Math.min(1 - crop.x, crop.w)) * iw
    sh = Math.max(0.001, Math.min(1 - crop.y, crop.h)) * ih
  }
  if (paint.scaleMode === 'STRETCH') {
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h)
  } else if (paint.scaleMode === 'TILE') {
    const pattern = ctx.createPattern(bmp, 'repeat')
    if (pattern) {
      ctx.fillStyle = pattern
      ctx.fillRect(0, 0, w, h)
    }
  } else {
    const scale = paint.scaleMode === 'FILL' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh)
    const dw = sw * scale
    const dh = sh * scale
    ctx.drawImage(bmp, sx, sy, sw, sh, (w - dw) / 2, (h - dh) / 2, dw, dh)
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
      const style = paintStyle(ctx, paint, fillPaintBox(node))
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
  // Open geometry has no inside, so alignment cannot mean anything (paintbox.ts:
  // strokeAlignApplies is the same rule, and the inspector disables the control on
  // the strength of it instead of storing a value nothing reads).
  const align = hasClosedGeometry ? node.strokeAlign : 'CENTER'
  for (const paint of node.strokes) {
    if (!paint.visible || paint.type === 'IMAGE') continue
    // The stroke's own box, not the node's: on a line the node has no height.
    const style = paintStyle(ctx, paint, strokePaintBox(node))
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

/**
 * Canvas shadow params live in DEVICE space (unaffected by the CTM), so they
 * scale by dpr*zoom — never by the CTM's `a` component, which shrinks under
 * rotation. Shadows are only applied to nodes that paint their own geometry;
 * containers without fills/strokes would otherwise leak the shadow onto every
 * descendant.
 */
function applyEffectsBeforeDraw(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  deviceScale: number,
  allowShadow: boolean,
): void {
  for (const fx of node.effects) {
    if (!fx.visible) continue
    if (fx.type === 'DROP_SHADOW' && allowShadow) {
      ctx.shadowColor = rgbaToCss(fx.color)
      ctx.shadowOffsetX = fx.offset.x * deviceScale
      ctx.shadowOffsetY = fx.offset.y * deviceScale
      ctx.shadowBlur = fx.blur * deviceScale
    } else if (fx.type === 'LAYER_BLUR' && fx.radius > 0) {
      ctx.filter = `blur(${fx.radius * deviceScale}px)`
    }
  }
}

function clearShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = 'transparent'
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
  ctx.shadowBlur = 0
}

/**
 * Inner shadow: clip to the shape, then fill the INVERSE region with an
 * offset shadow — only the shadow cast into the clip is visible.
 */
function drawInnerShadows(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  path: Path2D,
  fillRule: CanvasFillRule,
  deviceScale: number,
): void {
  for (const fx of node.effects) {
    if (fx.type !== 'INNER_SHADOW' || !fx.visible) continue
    ctx.save()
    ctx.clip(path, fillRule)
    ctx.shadowColor = rgbaToCss(fx.color)
    ctx.shadowOffsetX = fx.offset.x * deviceScale
    ctx.shadowOffsetY = fx.offset.y * deviceScale
    ctx.shadowBlur = fx.blur * deviceScale
    const inverse = new Path2D()
    inverse.rect(-1e6, -1e6, 2e6, 2e6)
    inverse.addPath(path)
    ctx.fillStyle = '#000'
    ctx.fill(inverse, 'evenodd')
    ctx.restore()
  }
}

/**
 * Background blur: snapshot what is already painted, re-draw it blurred and
 * clipped to the shape (device-space self-drawImage), then paint the node's
 * own translucent fills on top.
 */
function applyBackgroundBlur(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  path: Path2D,
  fillRule: CanvasFillRule,
  deviceScale: number,
): void {
  const fx = node.effects.find((e) => e.type === 'BACKGROUND_BLUR' && e.visible && e.radius > 0)
  if (!fx || fx.type !== 'BACKGROUND_BLUR') return
  ctx.save()
  const devicePath = new Path2D()
  devicePath.addPath(path, ctx.getTransform())
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  clearShadow(ctx)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.clip(devicePath, fillRule)
  ctx.filter = `blur(${fx.radius * deviceScale}px)`
  try {
    ctx.drawImage(ctx.canvas, 0, 0)
  } catch {
    /* zero-sized canvas edge cases */
  }
  ctx.restore()
}

function drawText(ctx: CanvasRenderingContext2D, node: Extract<SceneNode, { type: 'TEXT' }>): void {
  const layout = layoutText(node)
  const paint = node.fills.find((f) => f.visible)
  if (!paint) return
  const style =
    paint.type === 'IMAGE' ? 'rgba(0,0,0,1)' : (paintStyle(ctx, paint, fillPaintBox(node)) ?? 'rgba(0,0,0,1)')
  if (layout.shaped) {
    // Shaped path: fill the actual glyph outlines. One combined Path2D per
    // node keeps gradient fills aligned to node space.
    const s = node.fontSize / layout.shaped.unitsPerEm
    const combined = new Path2D()
    for (const line of layout.lines) {
      const glyphs = line.glyphs
      if (!glyphs) continue
      for (let i = 0; i + 3 <= glyphs.length; i += 3) {
        const outline = glyphOutline(layout.shaped.fontId, glyphs[i])
        if (!outline?.path) continue
        combined.addPath(outline.path, new DOMMatrix([s, 0, 0, s, glyphs[i + 1], glyphs[i + 2]]))
      }
    }
    ctx.fillStyle = style
    ctx.fill(combined)
    return
  }
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

/** Rasterize a text node into an arbitrary 2D context (WebGPU text quads). */
export function drawTextInto(
  ctx: CanvasRenderingContext2D,
  node: Extract<SceneNode, { type: 'TEXT' }>,
): void {
  drawText(ctx, node)
}

/**
 * Draw a 3D model's offscreen render (ADR-020). Snapshots resolve
 * asynchronously like image decodes: a miss paints a placeholder and
 * requests the render, and the ready notification triggers a redraw.
 */
export function drawModel3d(
  ctx: CanvasRenderingContext2D,
  node: Model3dNode,
  deviceScale: number,
): void {
  const w = node.width
  const h = node.height
  if (w <= 0 || h <= 0) return
  if (!node.assetHash) {
    drawModelPlaceholder(ctx, w, h, 'No model')
    return
  }
  const spec = snapshotSpec(node, w, h, deviceScale)
  const ready = getSnapshot(spec)
  if (ready) {
    ctx.drawImage(ready, 0, 0, w, h)
    return
  }
  requestSnapshot(spec)
  const err = snapshotError(spec)
  if (err) {
    drawModelPlaceholder(ctx, w, h, err)
    return
  }
  // A previous pose renders stretched until the exact view lands: far less
  // jarring than a grey box while orbiting or zooming.
  const stale = getStaleSnapshot(spec)
  if (stale) ctx.drawImage(stale, 0, 0, w, h)
  else drawModelPlaceholder(ctx, w, h, null)
}

function drawModelPlaceholder(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  message: string | null,
): void {
  ctx.save()
  ctx.fillStyle = 'rgba(128,128,128,0.35)'
  ctx.fillRect(0, 0, w, h)
  if (message) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = `${Math.max(8, Math.min(14, h / 8))}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(message, w / 2, h / 2, w * 0.9)
  }
  ctx.restore()
}

/** Node-local Path2D used when this node acts as a mask. */
function maskPathFor(scene: SceneGraph, node: SceneNode): Path2D {
  if (node.type === 'BOOLEAN') return ringsToPath2D(booleanRings(scene, node))
  return subPathsToPath2D(nodeOutline(node))
}

/**
 * Draw a sibling list with Figma mask semantics: a mask node is not painted
 * itself; it clips every sibling drawn after (above) it in the same scope.
 */
function drawChildren(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  children: readonly NodeId[],
  opts: RenderOptions,
  viewBox: AABB,
): void {
  let maskDepth = 0
  for (const cid of children) {
    const child = scene.getNode(cid)
    if (!child) continue
    if (child.isMask && child.visible) {
      const lm = scene.localMatrix(child)
      const clipPath = new Path2D()
      clipPath.addPath(maskPathFor(scene, child), new DOMMatrix([lm.a, lm.b, lm.c, lm.d, lm.e, lm.f]))
      ctx.save()
      ctx.clip(clipPath, child.type === 'BOOLEAN' ? 'evenodd' : 'nonzero')
      maskDepth++
      continue
    }
    drawNode(ctx, scene, cid, opts, viewBox)
  }
  while (maskDepth-- > 0) ctx.restore()
}

/**
 * Effects that have to apply to a container's COMPOSITE instead of to each
 * child separately.
 *
 * A group's drop shadow is cast by the silhouette of everything inside it, as
 * one shape: no shadow falls in the seam between two touching children, and a
 * layer blur blurs the assembled picture rather than each piece on its own.
 * That is what Figma does, and what our own SVG export already did by hanging
 * the filter on the `<g>`. Canvas shadow and filter state is per-draw-call, so
 * the only way to get it here is to render the subtree once, off to the side,
 * and composite the result as a single image.
 *
 * Containers that paint their own geometry keep the cheaper direct path: their
 * shadow comes from their own outline, which is also what Figma shows.
 *
 * Two effects stay out of this: an INNER_SHADOW needs a path to clip to and a
 * group has none, and a BACKGROUND_BLUR inside a flattened subtree samples the
 * scratch buffer, which has no backdrop to blur.
 */
function compositeEffects(
  node: SceneNode,
  paintsSelf: boolean,
): { drop: DropShadowEffect | null; blur: number } | null {
  if (paintsSelf || node.type === 'BOOLEAN' || !isContainer(node) || node.children.length === 0) {
    return null
  }
  let drop: DropShadowEffect | null = null
  let blur = 0
  for (const fx of node.effects) {
    if (!fx.visible) continue
    // Last one wins, matching the direct path's overwrite of ctx state.
    if (fx.type === 'DROP_SHADOW') drop = fx
    else if (fx.type === 'LAYER_BLUR' && fx.radius > 0) blur = fx.radius
  }
  return drop || blur > 0 ? { drop, blur } : null
}

/**
 * Scratch canvases for the flattening path, one per nesting level so a
 * flattened group inside another does not paint over its parent's buffer. They
 * only ever grow, and are bounded by the target canvas plus the effect's reach.
 */
const flattenPool: (HTMLCanvasElement | OffscreenCanvas)[] = []
let flattenDepth = 0

function scratchCanvas(depth: number): HTMLCanvasElement | OffscreenCanvas {
  const existing = flattenPool[depth]
  if (existing) return existing
  // OffscreenCanvas where it exists (the parity harness renders into one, and
  // it skips DOM bookkeeping), a detached <canvas> otherwise.
  const made =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')
  flattenPool[depth] = made
  return made
}

/** Cap on how far past the viewport a shadow or blur is allowed to pull, in
 *  device px, so an extreme blur can't ask for an unbounded buffer. */
const FLATTEN_MAX_REACH = 400

/**
 * Render a container's subtree into a scratch canvas, then composite that one
 * image with the shadow/blur applied to it as a whole.
 */
function drawFlattened(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  node: SceneNode,
  opts: RenderOptions,
  viewBox: AABB,
  deviceScale: number,
  fx: { drop: DropShadowEffect | null; blur: number },
): void {
  // The subtree's device-space box, mapped straight from its world box through
  // (current CTM) ∘ (world → node-local), so rotation doesn't inflate it twice.
  const inv = matInvert(scene.worldMatrix(node.id))
  const toDevice = ctx.getTransform().multiply(new DOMMatrix([inv.a, inv.b, inv.c, inv.d, inv.e, inv.f]))
  const wb = scene.worldAABB(node.id)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [wx, wy] of [
    [wb.minX, wb.minY],
    [wb.maxX, wb.minY],
    [wb.maxX, wb.maxY],
    [wb.minX, wb.maxY],
  ]) {
    const p = toDevice.transformPoint(new DOMPoint(wx, wy))
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }

  // Content outside the viewport can still cast into it, so the buffer covers
  // the visible area expanded by the effect's reach — no further.
  const shadowReach = fx.drop
    ? (fx.drop.blur * 1.5 + Math.max(Math.abs(fx.drop.offset.x), Math.abs(fx.drop.offset.y))) * deviceScale
    : 0
  const reach = Math.min(FLATTEN_MAX_REACH, Math.max(shadowReach, fx.blur * 3 * deviceScale)) + 2
  const bx = Math.max(Math.floor(minX) - 2, -Math.ceil(reach))
  const by = Math.max(Math.floor(minY) - 2, -Math.ceil(reach))
  const w = Math.min(Math.ceil(maxX) + 2, ctx.canvas.width + Math.ceil(reach)) - bx
  const h = Math.min(Math.ceil(maxY) + 2, ctx.canvas.height + Math.ceil(reach)) - by
  if (w <= 0 || h <= 0) return

  const scratch = scratchCanvas(flattenDepth)
  if (scratch.width < w) scratch.width = w
  if (scratch.height < h) scratch.height = h
  const octx = scratch.getContext('2d') as CanvasRenderingContext2D | null
  if (!octx) {
    // No buffer to be had: better a shadow-less group than a missing one.
    drawNodeContent(ctx, scene, node, opts, viewBox, deviceScale)
    return
  }
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.clearRect(0, 0, w, h)
  octx.setTransform(new DOMMatrix([1, 0, 0, 1, -bx, -by]).multiply(ctx.getTransform()))
  // Opacity goes INTO the buffer rather than onto the blit, so children keep
  // compositing against each other exactly as they do on the direct path (and
  // as the GPU backend's layer path does). Flattening a group's opacity is a
  // separate change, and one that would have to be made in both renderers.
  octx.globalAlpha = ctx.globalAlpha
  flattenDepth++
  try {
    drawNodeContent(octx, scene, node, opts, viewBox, deviceScale)
  } finally {
    flattenDepth--
  }

  ctx.save()
  // Device space for the blit: shadow offsets and blur radii are device-space
  // quantities, and the buffer is already rasterized. Alpha is already in the
  // buffer; the blend mode still applies, to the composite as a whole.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  if (fx.drop) {
    ctx.shadowColor = rgbaToCss(fx.drop.color)
    ctx.shadowOffsetX = fx.drop.offset.x * deviceScale
    ctx.shadowOffsetY = fx.drop.offset.y * deviceScale
    ctx.shadowBlur = fx.drop.blur * deviceScale
  }
  if (fx.blur > 0) ctx.filter = `blur(${fx.blur * deviceScale}px)`
  ctx.drawImage(scratch, 0, 0, w, h, bx, by, w, h)
  ctx.restore()
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
  const deviceScale = opts.camera.zoom * opts.dpr
  const paintsSelf =
    node.type !== 'GROUP' && (node.fills.some((f) => f.visible) || node.strokes.some((s) => s.visible))
  const composite = compositeEffects(node, paintsSelf)
  if (composite) {
    drawFlattened(ctx, scene, node, opts, viewBox, deviceScale, composite)
    ctx.restore()
    return
  }
  applyEffectsBeforeDraw(ctx, node, deviceScale, paintsSelf)
  drawNodeContent(ctx, scene, node, opts, viewBox, deviceScale)
  ctx.restore()
}

/** The node's own painting, with no effect state of its own applied. */
function drawNodeContent(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  node: SceneNode,
  opts: RenderOptions,
  viewBox: AABB,
  deviceScale: number,
): void {
  switch (node.type) {
    case 'FRAME':
    case 'COMPONENT':
    case 'INSTANCE': {
      const path = subPathsToPath2D(nodeOutline(node))
      applyBackgroundBlur(ctx, node, path, 'nonzero', deviceScale)
      fillPath(ctx, node, path, 'nonzero', opts.assets)
      drawInnerShadows(ctx, node, path, 'nonzero', deviceScale)
      clearShadow(ctx)
      ctx.save()
      if (node.clipsContent) ctx.clip(path)
      drawChildren(ctx, scene, node.children, opts, viewBox)
      ctx.restore()
      strokePath(ctx, node, path, true)
      break
    }
    case 'GROUP': {
      drawChildren(ctx, scene, node.children, opts, viewBox)
      break
    }
    case 'BOOLEAN': {
      const rings = booleanRings(scene, node)
      if (rings.length > 0) {
        const path = ringsToPath2D(rings)
        applyBackgroundBlur(ctx, node, path, 'evenodd', deviceScale)
        fillPath(ctx, node, path, 'evenodd', opts.assets)
        drawInnerShadows(ctx, node, path, 'evenodd', deviceScale)
        strokePath(ctx, node, path, true)
      }
      break
    }
    case 'TEXT': {
      if (opts.editingTextId !== node.id) drawText(ctx, node)
      break
    }
    case 'MODEL3D': {
      drawModel3d(ctx, node, deviceScale)
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
      const rule: CanvasFillRule = node.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero'
      if (hasClosed) {
        applyBackgroundBlur(ctx, node, path, rule, deviceScale)
        fillPath(ctx, node, path, rule, opts.assets)
        drawInnerShadows(ctx, node, path, rule, deviceScale)
      }
      strokePath(ctx, node, path, hasClosed)
      break
    }
    default: {
      // RECTANGLE / ELLIPSE / POLYGON / STAR
      const path = subPathsToPath2D(nodeOutline(node))
      applyBackgroundBlur(ctx, node, path, 'nonzero', deviceScale)
      fillPath(ctx, node, path, 'nonzero', opts.assets)
      drawInnerShadows(ctx, node, path, 'nonzero', deviceScale)
      strokePath(ctx, node, path, true)
      break
    }
  }
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

/**
 * Grid pass for the WebGPU mode's overlay canvas (the GPU backend draws the
 * scene; the grid stays a cheap Canvas2D pass layered above it, exactly
 * where drawScene paints it).
 */
export function drawGridInto(ctx: CanvasRenderingContext2D, opts: RenderOptions): void {
  const { camera, dpr } = opts
  const viewBox: AABB = {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + opts.width / camera.zoom,
    maxY: camera.y + opts.height / camera.zoom,
  }
  ctx.save()
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr)
  drawGrid(ctx, opts, viewBox)
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
  drawChildren(ctx, scene, scene.rootIds(), opts, viewBox)
  drawGrid(ctx, opts, viewBox)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

/**
 * Render a set of root nodes into a fresh canvas at `scale` (export path).
 * Bounds are the world AABB union of the nodes, or `region` when given —
 * the agent viewport snapshot (7.2) needs an exact rect rather than a
 * shrink-to-fit, so that what it returns is what the user is looking at.
 */
export function renderNodesToCanvas(
  scene: SceneGraph,
  index: SpatialIndex,
  ids: NodeId[],
  scale: number,
  assets: AssetCache,
  background: string | null,
  region?: AABB,
): HTMLCanvasElement | null {
  if (ids.length === 0 && !region) return null
  let box: AABB | null = region ? { ...region } : null
  if (!box) {
    for (const id of ids) {
      const b = scene.worldAABB(id)
      box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : { ...b }
    }
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
  //
  // drawNode applies the node's LOCAL matrix, because in the normal recursion
  // the context is already in the parent's space. Drawing a nested node
  // directly means that space has to be established here — without it, a shape
  // inside a frame is painted at its frame-local position while the viewport
  // sits at its world position, so the render comes out EMPTY. That silently
  // broke exporting any selection inside a frame, and every agent snapshot of
  // a nested node.
  const rank = scene.zRank()
  const sorted = [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
  for (const id of sorted) {
    const parentId = scene.parentOf(id)
    if (!parentId) {
      drawNode(ctx, scene, id, opts, viewBox)
      continue
    }
    const pm = scene.worldMatrix(parentId)
    ctx.save()
    ctx.transform(pm.a, pm.b, pm.c, pm.d, pm.e, pm.f)
    drawNode(ctx, scene, id, opts, viewBox)
    ctx.restore()
  }
  return canvas
}
