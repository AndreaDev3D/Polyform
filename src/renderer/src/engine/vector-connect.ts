// Connecting anchors that are not connected yet: Join and Bridge.
//
// They are one idea with two pairing rules. Join takes two anchors and runs a
// segment between them. Bridge takes anchors from two DIFFERENT parts of the
// same shape and runs one segment per pair, which is what turns two detached
// outlines into one — the 2D reading of bridging two edge loops in a 3D
// modeller.
//
// Both refuse rather than guess, and say why: a command that silently does
// nothing is indistinguishable from a broken one.

import { groupByPart, networkParts } from './vector-parts'
import type { VectorNetwork } from './types'

/** Next free edge id. Ids are stable names, so they are never reused. */
function nextEdgeId(net: VectorNetwork): number {
  return Math.max(0, ...net.edges.map((e) => e.id)) + 1
}

function edgeExists(net: VectorNetwork, a: number, b: number): boolean {
  return net.edges.some((e) => (e.v0 === a && e.v1 === b) || (e.v0 === b && e.v1 === a))
}

function addSegment(net: VectorNetwork, a: number, b: number): void {
  net.edges.push({ id: nextEdgeId(net), v0: a, v1: b, cp0: null, cp1: null })
}

/**
 * Run a straight segment between two anchors.
 *
 * Deliberately not restricted to path ENDS the way Illustrator's join is. Two
 * ends is the common case and closing a gap is what people reach for, but
 * joining across the middle of a path is the only way to draw a crossbar
 * without leaving the shape, and the network model has always allowed a vertex
 * to carry more than two edges.
 *
 * Returns null on success, or why it declined.
 */
export function joinVertices(net: VectorNetwork, vids: readonly number[]): string | null {
  if (vids.length !== 2) return `Join connects two points — ${vids.length} selected`
  const [a, b] = vids
  if (a === b) return 'Join needs two different points'
  const have = new Set(net.vertices.map((v) => v.id))
  if (!have.has(a) || !have.has(b)) return 'Those points are no longer in the path'
  if (edgeExists(net, a, b)) return 'Those two points are already connected'
  addSegment(net, a, b)
  return null
}

/**
 * Weld loose ends that are sitting on top of each other into single anchors.
 *
 * This is the repair for a path that LOOKS closed and is not. An outline that
 * arrives in pieces — the usual shape of an imported `.fig` or `.svg` path, and
 * of anything built by drawing one curve at a time — has ends at identical
 * coordinates that are still separate anchors, with a gap of zero width between
 * them. Nothing on screen shows the difference, and the shape refuses to fill,
 * because a fill needs a closed outline and there is not one.
 *
 * Joining them by hand is not a real option either: two anchors in the same
 * place cannot be told apart by clicking, so the selection needed to Join them
 * is one you cannot make.
 *
 * Only ENDS are welded — a vertex with one edge or none. A point in the middle
 * of a path that happens to pass under another is not a join anyone asked for,
 * and merging those would reshape the path rather than close it.
 *
 * Returns how many anchors were removed by merging.
 */
export function weldLooseEnds(net: VectorNetwork, tolerance: number): number {
  const degree = new Map<number, number>()
  for (const v of net.vertices) degree.set(v.id, 0)
  for (const e of net.edges) {
    degree.set(e.v0, (degree.get(e.v0) ?? 0) + 1)
    degree.set(e.v1, (degree.get(e.v1) ?? 0) + 1)
  }
  const ends = net.vertices.filter((v) => (degree.get(v.id) ?? 0) <= 1)
  const gone = new Map<number, number>() // merged id -> id it became
  for (let i = 0; i < ends.length; i++) {
    const a = ends[i]
    if (gone.has(a.id)) continue
    for (let j = i + 1; j < ends.length; j++) {
      const b = ends[j]
      if (gone.has(b.id)) continue
      if (Math.hypot(a.x - b.x, a.y - b.y) > tolerance) continue
      // Never weld the two ends of the SAME single segment: that turns a line
      // into a self-loop enclosing nothing, which is not a shape.
      if (net.edges.some((e) => (e.v0 === a.id && e.v1 === b.id) || (e.v0 === b.id && e.v1 === a.id))) continue
      gone.set(b.id, a.id)
    }
  }
  if (gone.size === 0) return 0

  const resolve = (id: number): number => {
    let cur = id
    for (let guard = 0; guard < 8 && gone.has(cur); guard++) cur = gone.get(cur)!
    return cur
  }
  const seen = new Set<string>()
  const kept: VectorNetwork['edges'] = []
  for (const e of net.edges) {
    const v0 = resolve(e.v0)
    const v1 = resolve(e.v1)
    if (v0 === v1) continue // collapsed to nothing
    // Two segments between the same pair of anchors are only DUPLICATES if they
    // also curve the same way. The commonest shape this whole command exists to
    // repair — a lens, a leaf, a letter O — is exactly two curves sharing both
    // endpoints and bowing opposite ways. Keying on endpoints alone deleted one
    // of them and left an open chain, which is worse than the problem: it turns
    // "your fill is not applying" into "half your shape is gone".
    const at = (p: { x: number; y: number } | null): string => (p ? `${p.x},${p.y}` : 'n')
    const key =
      v0 < v1 ? `${v0}-${v1}|${at(e.cp0)}|${at(e.cp1)}` : `${v1}-${v0}|${at(e.cp1)}|${at(e.cp0)}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push({ ...e, v0, v1 })
  }
  net.edges = kept
  net.vertices = net.vertices.filter((v) => !gone.has(v.id))
  return gone.size
}

/**
 * Run one segment per pair between two detached parts of the same shape.
 *
 * The anchors are grouped by which part they belong to, and there must be
 * exactly two parts holding the same number of them — with 2 here and 3 there,
 * "which one is left over" has no answer worth guessing at.
 *
 * The pairing is the one with the shortest total length, which is also the one
 * that does not cross itself for any bridge you would actually draw. Exhaustive
 * up to 6 a side (720 orders costs nothing) and nearest-first above that, where
 * the shape is past the point of caring.
 */
export function bridgeVertices(net: VectorNetwork, vids: readonly number[]): string | null {
  const unique = [...new Set(vids)]
  if (unique.length < 2) return 'Bridge needs points from two separate parts of the shape'
  // Asked for again, before asking which parts these are in. A bridge MERGES
  // the two parts, so the second attempt at the same one finds both anchors in
  // a single part and would otherwise be turned away with "use Join instead" —
  // true, and no help at all to someone who has just built that bridge.
  if (unique.length === 2 && edgeExists(net, unique[0], unique[1])) {
    return 'Those two points are already connected'
  }
  const parts = networkParts(net)
  const groups = groupByPart(parts, unique)
  if (groups.length < 2) return 'Those points are all in the same part — use Join instead'
  if (groups.length > 2) return `Bridge connects two parts at a time — ${groups.length} selected`
  const [left, right] = groups
  if (left.vids.length !== right.vids.length) {
    return `Bridge needs the same number of points on each side — ${left.vids.length} and ${right.vids.length}`
  }

  const at = new Map(net.vertices.map((v) => [v.id, v]))
  const dist2 = (a: number, b: number): number => {
    const p = at.get(a)
    const q = at.get(b)
    if (!p || !q) return Infinity
    return (p.x - q.x) ** 2 + (p.y - q.y) ** 2
  }

  const pairing = left.vids.length <= 6 ? shortestPairing(left.vids, right.vids, dist2) : nearestFirst(left.vids, right.vids, dist2)
  let added = 0
  for (const [a, b] of pairing) {
    if (edgeExists(net, a, b)) continue
    addSegment(net, a, b)
    added++
  }
  return added > 0 ? null : 'Those points are already bridged'
}

/** Every order of the right-hand side, scored; the cheapest wins. */
function shortestPairing(
  left: readonly number[],
  right: readonly number[],
  dist2: (a: number, b: number) => number,
): [number, number][] {
  let best: [number, number][] | null = null
  let bestCost = Infinity
  for (const order of permutations(right)) {
    let cost = 0
    for (let i = 0; i < left.length; i++) cost += dist2(left[i], order[i])
    if (cost < bestCost) {
      bestCost = cost
      best = left.map((a, i) => [a, order[i]])
    }
  }
  return best ?? []
}

function permutations(items: readonly number[]): number[][] {
  if (items.length <= 1) return [[...items]]
  const out: number[][] = []
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of permutations(rest)) out.push([items[i], ...tail])
  }
  return out
}

/** Greedy fallback: closest available pair first, then the next closest. */
function nearestFirst(
  left: readonly number[],
  right: readonly number[],
  dist2: (a: number, b: number) => number,
): [number, number][] {
  const free = new Set(right)
  const out: [number, number][] = []
  for (const a of left) {
    let pick: number | null = null
    let bestD = Infinity
    for (const b of free) {
      const d = dist2(a, b)
      if (d < bestD) {
        bestD = d
        pick = b
      }
    }
    if (pick === null) break
    free.delete(pick)
    out.push([a, pick])
  }
  return out
}
