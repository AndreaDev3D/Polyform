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

export const STROKE_CAPS: StrokeCap[] = [
  'NONE',
  'ROUND',
  'SQUARE',
  'ROUND_SQUARE',
  'ARROW',
  'CIRCLE',
  'DIAMOND',
]

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
      // Reaches BACK half a weight as well as forward, so it overlaps the band
      // instead of meeting it along a line. Two meshes that share an edge each
      // anti-alias against the background, and the background shows through the
      // join as a hairline — which this cap was the only one to suffer, because
      // every other one here already straddles the end (F-43).
      return [polygon([at(-w / 2, w / 2), at(w / 2, w / 2), at(w / 2, -w / 2), at(-w / 2, -w / 2)])]
    case 'ROUND_SQUARE': {
      // A square end with its corners taken off: flatter than ROUND, softer
      // than SQUARE. Only the two FORWARD corners are rounded — the other two
      // are buried in the band, where their shape cannot be seen and rounding
      // them would only remove overlap.
      const r = w / 4
      const k = r * KAPPA_CIRCLE
      return [
        {
          closed: true,
          anchors: [
            { p: at(-w / 2, w / 2), cpIn: null, cpOut: null },
            { p: at(w / 2 - r, w / 2), cpIn: null, cpOut: at(w / 2 - r + k, w / 2) },
            { p: at(w / 2, w / 2 - r), cpIn: at(w / 2, w / 2 - r + k), cpOut: at(w / 2, -w / 2 + r - k) },
            { p: at(w / 2, -w / 2 + r), cpIn: null, cpOut: at(w / 2 - r + k, -w / 2) },
            { p: at(w / 2 - r, -w / 2), cpIn: at(w / 2 - r + k, -w / 2), cpOut: null },
            { p: at(-w / 2, -w / 2), cpIn: null, cpOut: null },
          ],
        },
      ]
    }
    case 'CIRCLE':
      // Deliberately wider than the stroke: a dot you can see, for marking an
      // endpoint rather than finishing it.
      return [circle(p, w)]
    case 'DIAMOND':
      return [polygon([at(w, 0), at(0, w), at(-w, 0), at(0, -w)])]
    case 'ARROW': {
      // The head sits AHEAD of the path's end, with its NOTCH on it.
      //
      // It was built the other way first — tip on the end, head growing
      // backwards — on the reasoning that a cap should not make a line longer.
      // Drawn, that is wrong: the point lands inside the stroke it terminates,
      // so the arrow reads as a lump on the end of a bar rather than as
      // something pointing. Putting the notch on the end makes the two meet
      // flush, because the concave back is exactly the shape a butt end plugs,
      // and leaves the point out in front where it is looked for.
      //
      // The other pointed caps already did this — CIRCLE and DIAMOND both
      // straddle the end — so the arrow was the odd one out as well as wrong.
      const nose = 1.8 * w
      const back = -0.8 * w
      return [polygon([at(nose, 0), at(back, 1.35 * w), at(0, 0), at(back, -1.35 * w)])]
    }
  }
}

/**
 * How far a cap can reach from the end it sits on.
 *
 * Measured from the shape rather than written down beside it, so redrawing a
 * cap moves its allowance with it. The bounds are what selection, zoom-to-fit,
 * culling and export all trust — and they used to be the stroke's half-width,
 * which every cap here exceeds. An exported line with arrowheads came out as a
 * plain bar, cropped at the box, with nothing to say it had happened (F-42).
 */
export function capOutset(kind: StrokeCap, weight: number): number {
  let far = 0
  for (const sp of capShape(kind, { at: { x: 0, y: 0 }, dir: { x: 1, y: 0 } }, weight)) {
    for (const a of sp.anchors) {
      for (const q of [a.p, a.cpIn, a.cpOut]) {
        if (q) far = Math.max(far, Math.hypot(q.x, q.y))
      }
    }
  }
  return far
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
