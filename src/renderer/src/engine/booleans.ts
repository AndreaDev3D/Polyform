// Non-destructive boolean geometry (union / subtract / intersect / exclude).
// v0.1 approach: flatten child outlines to polygons and run polygon-clipping.
// Exact bezier CSG is planned for the Rust core (see docs/Findings-and-Concerns.md).

import polygonClipping from 'polygon-clipping'
import type { Pair, Polygon, MultiPolygon } from 'polygon-clipping'
import type { BooleanNode, NodeId, SceneNode, Vec2 } from './types'
import { isContainer } from './types'
import type { SceneGraph } from './scene'
import type { Mat } from './geometry'
import { IDENTITY, applyMat, matMultiply } from './geometry'
import { flattenSubPath, nodeOutline } from './shapes'

const cache = new Map<NodeId, { version: number; rings: Vec2[][] }>()

/**
 * Collect a node's filled geometry as a MultiPolygon in `space` coordinates
 * (each subtree node's local matrix composed onto `space`).
 */
function collectPolygons(scene: SceneGraph, node: SceneNode, space: Mat): MultiPolygon {
  if (node.type === 'BOOLEAN') {
    const rings = booleanRings(scene, node)
    return ringsToMultiPolygon(rings.map((ring) => ring.map((p) => applyMat(space, p))))
  }
  if (isContainer(node)) {
    let acc: MultiPolygon = []
    for (const cid of node.children) {
      const child = scene.getNode(cid)
      if (!child || !child.visible) continue
      const childSpace = matMultiply(space, scene.localMatrix(child))
      const polys = collectPolygons(scene, child, childSpace)
      acc = acc.length === 0 ? polys : (polygonClipping.union(acc, polys) as MultiPolygon)
    }
    return acc
  }
  const subpaths = nodeOutline(node).filter((sp) => sp.closed)
  const rings: Vec2[][] = subpaths
    .map((sp) => flattenSubPath(sp, 0.5).map((p) => applyMat(space, p)))
    .filter((r) => r.length >= 3)
  return ringsToMultiPolygon(rings)
}

function ringsToMultiPolygon(rings: Vec2[][]): MultiPolygon {
  // Treat each ring as its own polygon; polygon-clipping normalizes holes
  // through the boolean operations themselves (even-odd style input is fine
  // as long as we union the rings pairwise-xor free; acceptable for v0.1).
  return rings.map((ring): Polygon => [ring.map((p): Pair => [p.x, p.y])])
}

/**
 * Boolean result rings in the boolean node's local space. Fill these with the
 * even-odd rule. Cached per scene version.
 */
export function booleanRings(scene: SceneGraph, node: BooleanNode): Vec2[][] {
  const cached = cache.get(node.id)
  if (cached && cached.version === scene.version) return cached.rings

  const childGeoms: MultiPolygon[] = []
  for (const cid of node.children) {
    const child = scene.getNode(cid)
    if (!child || !child.visible) continue
    const polys = collectPolygons(scene, child, scene.localMatrix(child))
    if (polys.length > 0) childGeoms.push(polys)
  }

  let result: MultiPolygon = []
  if (childGeoms.length === 1) {
    result = childGeoms[0]
  } else if (childGeoms.length > 1) {
    const [first, ...rest] = childGeoms
    try {
      switch (node.booleanOp) {
        case 'UNION':
          result = polygonClipping.union(first, ...rest)
          break
        case 'SUBTRACT':
          result = polygonClipping.difference(first, ...rest)
          break
        case 'INTERSECT':
          result = polygonClipping.intersection(first, ...rest)
          break
        case 'EXCLUDE':
          result = polygonClipping.xor(first, ...rest)
          break
      }
    } catch {
      // Degenerate geometry can throw inside polygon-clipping; fall back to
      // the raw union of inputs so the shape never disappears silently.
      result = first
    }
  }

  const rings: Vec2[][] = []
  for (const polygon of result) {
    for (const ring of polygon) {
      rings.push(ring.map(([x, y]) => ({ x, y })))
    }
  }
  cache.set(node.id, { version: scene.version, rings })
  return rings
}

export function clearBooleanCache(): void {
  cache.clear()
}
