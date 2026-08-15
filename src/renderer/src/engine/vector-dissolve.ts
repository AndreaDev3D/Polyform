// Dissolve: two parts of one shape that overlap become one outline.
//
// The inverse of the knife, and built the same way and for the same reason. A
// boolean union would be one call to the Rust core, but that binding hands back
// polygons, so dissolving two curvy blobs would straighten every curve in both
// of them — including all the ones nowhere near the overlap. So the union is
// walked instead: split both rings where they cross, throw away the arcs that
// fall INSIDE the other ring, and chain what is left. Every surviving arc is a
// piece of the original curve, untouched.

import {
  EPS,
  cycleSteps,
  dropPart,
  emitLoop,
  pointInRing,
  pointOnRing,
  ringPolyline,
  splitStep,
  stepLength,
  stepMidpoint,
  type Step,
} from './vector-rings'
import { networkParts, type NetworkPart } from './vector-parts'
import { weldLooseEnds } from './vector-connect'
import type { Vec2, VectorNetwork } from './types'

/** Endpoints closer than this are the same point. */
const WELD = 1e-6

function near(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4
}

/** Fractional positions (step + t) where two rings cross. */
function crossPositions(a: readonly Step[], b: readonly Step[]): { onA: number[]; onB: number[] } {
  const onA: number[] = []
  const onB: number[] = []
  const spansOf = (s: Step): Vec2[] => {
    if (!s.c0 && !s.c1) return [s.p0, s.p1]
    const out = [s.p0]
    const steps = 24
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const u = 1 - t
      const c0 = s.c0 ?? s.p0
      const c1 = s.c1 ?? s.p1
      out.push({
        x: u * u * u * s.p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * s.p1.x,
        y: u * u * u * s.p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * s.p1.y,
      })
    }
    return out
  }
  const sa = a.map(spansOf)
  const sb = b.map(spansOf)
  for (let ai = 0; ai < sa.length; ai++) {
    for (let i = 0; i < sa[ai].length - 1; i++) {
      const p = sa[ai][i]
      const r = { x: sa[ai][i + 1].x - p.x, y: sa[ai][i + 1].y - p.y }
      for (let bi = 0; bi < sb.length; bi++) {
        for (let j = 0; j < sb[bi].length - 1; j++) {
          const q = sb[bi][j]
          const d = { x: sb[bi][j + 1].x - q.x, y: sb[bi][j + 1].y - q.y }
          const denom = r.x * d.y - r.y * d.x
          if (Math.abs(denom) < 1e-12) continue
          const u = ((q.x - p.x) * d.y - (q.y - p.y) * d.x) / denom
          const v = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / denom
          if (u < 0 || u > 1 || v < 0 || v > 1) continue
          onA.push(ai + (i + u) / (sa[ai].length - 1))
          onB.push(bi + (j + v) / (sb[bi].length - 1))
        }
      }
    }
  }
  return { onA, onB }
}

/** Cut a ring at each position, returning the arcs between them, in order. */
function arcsAt(steps: readonly Step[], positions: readonly number[]): Step[][] {
  const cuts = [...new Set(positions.map((p) => Math.round(p * 1e6) / 1e6))].sort((x, y) => x - y)
  if (cuts.length < 2) return []
  const arcs: Step[][] = []
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i]
    const to = i + 1 < cuts.length ? cuts[i + 1] : cuts[0] + steps.length
    const arc = sliceRing(steps, from, to)
    if (arc.length > 0) arcs.push(arc)
  }
  return arcs
}

/** The stretch of ring between two fractional positions, walking forward. */
function sliceRing(steps: readonly Step[], from: number, to: number): Step[] {
  const n = steps.length
  const out: Step[] = []
  let cursor = from
  while (cursor < to - 1e-12) {
    const base = Math.floor(cursor)
    const idx = ((base % n) + n) % n
    const head = cursor - base
    const piece = Math.min(base + 1, to)
    const tail = piece - base
    let s = steps[idx]
    if (head > EPS) s = splitStep(s, head)[1]
    if (tail < 1 - EPS) {
      const t = head > EPS ? (tail - head) / (1 - head) : tail
      s = splitStep(s, Math.min(1, Math.max(0, t)))[0]
    }
    if (stepLength(s) > WELD || s.c0 || s.c1) out.push(s)
    cursor = piece
  }
  return out
}

/**
 * Chain arcs end to end into one closed ring.
 *
 * At every crossing exactly two surviving arcs meet — one arriving, one leaving
 * — so there is never a choice to make. If the chain runs out before it closes,
 * the geometry was not something this can describe as a single outline and the
 * caller is told rather than handed a broken shape.
 */
function chain(arcs: Step[][]): Step[] | null {
  if (arcs.length === 0) return null
  const pool = arcs.map((a) => ({ steps: a, used: false }))
  pool[0].used = true
  const ring = [...pool[0].steps]
  const start = ring[0].p0
  for (let guard = 0; guard < pool.length + 1; guard++) {
    const tail = ring[ring.length - 1].p1
    if (near(tail, start)) return ring
    const next = pool.find((a) => !a.used && near(a.steps[0].p0, tail))
    if (!next) return null
    next.used = true
    ring.push(...next.steps)
  }
  return near(ring[ring.length - 1].p1, start) ? ring : null
}

/** The union of two overlapping rings, or null if they do not overlap. */
function unionRings(a: readonly Step[], b: readonly Step[]): Step[] | null {
  const { onA, onB } = crossPositions(a, b)
  if (onA.length < 2) return null
  const polyA = ringPolyline(a)
  const polyB = ringPolyline(b)
  // Everything OUTSIDE the other ring is boundary; everything inside is the
  // seam being dissolved away.
  //
  // The third case is the one that bites: an arc lying ALONG the other outline,
  // which is what two shapes butted or snapped to the same grid line give you.
  // It is neither inside nor outside, it is part of the union's boundary, and
  // BOTH rings have a copy of it. Dropping both leaves a gap the walk cannot
  // close; keeping both traces the same stretch twice. So keep A's copy and
  // drop B's — which of the two is arbitrary, being the same geometry, but
  // picking one has to be deliberate.
  const midOf = (arc: Step[]): Vec2 => stepMidpoint(arc[Math.floor(arc.length / 2)])
  const keep = [
    ...arcsAt(a, onA).filter((arc) => !pointInRing(polyB, midOf(arc)) || pointOnRing(polyB, midOf(arc), 1e-4)),
    ...arcsAt(b, onB).filter((arc) => !pointInRing(polyA, midOf(arc)) && !pointOnRing(polyA, midOf(arc), 1e-4)),
  ]
  return chain(keep)
}

/**
 * Dissolve the segments BETWEEN the selected points: take the seam out and let
 * what was either side of it become one outline.
 *
 * This is the operation people mean by dissolve, and the one this module did
 * not have. Merging *overlapping* parts (below) only ever fires when two
 * outlines cross; two halves that share a seam do not cross, they touch — so
 * asking to dissolve them reported "those parts do not overlap", which is true
 * and is not what anybody wanted to hear while looking at a line down the
 * middle of their shape.
 *
 * Only edges with BOTH ends selected go. That is what makes the gesture safe to
 * aim: you select the seam's endpoints, and nothing outside the seam can be
 * caught by it.
 *
 * Afterwards the loose ends are welded, because a seam is usually two edges —
 * one belonging to each half — and removing them leaves two open chains whose
 * ends sit on top of each other. Without the weld you would have taken the line
 * away and still have two parts.
 */
export function dissolveEdges(net: VectorNetwork, vids: readonly number[], weldWithin: number): string | null {
  const sel = new Set(vids)
  if (sel.size < 2) return 'Select the points at both ends of the segments to dissolve'
  const doomed = net.edges.filter((e) => sel.has(e.v0) && sel.has(e.v1))
  if (doomed.length === 0) return 'No segment runs between the selected points'
  net.edges = net.edges.filter((e) => !(sel.has(e.v0) && sel.has(e.v1)))
  // A point that was only holding up the seam goes with it.
  const used = new Set<number>()
  for (const e of net.edges) {
    used.add(e.v0)
    used.add(e.v1)
  }
  net.vertices = net.vertices.filter((v) => used.has(v.id))
  weldLooseEnds(net, weldWithin)
  return null
}

/**
 * Merge overlapping parts of one shape into single outlines.
 *
 * Repeats until nothing overlaps, so three parts in a row dissolve to one. A
 * part wholly inside another is swallowed by it — that is the same request,
 * just without any crossings to walk.
 *
 * Returns null on success, or why it declined. Mutates `net`.
 */
export function dissolveParts(net: VectorNetwork): string | null {
  let merged = 0
  for (let round = 0; round < 32; round++) {
    const parts = networkParts(net).filter((p) => p.closed)
    if (parts.length < 2) break
    const pair = findOverlap(net, parts)
    if (!pair) break
    const { left, right, ring } = pair
    // Highest first, so removing one does not shift the other's edge indices.
    const [first, second] = left.edges[0] > right.edges[0] ? [left, right] : [right, left]
    dropPart(net, first)
    dropPart(net, second)
    emitLoop(net, ring)
    merged++
  }
  if (merged > 0) return null
  const closed = networkParts(net).filter((p) => p.closed)
  if (closed.length < 2) return 'Dissolve needs two closed parts of the same shape'
  return 'Those parts do not overlap. If they share a seam, select the points at its ends and dissolve those'
}

/** The first pair of parts that overlap, with the outline that replaces them. */
function findOverlap(
  net: VectorNetwork,
  parts: readonly NetworkPart[],
): { left: NetworkPart; right: NetworkPart; ring: Step[] } | null {
  for (let i = 0; i < parts.length; i++) {
    const a = cycleSteps(net, parts[i])
    if (!a) continue
    for (let j = i + 1; j < parts.length; j++) {
      const b = cycleSteps(net, parts[j])
      if (!b) continue
      const ring = unionRings(a, b)
      if (ring) return { left: parts[i], right: parts[j], ring }
      // No crossings: one may still be wholly inside the other, which is the
      // same request with nothing to walk — the outer one IS the union.
      const polyA = ringPolyline(a)
      const polyB = ringPolyline(b)
      if (pointInRing(polyB, a[0].p0)) return { left: parts[i], right: parts[j], ring: [...b] }
      if (pointInRing(polyA, b[0].p0)) return { left: parts[i], right: parts[j], ring: [...a] }
    }
  }
  return null
}
