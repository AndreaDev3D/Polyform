// What the ends of an open stroke look like.
//
// Every cap here is FILLED GEOMETRY rather than a rasterizer setting, and that
// is the whole design. CSS and Canvas2D offer `lineCap`, but it applies to both
// ends of every subpath at once — so the moment start and end can differ, the
// setting cannot express it. Building the caps as shapes costs a little more
// and buys three things: the two ends are independent, arrowheads become
// possible at all, and all three back ends draw the same thing because they are
// all just filling a subpath.
//
// The caps are drawn in the STROKE's paint, because that is what they are: the
// end of the stroke, not a second object.

import { KAPPA_CIRCLE, type Anchor, type SubPath } from './shapes'
import { hasClosedGeometry } from './paintbox'
import type { SceneNode, StrokeCap, Vec2 } from './types'

export const STROKE_CAPS: StrokeCap[] = ['NONE', 'ROUND', 'SQUARE', 'ARROW', 'CIRCLE', 'DIAMOND']

/** One end of an open run: where it is, and which way it points OUT of the path. */
export interface CapEnd {
  at: Vec2
  /** Unit vector along the path, pointing away from it. */
  dir: Vec2
}

/**
 * Whether caps mean anything on this node.
 *
 * A closed outline has no ends, so offering the control there would be a
 * setting that reads back and does nothing — and a stroke of zero width has
 * nothing to cap.
 */
export function strokeCapsApply(node: SceneNode): boolean {
  if (node.type === 'TEXT' || node.type === 'GROUP' || node.type === 'MODEL3D') return false
  if (node.strokeWeight <= 0) return false
  return !hasClosedGeometry(node)
}

function norm(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y)
  return len < 1e-9 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len }
}

/** Every open run's two ends, with the direction the path leaves at. */
export function openEnds(outline: readonly SubPath[]): { start: CapEnd; end: CapEnd }[] {
  const out: { start: CapEnd; end: CapEnd }[] = []
  for (const sp of outline) {
    if (sp.closed || sp.anchors.length < 2) continue
    const a = sp.anchors
    const n = a.length
    // Taken from the CONTROL points where there are any: a curve that leaves
    // its first anchor heading north has an arrowhead pointing north, and using
    // the chord to the next anchor instead would aim it somewhere the path
    // never goes.
    const startToward = a[0].cpOut ?? a[1].cpIn ?? a[1].p
    const endFrom = a[n - 1].cpIn ?? a[n - 2].cpOut ?? a[n - 2].p
    out.push({
      start: { at: a[0].p, dir: norm({ x: a[0].p.x - startToward.x, y: a[0].p.y - startToward.y }) },
      end: { at: a[n - 1].p, dir: norm({ x: a[n - 1].p.x - endFrom.x, y: a[n - 1].p.y - endFrom.y }) },
    })
  }
  return out
}

function anchor(p: Vec2): Anchor {
  return { p, cpIn: null, cpOut: null }
}

function polygon(points: Vec2[]): SubPath {
  return { closed: true, anchors: points.map(anchor) }
}

/** A circle as four cubics, so it stays round at any zoom. */
function circle(c: Vec2, r: number): SubPath {
  const k = r * KAPPA_CIRCLE
  const pts: Vec2[] = [
    { x: c.x, y: c.y - r },
    { x: c.x + r, y: c.y },
    { x: c.x, y: c.y + r },
    { x: c.x - r, y: c.y },
  ]
  const outs: Vec2[] = [
    { x: c.x + k, y: c.y - r },
    { x: c.x + r, y: c.y + k },
    { x: c.x - k, y: c.y + r },
    { x: c.x - r, y: c.y - k },
  ]
  const ins: Vec2[] = [
    { x: c.x - k, y: c.y - r },
    { x: c.x + r, y: c.y - k },
    { x: c.x + k, y: c.y + r },
    { x: c.x - r, y: c.y + k },
  ]
  return {
    closed: true,
    anchors: pts.map((p, i) => ({ p, cpOut: outs[i], cpIn: ins[i] })),
  }
}

/**
 * One cap, as filled subpaths in the node's own space.
 *
 * Sizes are all multiples of the stroke weight, so a cap stays in proportion
 * when the weight changes — an arrowhead that kept its size while its line got
 * thicker would end up narrower than the line it terminates.
 */
export function capShape(kind: StrokeCap, end: CapEnd, weight: number): SubPath[] {
  if (kind === 'NONE' || weight <= 0) return []
  const w = weight
  const t = end.dir
  const n = { x: -t.y, y: t.x }
  const p = end.at
  const at = (along: number, across: number): Vec2 => ({
    x: p.x + t.x * along + n.x * across,
    y: p.y + t.y * along + n.y * across,
  })
  switch (kind) {
    case 'ROUND':
      // Exactly what a round lineCap would have drawn, as a shape.
      return [circle(p, w / 2)]
    case 'SQUARE':
      return [polygon([at(0, w / 2), at(w / 2, w / 2), at(w / 2, -w / 2), at(0, -w / 2)])]
    case 'CIRCLE':
      // Deliberately wider than the stroke: a dot you can see, for marking an
      // endpoint rather than finishing it.
      return [circle(p, w)]
    case 'DIAMOND':
      return [polygon([at(w, 0), at(0, w), at(-w, 0), at(0, -w)])]
    case 'ARROW':
      // The TIP sits on the path's end, so adding an arrow does not make the
      // line longer — the head grows backwards along it.
      return [polygon([at(0, 0), at(-2.6 * w, 1.35 * w), at(-1.8 * w, 0), at(-2.6 * w, -1.35 * w)])]
  }
}

/** Every cap on a node, ready to fill with the stroke's paint. */
export function strokeCapShapes(node: SceneNode, outline: readonly SubPath[]): SubPath[] {
  if (!strokeCapsApply(node)) return []
  const startKind = node.strokeCapStart ?? 'NONE'
  const endKind = node.strokeCapEnd ?? 'NONE'
  if (startKind === 'NONE' && endKind === 'NONE') return []
  const out: SubPath[] = []
  for (const run of openEnds(outline)) {
    out.push(...capShape(startKind, run.start, node.strokeWeight))
    out.push(...capShape(endKind, run.end, node.strokeWeight))
  }
  return out
}
