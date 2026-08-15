// Vector network editing rules: handle mirroring, bending a segment, and
// removing points or segments.
//
// Kept out of the pointer controller because these are decisions about the
// network, not about the mouse — they are the same whether the gesture came
// from a drag, a keyboard, an agent or a test.

import type { MirrorMode, VectorEdge, VectorNetwork, Vec2 } from './types'

/** Which end of an edge a control point belongs to. */
export type CpKey = 'cp0' | 'cp1'

function vertexOf(edge: VectorEdge, key: CpKey): number {
  return key === 'cp0' ? edge.v0 : edge.v1
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

/**
 * The other handle at the same vertex: the control point of a DIFFERENT edge
 * that also meets there. Returns null for a path end, which has nothing to
 * mirror against.
 */
export function partnerHandle(
  net: VectorNetwork,
  edgeIndex: number,
  key: CpKey,
): { edgeIndex: number; key: CpKey } | null {
  const edge = net.edges[edgeIndex]
  if (!edge) return null
  const vid = vertexOf(edge, key)
  for (let i = 0; i < net.edges.length; i++) {
    if (i === edgeIndex) continue
    const other = net.edges[i]
    if (other.v0 === vid) return { edgeIndex: i, key: 'cp0' }
    if (other.v1 === vid) return { edgeIndex: i, key: 'cp1' }
  }
  return null
}

/**
 * Point the partner handle the opposite way after one handle moved.
 *
 * ANGLE keeps the partner's own length and only takes the direction, which is
 * what you want when one side of a curve should stay tighter than the other.
 * ANGLE_LENGTH reflects it exactly, so the two arms stay equal.
 *
 * A partner that does not exist yet is created: choosing to mirror a corner is
 * a request for a smooth point, and a smooth point needs two arms.
 */
export function applyMirror(net: VectorNetwork, edgeIndex: number, key: CpKey): void {
  const edge = net.edges[edgeIndex]
  if (!edge) return
  const moved = edge[key]
  if (!moved) return
  const vid = vertexOf(edge, key)
  const vertex = net.vertices.find((v) => v.id === vid)
  const mode: MirrorMode = vertex?.mirror ?? 'NONE'
  if (!vertex || mode === 'NONE') return

  const partner = partnerHandle(net, edgeIndex, key)
  if (!partner) return
  const other = net.edges[partner.edgeIndex]
  const anchor = { x: vertex.x, y: vertex.y }
  const arm = sub(moved, anchor)
  const armLen = Math.hypot(arm.x, arm.y)
  if (armLen < 1e-9) return

  const existing = other[partner.key]
  const keepLen =
    mode === 'ANGLE' && existing ? Math.hypot(existing.x - anchor.x, existing.y - anchor.y) : armLen
  const len = keepLen < 1e-9 ? armLen : keepLen
  other[partner.key] = {
    x: anchor.x - (arm.x / armLen) * len,
    y: anchor.y - (arm.y / armLen) * len,
  }
}

/**
 * Set a vertex's mirror mode and make the shape agree with it immediately —
 * choosing "mirrored" and seeing nothing happen would be a lie about what the
 * setting does. The handle that already exists is the one kept.
 */
export function setVertexMirror(net: VectorNetwork, vid: number, mode: MirrorMode): void {
  const vertex = net.vertices.find((v) => v.id === vid)
  if (!vertex) return
  vertex.mirror = mode
  if (mode === 'NONE') return
  // Find a handle at this vertex to mirror FROM, preferring one that exists.
  for (let i = 0; i < net.edges.length; i++) {
    const e = net.edges[i]
    for (const key of ['cp0', 'cp1'] as CpKey[]) {
      if (vertexOf(e, key) !== vid) continue
      if (!e[key]) continue
      applyMirror(net, i, key)
      return
    }
  }
  // No handles at all: give the vertex two, along the line between its
  // neighbours, so a smooth point is visibly smooth.
  const arms: { edgeIndex: number; key: CpKey; toward: Vec2 }[] = []
  for (let i = 0; i < net.edges.length && arms.length < 2; i++) {
    const e = net.edges[i]
    for (const key of ['cp0', 'cp1'] as CpKey[]) {
      if (vertexOf(e, key) !== vid) continue
      const farId = key === 'cp0' ? e.v1 : e.v0
      const far = net.vertices.find((v) => v.id === farId)
      if (far) arms.push({ edgeIndex: i, key, toward: { x: far.x, y: far.y } })
    }
  }
  if (arms.length < 2) return
  // Tangent through the two neighbours; each arm reaches a third of the way.
  const tx = arms[1].toward.x - arms[0].toward.x
  const ty = arms[1].toward.y - arms[0].toward.y
  const tl = Math.hypot(tx, ty)
  if (tl < 1e-9) return
  for (const [i, arm] of arms.entries()) {
    const d = Math.hypot(arm.toward.x - vertex.x, arm.toward.y - vertex.y) / 3
    const sign = i === 0 ? -1 : 1
    net.edges[arm.edgeIndex][arm.key] = {
      x: vertex.x + (sign * tx * d) / tl,
      y: vertex.y + (sign * ty * d) / tl,
    }
  }
}

/** Cubic bezier point at t. */
export function bezierAt(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
    y: a * p0.y + b * c0.y + c * c1.y + d * p1.y,
  }
}

/**
 * Bend a segment so the curve passes through `target` at parameter t.
 *
 * Both control points move, split by how much influence each has at t (the
 * bernstein weights), which is the least-squares answer and lands the curve
 * exactly on the pointer. A straight segment gets its handles at the thirds
 * first, so bending one is the same gesture as bending a curve.
 */
export function bendEdge(net: VectorNetwork, edgeIndex: number, t: number, target: Vec2): void {
  const edge = net.edges[edgeIndex]
  if (!edge) return
  const a = net.vertices.find((v) => v.id === edge.v0)
  const b = net.vertices.find((v) => v.id === edge.v1)
  if (!a || !b) return
  const p0 = { x: a.x, y: a.y }
  const p1 = { x: b.x, y: b.y }
  const c0 = edge.cp0 ?? { x: p0.x + (p1.x - p0.x) / 3, y: p0.y + (p1.y - p0.y) / 3 }
  const c1 = edge.cp1 ?? { x: p0.x + ((p1.x - p0.x) * 2) / 3, y: p0.y + ((p1.y - p0.y) * 2) / 3 }

  const tc = Math.min(0.999, Math.max(0.001, t))
  const w0 = 3 * (1 - tc) * (1 - tc) * tc
  const w1 = 3 * (1 - tc) * tc * tc
  const denom = w0 * w0 + w1 * w1
  if (denom < 1e-12) return
  const at = bezierAt(p0, c0, c1, p1, tc)
  const need = sub(target, at)
  edge.cp0 = { x: c0.x + (need.x * w0) / denom, y: c0.y + (need.y * w0) / denom }
  edge.cp1 = { x: c1.x + (need.x * w1) / denom, y: c1.y + (need.y * w1) / denom }
  applyMirror(net, edgeIndex, 'cp0')
  applyMirror(net, edgeIndex, 'cp1')
}

/**
 * Split one segment at parameter t, returning the id of the new vertex.
 *
 * A curve is split with De Casteljau, so both halves lie exactly on the curve
 * that was there before — the shape does not move when you add a point to it,
 * which is the whole difference between adding a point and editing one.
 *
 * Lives here rather than in the pointer controller because the knife needs the
 * same split at every place it crosses the outline, and two implementations of
 * "cut this curve in half" would eventually disagree.
 */
export function splitEdgeAt(net: VectorNetwork, edgeIndex: number, t: number): number {
  const edge = net.edges[edgeIndex]
  if (!edge) return -1
  const vmap = new Map(net.vertices.map((v) => [v.id, v]))
  const a = vmap.get(edge.v0)
  const b = vmap.get(edge.v1)
  if (!a || !b) return -1
  const nextVid = Math.max(0, ...net.vertices.map((v) => v.id)) + 1
  const nextEid = Math.max(0, ...net.edges.map((e) => e.id)) + 1
  const lerp = (p: Vec2, q: Vec2, s: number): Vec2 => ({ x: p.x + (q.x - p.x) * s, y: p.y + (q.y - p.y) * s })

  if (edge.cp0 || edge.cp1) {
    const p0 = { x: a.x, y: a.y }
    const p3 = { x: b.x, y: b.y }
    const c0 = edge.cp0 ?? p0
    const c1 = edge.cp1 ?? p3
    const q0 = lerp(p0, c0, t)
    const q1 = lerp(c0, c1, t)
    const q2 = lerp(c1, p3, t)
    const r0 = lerp(q0, q1, t)
    const r1 = lerp(q1, q2, t)
    const s = lerp(r0, r1, t)
    net.vertices.push({ id: nextVid, x: s.x, y: s.y })
    net.edges.splice(
      edgeIndex,
      1,
      { id: edge.id, v0: edge.v0, v1: nextVid, cp0: q0, cp1: r0 },
      { id: nextEid, v0: nextVid, v1: edge.v1, cp0: r1, cp1: q2 },
    )
  } else {
    const s = lerp({ x: a.x, y: a.y }, { x: b.x, y: b.y }, t)
    net.vertices.push({ id: nextVid, x: s.x, y: s.y })
    net.edges.splice(
      edgeIndex,
      1,
      { id: edge.id, v0: edge.v0, v1: nextVid, cp0: null, cp1: null },
      { id: nextEid, v0: nextVid, v1: edge.v1, cp0: null, cp1: null },
    )
  }
  return nextVid
}

/**
 * Remove a vertex, healing the path through it: two segments meeting there
 * become one, so deleting a point from a closed outline leaves it closed
 * instead of punching a hole in it.
 */
export function removeVertex(net: VectorNetwork, vid: number): void {
  const touching: number[] = []
  net.edges.forEach((e, i) => {
    if (e.v0 === vid || e.v1 === vid) touching.push(i)
  })
  if (touching.length === 2) {
    const [ia, ib] = touching
    const ea = net.edges[ia]
    const eb = net.edges[ib]
    const farA = ea.v0 === vid ? ea.v1 : ea.v0
    const farB = eb.v0 === vid ? eb.v1 : eb.v0
    if (farA !== farB) {
      // One straight segment across the gap: keeping either side's curvature
      // would bulge toward a point that no longer exists.
      net.edges[ia] = { id: ea.id, v0: farA, v1: farB, cp0: null, cp1: null }
      net.edges.splice(ib, 1)
      net.vertices = net.vertices.filter((v) => v.id !== vid)
      return
    }
  }
  net.edges = net.edges.filter((e) => e.v0 !== vid && e.v1 !== vid)
  net.vertices = net.vertices.filter((v) => v.id !== vid)
}

/** Remove one segment, leaving its endpoints in place (this opens a path). */
export function removeEdge(net: VectorNetwork, edgeIndex: number): void {
  if (!net.edges[edgeIndex]) return
  net.edges.splice(edgeIndex, 1)
  // Drop vertices nothing connects to any more; a lone point is not editable
  // and not drawable, so leaving it behind is just a trap for the next click.
  const used = new Set<number>()
  for (const e of net.edges) {
    used.add(e.v0)
    used.add(e.v1)
  }
  net.vertices = net.vertices.filter((v) => used.has(v.id))
}
