// The separate PARTS of one vector network.
//
// A single VECTOR node very often holds several detached outlines — a letter
// "O", a leaf with a hole in it, anything imported from an SVG with `M` more
// than once. The network has no notion of that: it is a flat bag of vertices
// and edges, and which ones belong together is only ever implied by what is
// connected to what.
//
// Nearly every tool that does something structural needs the answer. Bridge has
// to know that two anchors are in DIFFERENT parts (that is what makes it a
// bridge and not a join), Dissolve that two parts overlap, Paint which part a
// click landed in. So the walk lives here once rather than three times.

import { networkToSubPaths, type SubPath } from './shapes'
import type { VectorNetwork } from './types'

export interface NetworkPart {
  /** Vertex ids in this connected component, in ascending order. */
  vertices: number[]
  /** Indices into `net.edges`, in ascending order. */
  edges: number[]
  /**
   * Every vertex has exactly two edges, so the part is one closed loop. An open
   * chain has two ends of degree 1; a branching network has a vertex of degree
   * 3+. Only a closed part encloses an area, which is what Paint and Dissolve
   * both need to know before they can mean anything.
   */
  closed: boolean
}

/**
 * Connected components of the network, in a stable order: by the smallest
 * vertex id each contains. Stable matters because Paint keys a fill to a part,
 * and a part that renumbers itself when an unrelated edge is added would repaint
 * the wrong outline.
 */
export function networkParts(net: VectorNetwork): NetworkPart[] {
  const adjacency = new Map<number, number[]>()
  const degree = new Map<number, number>()
  for (const v of net.vertices) {
    adjacency.set(v.id, [])
    degree.set(v.id, 0)
  }
  net.edges.forEach((e, i) => {
    // An edge naming a vertex that is gone is not a link; ignoring it here keeps
    // every caller from having to defend against a half-edited network.
    if (!adjacency.has(e.v0) || !adjacency.has(e.v1)) return
    adjacency.get(e.v0)!.push(i)
    adjacency.get(e.v1)!.push(i)
    degree.set(e.v0, (degree.get(e.v0) ?? 0) + 1)
    degree.set(e.v1, (degree.get(e.v1) ?? 0) + 1)
  })

  const seen = new Set<number>()
  const parts: NetworkPart[] = []
  // Vertex order, not edge order, so a LONE vertex is still a part. It cannot be
  // drawn, but it can be selected and joined, and a walk that starts from edges
  // would make it invisible to every tool here.
  for (const start of net.vertices) {
    if (seen.has(start.id)) continue
    const vertices: number[] = []
    const edges = new Set<number>()
    const queue = [start.id]
    seen.add(start.id)
    while (queue.length > 0) {
      const vid = queue.pop()!
      vertices.push(vid)
      for (const ei of adjacency.get(vid) ?? []) {
        edges.add(ei)
        const e = net.edges[ei]
        const other = e.v0 === vid ? e.v1 : e.v0
        if (seen.has(other)) continue
        seen.add(other)
        queue.push(other)
      }
    }
    vertices.sort((a, b) => a - b)
    parts.push({
      vertices,
      edges: [...edges].sort((a, b) => a - b),
      closed: vertices.length >= 3 && vertices.every((vid) => degree.get(vid) === 2),
    })
  }
  parts.sort((a, b) => a.vertices[0] - b.vertices[0])
  return parts
}

/**
 * A part's stable NAME, for anything that has to remember something about it
 * across edits — Paint keys a fill to this.
 *
 * The smallest anchor id it contains. Anchor ids are handed out from a
 * high-water mark and never reused, so the name survives points being added,
 * moved, bent or deleted elsewhere in the part. It does NOT survive that
 * particular anchor being deleted, or a knife cut, which rebuilds both halves
 * from scratch — and it should not: those really are different outlines, and a
 * colour that followed one of them would be guessing which.
 */
export function partKey(part: NetworkPart): number {
  return part.vertices[0] ?? -1
}

/**
 * One part's geometry, as subpaths.
 *
 * Built by handing the part's own edges back to the same walker the renderers
 * use, rather than by re-deriving the outline here. Two ways of turning a
 * network into subpaths would eventually disagree, and the disagreement would
 * show up as a fill landing on the wrong outline.
 */
export function partSubPaths(net: VectorNetwork, part: NetworkPart): SubPath[] {
  const vids = new Set(part.vertices)
  return networkToSubPaths({
    vertices: net.vertices.filter((v) => vids.has(v.id)),
    edges: part.edges.map((i) => net.edges[i]),
  })
}

/** Which part a vertex is in, or -1. */
export function partOfVertex(parts: readonly NetworkPart[], vid: number): number {
  return parts.findIndex((p) => p.vertices.includes(vid))
}

/**
 * Group vertex ids by the part they belong to, dropping any that are in none.
 * Returned smallest-part-index first, which is the order Bridge pairs them in.
 */
export function groupByPart(parts: readonly NetworkPart[], vids: readonly number[]): { part: number; vids: number[] }[] {
  const byPart = new Map<number, number[]>()
  for (const vid of vids) {
    const p = partOfVertex(parts, vid)
    if (p < 0) continue
    if (!byPart.has(p)) byPart.set(p, [])
    byPart.get(p)!.push(vid)
  }
  return [...byPart.entries()].sort((a, b) => a[0] - b[0]).map(([part, v]) => ({ part, vids: v }))
}
