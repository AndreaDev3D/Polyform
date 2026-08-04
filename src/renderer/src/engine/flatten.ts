// Flatten: turn any shape (or several) into one editable VECTOR.
//
// This is the counterpart to booleans. A BOOLEAN node keeps its operands and
// recomputes; flattening BAKES geometry into anchors you can drag — flatten an
// ellipse and you get its four anchors with their bezier handles, which is the
// only way to start editing a primitive's curve by hand.
//
// Contours are concatenated as subpaths rather than CSG-merged, so curves
// survive. Winding decides what the result looks like, and there are two rules
// here: normalizeWinding gives every contour the same direction, so nonzero
// filling renders the UNION of overlapping contours; carveWinding winds by
// nesting depth, so enclosed contours become HOLES. A BOOLEAN source
// contributes its already-computed rings, so its operation is preserved (as
// straight segments — that is what exact CSG produces).

import type { Mat } from './geometry'
import { applyMat, pointInPolygonRings } from './geometry'
import type { SubPath } from './shapes'
import { flattenSubPath } from './shapes'
import type { VectorEdge, VectorNetwork, VectorVertex, Vec2 } from './types'

/** Twice the signed area of a closed polyline; positive = one orientation. */
export function signedArea(points: Vec2[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum
}

/**
 * Reverse a subpath's direction, curves intact.
 *
 * Walking the other way, every anchor's outgoing handle is its old incoming
 * one and vice versa — so reversing the anchor order and swapping cpIn/cpOut
 * on each is the whole job. (Segment j of the reversed path runs from
 * A[n-1-j] to A[n-2-j], which is old segment n-2-j travelled backwards; its
 * controls are exactly that pair, swapped.)
 */
export function reverseSubPath(sp: SubPath): SubPath {
  return {
    closed: sp.closed,
    anchors: sp.anchors
      .slice()
      .reverse()
      .map((a) => ({
        p: { ...a.p },
        cpIn: a.cpOut ? { ...a.cpOut } : null,
        cpOut: a.cpIn ? { ...a.cpIn } : null,
      })),
  }
}

/** Transform a subpath's points and handles by a matrix. */
export function transformSubPath(sp: SubPath, m: Mat): SubPath {
  return {
    closed: sp.closed,
    anchors: sp.anchors.map((a) => ({
      p: applyMat(m, a.p),
      cpIn: a.cpIn ? applyMat(m, a.cpIn) : null,
      cpOut: a.cpOut ? applyMat(m, a.cpOut) : null,
    })),
  }
}

/**
 * Give every closed contour the same orientation. Two overlapping contours
 * wound opposite ways cancel under nonzero filling — the hole a user did not
 * ask for. Open contours are left alone; direction is meaningless for them.
 */
export function normalizeWinding(paths: SubPath[]): SubPath[] {
  return paths.map((sp) => {
    if (!sp.closed || sp.anchors.length < 3) return sp
    return signedArea(sp.anchors.map((a) => a.p)) < 0 ? reverseSubPath(sp) : sp
  })
}

/**
 * Wind contours by how deeply they nest, so enclosed ones become holes.
 *
 * This is the rule a font glyph uses: a contour at even depth is solid, one at
 * odd depth is wound the other way and cancels the fill under it — an "o" is an
 * outer ring plus a reversed inner one. Nesting is counted rather than assumed,
 * so a shape inside a hole fills again, which is what you would draw if you
 * wanted an island in a lake.
 *
 * Containment is tested on flattened outlines, from a point that is definitely
 * inside the contour being placed (its centroid when that lands inside, an
 * anchor otherwise, for the concave shapes where a centroid escapes). A
 * container must also be LARGER: without that, the big square's centroid sits
 * inside the little square too, and both come out nested in each other.
 */
export function carveWinding(paths: SubPath[]): SubPath[] {
  const closed = paths.map((sp, i) => ({ sp, i })).filter((e) => e.sp.closed && e.sp.anchors.length >= 3)
  const poly = new Map<number, Vec2[]>()
  const probe = new Map<number, Vec2>()
  const area = new Map<number, number>()
  for (const { sp, i } of closed) {
    const flat = flattenSubPath(sp, 0.5)
    poly.set(i, flat)
    area.set(i, Math.abs(signedArea(flat)))
    const c = flat.reduce((acc, p) => ({ x: acc.x + p.x / flat.length, y: acc.y + p.y / flat.length }), { x: 0, y: 0 })
    probe.set(i, pointInPolygonRings(c, [flat]) ? c : sp.anchors[0].p)
  }

  const depth = new Map<number, number>()
  for (const { i } of closed) {
    let d = 0
    const p = probe.get(i)!
    for (const { i: j } of closed) {
      if (i === j) continue
      if (area.get(j)! <= area.get(i)!) continue
      if (pointInPolygonRings(p, [poly.get(j)!])) d++
    }
    depth.set(i, d)
  }

  return paths.map((sp, i) => {
    if (!depth.has(i)) return sp
    const wantPositive = depth.get(i)! % 2 === 0
    const positive = signedArea(sp.anchors.map((a) => a.p)) >= 0
    return positive === wantPositive ? sp : reverseSubPath(sp)
  })
}

/** Straight-segment contours (boolean rings) as subpaths. */
export function ringsToSubPaths(rings: Vec2[][]): SubPath[] {
  return rings
    .filter((r) => r.length >= 3)
    .map((r) => ({ closed: true, anchors: r.map((p) => ({ p: { ...p }, cpIn: null, cpOut: null })) }))
}

/**
 * Subpaths -> a vector network. Anchors become vertices; each segment becomes
 * an edge carrying the two absolute control points the renderer expects.
 */
export function subPathsToNetwork(paths: SubPath[]): VectorNetwork {
  const vertices: VectorVertex[] = []
  const edges: VectorEdge[] = []
  for (const sp of paths) {
    const n = sp.anchors.length
    if (n < 2) continue
    const base = vertices.length
    sp.anchors.forEach((a) => vertices.push({ id: vertices.length, x: a.p.x, y: a.p.y }))
    const segments = sp.closed ? n : n - 1
    for (let i = 0; i < segments; i++) {
      const a = sp.anchors[i]
      const b = sp.anchors[(i + 1) % n]
      edges.push({
        id: edges.length,
        v0: base + i,
        v1: base + ((i + 1) % n),
        cp0: a.cpOut ? { ...a.cpOut } : null,
        cp1: b.cpIn ? { ...b.cpIn } : null,
      })
    }
  }
  return { vertices, edges }
}

/** Bounding box over anchors AND handles — a curve can bulge past its anchors. */
export function networkBounds(net: VectorNetwork): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts: Vec2[] = net.vertices.map((v) => ({ x: v.x, y: v.y }))
  for (const e of net.edges) {
    if (e.cp0) pts.push(e.cp0)
    if (e.cp1) pts.push(e.cp1)
  }
  if (pts.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  }
}

/** Shift a network so its bounds start at the origin; returns the offset. */
export function anchorNetworkAtOrigin(net: VectorNetwork): { network: VectorNetwork; dx: number; dy: number } {
  const b = networkBounds(net)
  const dx = b.minX
  const dy = b.minY
  return {
    network: {
      vertices: net.vertices.map((v) => ({ ...v, x: v.x - dx, y: v.y - dy })),
      edges: net.edges.map((e) => ({
        ...e,
        cp0: e.cp0 ? { x: e.cp0.x - dx, y: e.cp0.y - dy } : null,
        cp1: e.cp1 ? { x: e.cp1.x - dx, y: e.cp1.y - dy } : null,
      })),
    },
    dx,
    dy,
  }
}
