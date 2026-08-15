// The knife: cut a closed outline with a straight line and get two closed
// outlines.
//
// Not a boolean. A boolean would be easier — the Rust core already does exact
// bezier CSG, and intersecting the shape with each half-plane of the cut would
// handle every case for free — but it returns POLYGONS, so a knife built that
// way would quietly replace every curve it did not touch with a polyline. A
// knife has to leave the rest of the shape exactly as it found it, so the cut is
// topological: split the two edges the line crosses (De Casteljau, so both
// halves lie on the original curve), then rebuild the loop as two loops with the
// chord closing each one.
//
// The two halves are DETACHED parts of the same node, not two nodes. That is
// what makes the rest of this set compose: Paint can then colour each half,
// Bridge can reconnect them, Dissolve can merge them back.

import { flattenCubic } from './geometry'
import { networkParts, type NetworkPart } from './vector-parts'
import { EPS, cycleSteps, dropPart, emitLoop, splitStep, stepLength, type Step } from './vector-rings'
import type { Vec2, VectorNetwork } from './types'

/**
 * Where the cut crosses the ring, as a fractional position around it
 * (`step + t`) and how far along the cut it is.
 */
interface Crossing {
  around: number
  along: number
}

function ringCrossings(steps: Step[], a: Vec2, b: Vec2): Crossing[] {
  const d = { x: b.x - a.x, y: b.y - a.y }
  const out: Crossing[] = []
  steps.forEach((s, si) => {
    const samples: Vec2[] =
      s.c0 || s.c1 ? [s.p0, ...flattenCubic(s.p0, s.c0 ?? s.p0, s.c1 ?? s.p1, s.p1, 0.05)] : [s.p0, s.p1]
    const spans = samples.length - 1
    for (let i = 0; i < spans; i++) {
      const p = samples[i]
      const r = { x: samples[i + 1].x - p.x, y: samples[i + 1].y - p.y }
      const denom = r.x * d.y - r.y * d.x
      if (Math.abs(denom) < 1e-12) continue // parallel, including a cut lying along the edge
      const ax = a.x - p.x
      const ay = a.y - p.y
      const u = (ax * d.y - ay * d.x) / denom
      const along = (ax * r.y - ay * r.x) / denom
      if (u < 0 || u > 1 || along < 0 || along > 1) continue
      // flattenCubic samples at uniform t, so the span index IS the parameter.
      out.push({ around: si + (i + u) / spans, along })
    }
  })
  // A cut through an anchor registers on both edges that meet there. Keeping
  // both would ask for a zero-length piece of outline.
  out.sort((x, y) => x.along - y.along)
  return out.filter((c, i) => i === 0 || Math.abs(c.along - out[i - 1].along) > 1e-6)
}

/** The stretch of ring from one fractional position to another, walking forward. */
function arcBetween(steps: Step[], from: number, to: number): Step[] {
  const n = steps.length
  const out: Step[] = []
  let cursor = from
  // `to` may be past the end: the second arc wraps through the start of the ring.
  while (cursor < to - 1e-12) {
    const idx = Math.floor(cursor) % n
    const head = cursor - Math.floor(cursor)
    const stepEnd = Math.floor(cursor) + 1
    const piece = Math.min(stepEnd, to)
    const tail = piece - Math.floor(cursor)
    let s = steps[idx]
    if (head > EPS) s = splitStep(s, head)[1]
    if (tail < 1 - EPS) {
      // Re-parameterised: the remaining piece is measured against what is left.
      const t = head > EPS ? (tail - head) / (1 - head) : tail
      s = splitStep(s, Math.min(1, Math.max(0, t)))[0]
    }
    if (stepLength(s) > EPS || s.c0 || s.c1) out.push(s)
    cursor = piece
  }
  return out
}

/**
 * Cut every closed part the line crosses.
 *
 * One line can cross several detached outlines, and slicing through all of them
 * at once is the useful reading — it is one stroke of a knife, not one per
 * shape. A part the line misses, or only grazes at a single point, is left
 * exactly as it was.
 *
 * Returns null on success, or why it declined. Mutates `net`.
 */
export function knifeCut(net: VectorNetwork, a: Vec2, b: Vec2): string | null {
  if (Math.hypot(b.x - a.x, b.y - a.y) < EPS) return 'The cut has no length'
  const parts = networkParts(net)
  // Collected first, applied after: the splits renumber everything, so a part
  // index read before the first cut means nothing after it.
  const plans: { part: NetworkPart; loops: Step[][] }[] = []
  for (const part of parts) {
    if (!part.closed) continue
    const steps = cycleSteps(net, part)
    if (!steps) continue
    const hits = ringCrossings(steps, a, b)
    if (hits.length < 2) continue
    // The first two along the cut. Crossings alternate in and out of the shape,
    // so the span between them is the one INSIDE it — which is where a knife
    // leaves a cut.
    const [h0, h1] = hits
    const from = Math.min(h0.around, h1.around)
    const to = Math.max(h0.around, h1.around)
    const arc1 = arcBetween(steps, from, to)
    const arc2 = arcBetween(steps, to, from + steps.length)
    if (arc1.length === 0 || arc2.length === 0) continue
    const p0 = arc1[0].p0
    const p1 = arc2[0].p0
    plans.push({
      part,
      loops: [
        [...arc1, { p0: p1, p1: p0, c0: null, c1: null }],
        [...arc2, { p0: p0, p1: p1, c0: null, c1: null }],
      ],
    })
  }
  if (plans.length === 0) return 'The cut has to cross a closed outline in two places'
  // Highest part first, so removing one does not shift the edge indices of the
  // next one still to be removed.
  plans.sort((x, y) => y.part.edges[0] - x.part.edges[0])
  for (const plan of plans) {
    dropPart(net, plan.part)
    for (const loop of plan.loops) emitLoop(net, loop)
  }
  return null
}
