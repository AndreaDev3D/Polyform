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
 * The box a stroke covers, which is the node's box grown by the stroke on any axis
 * that has no extent. Only the degenerate axis is substituted: a 564×0 line keeps
 * its 564 and gains the stroke weight vertically, centred on the path, so a
 * gradient across the stroke runs across the visible band.
 */
export function strokePaintBox(node: SceneNode): PaintBox {
  const weight = node.strokeWeight
  const flatX = node.width <= 0
  const flatY = node.height <= 0
  return {
    x: flatX ? -weight / 2 : 0,
    y: flatY ? -weight / 2 : 0,
    w: flatX ? weight : node.width,
    h: flatY ? weight : node.height,
  }
}

/** Map a paint's unit coordinate into a box. The one arithmetic both renderers use. */
export function paintPoint(box: PaintBox, p: { x: number; y: number }): { x: number; y: number } {
  return { x: box.x + p.x * box.w, y: box.y + p.y * box.h }
}

/**
 * Can this node's stroke sit anywhere but the centre of its path?
 *
 * Only if the geometry encloses something. A LINE never does. A VECTOR does when
 * any of its contours is closed — the same test the renderers make before filling
 * it, so a shape that gets a fill also gets an alignment.
 */
export function strokeAlignApplies(node: SceneNode): boolean {
  if (node.type === 'LINE') return false
  if (node.type === 'VECTOR') return nodeOutline(node).some((sp) => sp.closed)
  return true
}
