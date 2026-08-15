// Per-part fills: giving one outline of a vector its own colour.
//
// A VECTOR node has one `fills` list, and for almost every shape that is the
// right answer. But a single node very often holds several detached outlines —
// after a knife cut, or straight out of an SVG with more than one `M` — and
// then "the shape's colour" is one colour for things that read as separate
// objects. Splitting them into separate nodes would be the other answer, and it
// is the wrong one: they are one shape, they move together, and the moment you
// bridge or dissolve them they are provably one shape.
//
// So `partFills` is a set of EXCEPTIONS, keyed by part. This module turns a node
// plus those exceptions into the list of groups a renderer should paint, and
// returns null when there are none — every back end keeps its fast path for the
// overwhelmingly common case of a shape with one colour.

import { networkParts, partKey, partSubPaths } from './vector-parts'
import { pointInRing } from './vector-rings'
import { flattenSubPath, type SubPath } from './shapes'
import type { Paint, Vec2, VectorNode } from './types'

export interface PaintGroup {
  /** Stable name of the part, or -1 for the leftovers group. */
  key: number
  subpaths: SubPath[]
  fills: Paint[]
}

/** True when this node paints any of its parts separately. */
export function hasPartFills(node: VectorNode): boolean {
  const table = node.partFills
  if (!table) return false
  for (const k in table) if (table[k]?.length) return true
  return false
}

/**
 * What to paint, in order, or null when the node is a single colour.
 *
 * Parts with no exception of their own are collected into ONE leftovers group
 * painted with the node's own fills, rather than a group each: they share a
 * paint, and a gradient across them should span all of them the way it does on
 * an unpainted shape rather than restarting per outline.
 *
 * The leftovers go first so a per-part colour always lands on top of the node
 * colour where they overlap — which is the order that makes "I painted this
 * one" do what it says.
 */
export function vectorPaintGroups(node: VectorNode): PaintGroup[] | null {
  if (!hasPartFills(node)) return null
  const table = node.partFills ?? {}
  const parts = networkParts(node.network)
  const groups: PaintGroup[] = []
  const leftovers: SubPath[] = []
  for (const part of parts) {
    const key = partKey(part)
    const fills = table[String(key)]
    const subpaths = partSubPaths(node.network, part)
    if (!part.closed || !fills?.length) {
      leftovers.push(...subpaths)
      continue
    }
    groups.push({ key, subpaths, fills })
  }
  if (leftovers.length > 0) groups.unshift({ key: -1, subpaths: leftovers, fills: node.fills })
  return groups.length > 0 ? groups : null
}

/**
 * Which part encloses a point, in the node's own space, or null.
 *
 * Innermost first: a part contained by another — the hole in an "O", a leaf
 * sitting on a stem — is the one you meant, because it is the one you can see
 * at that spot. Smallest area wins, which is the cheap way of saying that
 * without a containment tree.
 */
export function partAtPoint(node: VectorNode, p: Vec2): number | null {
  let best: { key: number; area: number } | null = null
  for (const part of networkParts(node.network)) {
    if (!part.closed) continue
    const subpaths = partSubPaths(node.network, part)
    let hit = false
    let area = 0
    for (const sp of subpaths) {
      const pts = flattenSubPath(sp, 0.25)
      if (pointInRing(pts, p)) hit = !hit
      let a = 0
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i]
        const r = pts[(i + 1) % pts.length]
        a += q.x * r.y - r.x * q.y
      }
      area += Math.abs(a) / 2
    }
    if (!hit) continue
    if (!best || area < best.area) best = { key: partKey(part), area }
  }
  return best?.key ?? null
}

/**
 * Set or clear one part's fill, returning a new table.
 *
 * Clearing removes the key rather than storing an empty list, so "no exception"
 * has exactly one representation — a stored empty list would render the same
 * and compare differently, which is the kind of difference that survives a
 * round trip through a file and then confuses everything downstream.
 */
export function withPartFill(
  table: Record<string, Paint[]> | undefined,
  key: number,
  fills: Paint[] | null,
): Record<string, Paint[]> | undefined {
  const next = { ...(table ?? {}) }
  if (fills && fills.length > 0) next[String(key)] = fills
  else delete next[String(key)]
  return Object.keys(next).length > 0 ? next : undefined
}
