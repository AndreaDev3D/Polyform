// Rings: one closed outline of a vector network, expressed so it can be walked.
//
// The network stores a bag of edges with no direction and no order. Every tool
// that reasons about an outline as a SHAPE — where it crosses something, which
// side of it a point is on, how to rebuild it after a change — needs it as an
// ordered ring instead, with each segment pointing the way you are travelling.
// That conversion is fiddly enough to be worth having once (an edge stored
// against the walk has to have its control points swapped, and forgetting that
// silently mangles curves), so the knife and dissolve share it.

import { distToSegment, flattenCubic } from './geometry'
import type { NetworkPart } from './vector-parts'
import type { Vec2, VectorNetwork } from './types'

/** One segment of a loop, always in walk order. */
export interface Step {
  p0: Vec2
  p1: Vec2
  c0: Vec2 | null
  c1: Vec2 | null
}

/** Anything shorter than this is a rounding artefact, not a segment. */
export const EPS = 1e-7

export function lerp(p: Vec2, q: Vec2, t: number): Vec2 {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
}

export function stepLength(s: Step): number {
  return Math.hypot(s.p1.x - s.p0.x, s.p1.y - s.p0.y)
}

/** Split one step at t, both halves lying exactly on the original. */
export function splitStep(s: Step, t: number): [Step, Step] {
  if (!s.c0 && !s.c1) {
    const m = lerp(s.p0, s.p1, t)
    return [
      { p0: s.p0, p1: m, c0: null, c1: null },
      { p0: m, p1: s.p1, c0: null, c1: null },
    ]
  }
  const c0 = s.c0 ?? s.p0
  const c1 = s.c1 ?? s.p1
  const q0 = lerp(s.p0, c0, t)
  const q1 = lerp(c0, c1, t)
  const q2 = lerp(c1, s.p1, t)
  const r0 = lerp(q0, q1, t)
  const r1 = lerp(q1, q2, t)
  const mid = lerp(r0, r1, t)
  return [
    { p0: s.p0, p1: mid, c0: q0, c1: r0 },
    { p0: mid, p1: s.p1, c0: r1, c1: q2 },
  ]
}

/** The loop as an ordered ring of steps, or null if it is not one clean ring. */
export function cycleSteps(net: VectorNetwork, part: NetworkPart): Step[] | null {
  const at = new Map(net.vertices.map((v) => [v.id, v]))
  const incident = new Map<number, number[]>()
  for (const ei of part.edges) {
    const e = net.edges[ei]
    if (!incident.has(e.v0)) incident.set(e.v0, [])
    if (!incident.has(e.v1)) incident.set(e.v1, [])
    incident.get(e.v0)!.push(ei)
    incident.get(e.v1)!.push(ei)
  }
  const start = part.vertices[0]
  const steps: Step[] = []
  let cur = start
  let cameFrom = -1
  for (let guard = 0; guard <= part.edges.length; guard++) {
    const ei = (incident.get(cur) ?? []).find((i) => i !== cameFrom)
    if (ei === undefined) return null
    const e = net.edges[ei]
    const to = e.v0 === cur ? e.v1 : e.v0
    const a = at.get(cur)
    const b = at.get(to)
    if (!a || !b) return null
    // A stored edge may run against the walk, and then its control points swap:
    // cp0 belongs to v0, which is the END of this step, not its start.
    const forward = e.v0 === cur
    steps.push({
      p0: { x: a.x, y: a.y },
      p1: { x: b.x, y: b.y },
      c0: forward ? (e.cp0 ? { ...e.cp0 } : null) : e.cp1 ? { ...e.cp1 } : null,
      c1: forward ? (e.cp1 ? { ...e.cp1 } : null) : e.cp0 ? { ...e.cp0 } : null,
    })
    cameFrom = ei
    cur = to
    if (cur === start) break
  }
  return steps.length === part.edges.length ? steps : null
}


/** A ring flattened to a polyline, for point-in-shape and crossing tests. */
export function ringPolyline(steps: readonly Step[], tolerance = 0.05): Vec2[] {
  const out: Vec2[] = []
  for (const s of steps) {
    out.push(s.p0)
    if (s.c0 || s.c1) out.push(...flattenCubic(s.p0, s.c0 ?? s.p0, s.c1 ?? s.p1, s.p1, tolerance))
  }
  return out
}

/**
 * Is a point inside a ring? Even-odd ray cast along +x.
 *
 * Even-odd rather than winding because the ring's direction is whatever the
 * edges happened to be stored in — nothing in the editor normalises it, so a
 * winding test would call the same shape inside or outside depending on which
 * way somebody happened to draw it.
 */
export function pointInRing(pts: readonly Vec2[], p: Vec2): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]
    const b = pts[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * Is a point sitting ON a ring rather than either side of it?
 *
 * Two outlines that share a stretch of boundary — two rectangles butted along
 * an edge, which is what you get the moment anything is drawn to a grid — have
 * arcs that are neither inside nor outside each other, and a plain in/out test
 * answers those by coin flip. They need naming so exactly one copy can be kept.
 */
export function pointOnRing(pts: readonly Vec2[], p: Vec2, tol = 1e-6): boolean {
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (distToSegment(p, pts[j], pts[i]) <= tol) return true
  }
  return false
}

/** The point half way along a step, for asking which side of something it is on. */
export function stepMidpoint(s: Step): Vec2 {
  if (!s.c0 && !s.c1) return lerp(s.p0, s.p1, 0.5)
  const c0 = s.c0 ?? s.p0
  const c1 = s.c1 ?? s.p1
  const q0 = lerp(s.p0, c0, 0.5)
  const q1 = lerp(c0, c1, 0.5)
  const q2 = lerp(c1, s.p1, 0.5)
  return lerp(lerp(q0, q1, 0.5), lerp(q1, q2, 0.5), 0.5)
}

/** Append a closed loop of steps to the network as fresh vertices and edges. */
export function emitLoop(net: VectorNetwork, steps: readonly Step[]): void {
  if (steps.length < 2) return
  let vid = Math.max(0, ...net.vertices.map((v) => v.id))
  let eid = Math.max(0, ...net.edges.map((e) => e.id))
  const ids = steps.map((s) => {
    vid += 1
    net.vertices.push({ id: vid, x: s.p0.x, y: s.p0.y })
    return vid
  })
  steps.forEach((s, i) => {
    eid += 1
    net.edges.push({ id: eid, v0: ids[i], v1: ids[(i + 1) % steps.length], cp0: s.c0, cp1: s.c1 })
  })
}

/** Remove every vertex and edge of one part. */
export function dropPart(net: VectorNetwork, part: NetworkPart): void {
  const goneVerts = new Set(part.vertices)
  const goneEdges = new Set(part.edges)
  net.edges = net.edges.filter((_, i) => !goneEdges.has(i))
  net.vertices = net.vertices.filter((v) => !goneVerts.has(v.id))
}
