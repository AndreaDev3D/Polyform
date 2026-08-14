// Per-side stroke weights: what region does the stroke actually cover?
//
// A uniform stroke is a stroke: hand the outline and a width to the rasterizer
// and it draws a band. Four different widths is not, because there is no single
// width to give — so this file answers the question geometrically instead, as a
// REGION to fill, and all three back ends fill the same region: Canvas2D with
// `fill`, the GPU by tessellating it, SVG export as a `<path>`. A stroke computed
// three times is a stroke that comes out different on the GPU (F-34).
//
// The region is the space between two boxes:
//
//   outer  the shape grown per side by however much of that side's weight falls
//          OUTSIDE the outline (all of it for OUTSIDE, half for CENTER, none for
//          INSIDE)
//   inner  the shape shrunk per side by the part that falls inside
//
// Filled EVEN-ODD, that pair is a ring of varying thickness. The pleasant part is
// what happens at a side set to 0: outer and inner meet along that edge, the ring
// is pinched to nothing there, and the two neighbouring sides mitre into the
// corner on their own. No special case, no seam.

import { uniformSides, type CornerRadius, type SceneNode, type StrokeSides } from './types'
import { strokeSidesApply } from './paintbox'
import { matTranslate } from './geometry'
import { roundedRectPath, transformSubPath, type SubPath } from './shapes'

/**
 * The per-side weights this node actually draws with, or null when it draws a
 * plain uniform stroke — which is most nodes, so callers can keep their fast
 * path. Null also for a node that cannot carry sides at all, and for sides that
 * happen to all be equal: four 2s and `strokeWeight: 2` are the same stroke, and
 * the rasterizer's own band is better than a region we tessellate ourselves.
 */
export function perSideStroke(node: SceneNode): StrokeSides | null {
  if (!strokeSidesApply(node)) return null
  const s = (node as { strokeSides?: StrokeSides }).strokeSides
  if (!s) return null
  const sides = {
    top: Math.max(0, s.top),
    right: Math.max(0, s.right),
    bottom: Math.max(0, s.bottom),
    left: Math.max(0, s.left),
  }
  if (sides.top === sides.right && sides.right === sides.bottom && sides.bottom === sides.left) {
    // All equal: only per-side if it disagrees with strokeWeight, in which case
    // the sides win — they are the more specific statement.
    return sides.top === node.strokeWeight ? null : sides
  }
  return sides
}

/** How much of each side's weight falls outside the outline, and how much inside. */
function split(node: SceneNode, sides: StrokeSides): { out: StrokeSides; in: StrokeSides } {
  const f = node.strokeAlign === 'OUTSIDE' ? 1 : node.strokeAlign === 'CENTER' ? 0.5 : 0
  const g = 1 - f
  return {
    out: { top: sides.top * f, right: sides.right * f, bottom: sides.bottom * f, left: sides.left * f },
    in: { top: sides.top * g, right: sides.right * g, bottom: sides.bottom * g, left: sides.left * g },
  }
}

const box = (x: number, y: number, w: number, h: number, r: CornerRadius): SubPath =>
  transformSubPath(roundedRectPath(w, h, r), matTranslate(x, y))

/**
 * The region a per-side stroke covers, in node-local space. **Fill it EVEN-ODD**
 * — the two contours are a ring, and nonzero would only give the same answer by
 * luck of their winding.
 *
 * Corner radii travel with the offsets: the outer corner grows by the smaller of
 * its two adjoining outward offsets (the larger would bulge the ring past the
 * side that has no stroke) and the inner corner shrinks by the larger of its two
 * inward ones, floored at 0.
 */
export function strokeSideOutline(node: SceneNode): SubPath[] {
  const sides = perSideStroke(node)
  if (!sides) return []
  if (sides.top <= 0 && sides.right <= 0 && sides.bottom <= 0 && sides.left <= 0) return []
  const { out, in: inn } = split(node, sides)
  const r = (node as { cornerRadius?: CornerRadius }).cornerRadius ?? { tl: 0, tr: 0, br: 0, bl: 0 }

  const ox = -out.left
  const oy = -out.top
  const ow = node.width + out.left + out.right
  const oh = node.height + out.top + out.bottom
  const outer = box(ox, oy, ow, oh, {
    tl: r.tl + Math.min(out.top, out.left),
    tr: r.tr + Math.min(out.top, out.right),
    br: r.br + Math.min(out.bottom, out.right),
    bl: r.bl + Math.min(out.bottom, out.left),
  })

  const iw = node.width - inn.left - inn.right
  const ih = node.height - inn.top - inn.bottom
  // The inward offsets can eat the whole shape — a 40px stroke on a 20px box.
  // Then there is no hole and the region is solid, which is what the rasterizer
  // does with an over-wide inside stroke too.
  if (iw <= 0 || ih <= 0) return [outer]
  const inner = box(inn.left, inn.top, iw, ih, {
    tl: Math.max(0, r.tl - Math.max(inn.top, inn.left)),
    tr: Math.max(0, r.tr - Math.max(inn.top, inn.right)),
    br: Math.max(0, r.br - Math.max(inn.bottom, inn.right)),
    bl: Math.max(0, r.bl - Math.max(inn.bottom, inn.left)),
  })
  return [outer, inner]
}

/**
 * Is this node's per-side stroke the exact box region above, or wedge-clipped
 * bands? A box knows where its four edges are and can be offset per side. Any
 * other closed shape cannot, so its sides are the four WEDGES of its bounding box
 * — the triangles cut by the box's diagonals — and each one clips an ordinary
 * stroke drawn at that side's weight.
 *
 * The wedges are not an approximation of the box case, they ARE it: for a
 * rectangle the diagonals meet each corner exactly where the mitre falls.
 */
export function usesSideRegion(node: SceneNode): boolean {
  return (
    node.type === 'RECTANGLE' || node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE'
  )
}

export interface SideBand {
  side: 'top' | 'right' | 'bottom' | 'left'
  weight: number
  /** Node-local clip for this side, already big enough to hold the band. */
  wedge: SubPath
}

const tri = (a: [number, number], b: [number, number], c: [number, number]): SubPath => ({
  closed: true,
  anchors: [a, b, c].map(([x, y]) => ({ p: { x, y }, cpIn: null, cpOut: null })),
})

/**
 * One clip per side with a stroke on it, for a shape that is not a box.
 *
 * Each wedge is scaled about the node's CENTRE rather than padded outward,
 * because scaling about the centre leaves the diagonals where they are — the
 * mitre stays put while the wedge grows past the shape far enough to hold a
 * centred or outside band.
 */
export function strokeSideBands(node: SceneNode): SideBand[] {
  const sides = perSideStroke(node)
  if (!sides) return []
  const w = node.width
  const h = node.height
  if (w <= 0 || h <= 0) return []
  const pad = Math.max(sides.top, sides.right, sides.bottom, sides.left)
  const k = 1 + (4 * pad) / Math.max(1e-3, Math.min(w, h))
  const cx = w / 2
  const cy = h / 2
  const out = (x: number, y: number): [number, number] => [cx + (x - cx) * k, cy + (y - cy) * k]
  const tl = out(0, 0)
  const tr = out(w, 0)
  const br = out(w, h)
  const bl = out(0, h)
  const c: [number, number] = [cx, cy]
  const bands: SideBand[] = [
    { side: 'top', weight: sides.top, wedge: tri(tl, tr, c) },
    { side: 'right', weight: sides.right, wedge: tri(tr, br, c) },
    { side: 'bottom', weight: sides.bottom, wedge: tri(br, bl, c) },
    { side: 'left', weight: sides.left, wedge: tri(bl, tl, c) },
  ]
  return bands.filter((b) => b.weight > 0)
}

/**
 * The widest stroke this node draws anywhere. Every "is there a stroke at all?"
 * gate has to ask this rather than `strokeWeight`: with per-side weights the
 * uniform one can be 0 while three sides are 4px, and a gate reading it would
 * skip the node — visible on the GPU, where the mesh was built and then never
 * drawn.
 */
export function effectiveStrokeWeight(node: SceneNode): number {
  const sides = perSideStroke(node)
  if (!sides) return node.strokeWeight
  return Math.max(sides.top, sides.right, sides.bottom, sides.left)
}

/** Largest distance a per-side stroke reaches outside the shape (for bounds). */
export function strokeSideOutset(node: SceneNode): number {
  const sides = perSideStroke(node)
  if (!sides) return 0
  const { out } = split(node, sides)
  return Math.max(out.top, out.right, out.bottom, out.left)
}

/** Per-side weights for a node that has none yet, seeded from its uniform one. */
export function seedSides(node: SceneNode): StrokeSides {
  return perSideStroke(node) ?? uniformSides(node.strokeWeight)
}
