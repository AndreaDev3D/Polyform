// Where a paint's coordinates land, and where stroke alignment means nothing.
//
// Both questions have the same root: **a LINE has height 0.** That is not an edge
// case to defend against, it is what a line *is* in this model — a segment along
// its own x-axis, with a stroke and no interior. Two consequences follow, and both
// were wrong before v0.8.
//
// 1. GRADIENTS VANISHED. A paint's `start`/`end` are unit coordinates mapped
//    through the node's box, so on a line the vertical axis collapses to nothing:
//    the default vertical gradient's start and end land on the *same point*.
//    Canvas2D paints a zero-length linear gradient as fully transparent, and the
//    GPU shader divides by a zero-length axis, so the stroke simply disappeared —
//    weight 65, colour set, nothing on screen. The box that means something for a
//    stroke is the box the **stroke** covers: half its weight either side of the
//    path.
//
// 2. ALIGNMENT WAS A LIE. "Inside" and "Outside" need an interior. Both renderers
//    already force CENTER for open geometry — correctly — while the inspector let
//    you pick Outside and then showed Outside as the current value. The setting was
//    stored, displayed, and ignored.
//
// One module, used by Canvas2D, WebGPU and the inspector, so the three cannot
// disagree about the same shape.

import { nodeOutline } from './shapes'
import type { SceneNode } from './types'

export interface PaintBox {
  x: number
  y: number
  w: number
  h: number
}

/** The node's own box: what a fill covers. */
export function fillPaintBox(node: SceneNode): PaintBox {
  return { x: 0, y: 0, w: node.width, h: node.height }
}

/**
 * The box a stroke covers: the node's box, grown by the stroke on any axis that has
 * no extent, and moved by the alignment offset so the box tracks the band that is
 * actually drawn. A 564×0 line keeps its 564 and gains the stroke weight vertically,
 * so a gradient across the stroke runs across the visible band — and if that band
 * has been pushed to one side by "Inside"/"Outside", the gradient goes with it.
 */
export function strokePaintBox(node: SceneNode): PaintBox {
  const weight = node.strokeWeight
  const offset = openStrokeOffset(node)
  const flatX = node.width <= 0
  const flatY = node.height <= 0
  return {
    x: flatX ? offset - weight / 2 : 0,
    y: flatY ? offset - weight / 2 : 0,
    w: flatX ? weight : node.width,
    h: flatY ? weight : node.height,
  }
}

/** Does any contour of this node enclose an area? */
export function hasClosedGeometry(node: SceneNode): boolean {
  if (node.type === 'LINE') return false
  if (node.type === 'VECTOR') return nodeOutline(node).some((sp) => sp.closed)
  return true
}

/**
 * How far off the path an open stroke sits, in the node's own units.
 *
 * Alignment on an open path is not meaningless — it decides which SIDE of the path
 * the band occupies, and a design tool is expected to offer it (this was briefly
 * disabled instead, which was the wrong call: a line with the stroke pushed to one
 * side is an ordinary thing to want). There is no "inside" of a segment, so the
 * side is a convention: INSIDE is the side of decreasing local y — above a
 * horizontal line — and OUTSIDE the other. Both renderers and `strokePaintBox` read
 * this one function, so the band, its gradient and the GPU mesh cannot disagree.
 *
 * Only LINE, deliberately. Offsetting an arbitrary open path means offsetting each
 * point along its own normal, which is a curve-offsetting problem (self-intersections,
 * cusps) and not a translation; for those the stroke stays centred and the inspector
 * says so rather than pretending. A LINE is a straight segment along its local
 * x-axis, where the offset IS a translation and therefore exact.
 */
export function openStrokeOffset(node: SceneNode): number {
  if (node.type !== 'LINE') return 0
  if (node.strokeAlign === 'INSIDE') return -node.strokeWeight / 2
  if (node.strokeAlign === 'OUTSIDE') return node.strokeWeight / 2
  return 0
}

/** Map a paint's unit coordinate into a box. The one arithmetic both renderers use. */
export function paintPoint(box: PaintBox, p: { x: number; y: number }): { x: number; y: number } {
  return { x: box.x + p.x * box.w, y: box.y + p.y * box.h }
}

/**
 * Can this node's stroke sit anywhere but the centre of its path?
 *
 * Closed geometry: yes, by clipping to the fill region. A LINE: yes, by offsetting
 * the band (see `openStrokeOffset`). An OPEN VECTOR path: no — offsetting a curve is
 * not a translation and we do not do it, so the control is disabled there instead of
 * storing a value the renderer discards.
 */
export function strokeAlignApplies(node: SceneNode): boolean {
  if (node.type === 'LINE') return true
  if (node.type === 'VECTOR') return hasClosedGeometry(node)
  return true
}

// ---------------------------------------------------------------------------
// Gradient direction
// ---------------------------------------------------------------------------

/**
 * A gradient's direction, in degrees, as it appears ON SCREEN: 0° runs left→right,
 * 90° top→bottom (this coordinate system has y downwards).
 *
 * Computed through the paint box rather than from the unit coordinates directly,
 * because unit space is not square: `start (0,0) → end (1,1)` is 45° only on a
 * square box, and reporting 45° for a 600×40 band would be a number that matches no
 * pixel on screen.
 */
export function gradientAngle(paint: { start: { x: number; y: number }; end: { x: number; y: number } }, box: PaintBox): number {
  const from = paintPoint(box, paint.start)
  const to = paintPoint(box, paint.end)
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI
  // −0 reads badly in an input, and 360 is 0.
  return deg === 0 ? 0 : deg
}

/**
 * The same gradient turned to `degrees`, keeping its centre.
 *
 * The ramp's length is the box's extent projected onto the new direction
 * (|cos|·w + |sin|·h) — the rule CSS uses for `linear-gradient`. That is what makes
 * a rotation feel like turning a dial rather than rescaling: the ramp still spans
 * the shape at 45° instead of finishing inside it and leaving flat corners.
 */
export function withGradientAngle<T extends { start: { x: number; y: number }; end: { x: number; y: number } }>(
  paint: T,
  box: PaintBox,
  degrees: number,
): T {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const half = (Math.abs(cos) * box.w + Math.abs(sin) * box.h) / 2
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  // Rounded, because cos(90°) is 6.1e-17 rather than 0 and a document should not
  // carry that: it shows up in the file, in an input, and in every diff.
  // `+ 0` collapses -0, which is a real value in JS and compares unequal under
  // Object.is — including in a test, and in any equality check on a document.
  const snap = (v: number) => Math.round(v * 1e6) / 1e6 + 0
  const toUnit = (px: number, py: number) => ({
    x: snap(box.w === 0 ? 0.5 : (px - box.x) / box.w),
    y: snap(box.h === 0 ? 0.5 : (py - box.y) / box.h),
  })
  return {
    ...paint,
    start: toUnit(cx - cos * half, cy - sin * half),
    end: toUnit(cx + cos * half, cy + sin * half),
  }
}
