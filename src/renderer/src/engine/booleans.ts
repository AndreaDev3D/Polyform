// Non-destructive boolean geometry (union / subtract / intersect / exclude).
// Two backends behind `booleanRings` (ADR-015):
//   - WASM (default): exact bezier CSG in Rust (flo_curves) — intersections
//     are computed on the curves, flattening happens only at output.
//   - TS (fallback): flatten child outlines to polygons, run polygon-clipping.
// Any WASM failure poisons the engine for the session and falls back to TS,
// so degenerate geometry can never blank a shape.

import polygonClipping from 'polygon-clipping'
import type { Pair, Polygon, MultiPolygon } from 'polygon-clipping'
import type { BooleanNode, NodeId, SceneNode, Vec2 } from './types'
import { isContainer } from './types'
import type { SceneGraph } from './scene'
import type { Mat } from './geometry'
import { IDENTITY, applyMat, matMultiply } from './geometry'
import { flattenSubPath, nodeOutline, type SubPath } from './shapes'
import { poisonWasmEngine, useWasm, wasmHandle } from './backend'
import { decodeRings, encodeSubPaths } from './wasm/codec'

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

// ---------------------------------------------------------------------------
// WASM path: collect each direct child's closed subpaths with transforms
// applied to anchors AND control points (affine images of beziers are exact),
// then run the CSG in Rust.
// ---------------------------------------------------------------------------

function transformSubPath(sp: SubPath, m: Mat): SubPath {
  return {
    closed: sp.closed,
    anchors: sp.anchors.map((a) => ({
      p: applyMat(m, a.p),
      cpIn: a.cpIn ? applyMat(m, a.cpIn) : null,
      cpOut: a.cpOut ? applyMat(m, a.cpOut) : null,
    })),
  }
}

/** Closed subpaths of a subtree in `space` coordinates (curves preserved). */
function collectSubPaths(scene: SceneGraph, node: SceneNode, space: Mat, out: SubPath[]): void {
  if (node.type === 'BOOLEAN') {
    // Nested boolean: its rings are already computed (possibly exactly);
    // feed them through as closed polyline subpaths.
    for (const ring of booleanRings(scene, node)) {
      if (ring.length < 3) continue
      out.push({
        closed: true,
        anchors: ring.map((p) => ({ p: applyMat(space, p), cpIn: null, cpOut: null })),
      })
    }
    return
  }
  if (isContainer(node)) {
    for (const cid of node.children) {
      const child = scene.getNode(cid)
      if (!child || !child.visible) continue
      collectSubPaths(scene, child, matMultiply(space, scene.localMatrix(child)), out)
    }
    return
  }
  for (const sp of nodeOutline(node)) {
    if (sp.closed) out.push(transformSubPath(sp, space))
  }
}

const OP_CODE: Record<BooleanNode['booleanOp'], number> = {
  UNION: 0,
  SUBTRACT: 1,
  INTERSECT: 2,
  EXCLUDE: 3,
}

function wasmBooleanRings(scene: SceneGraph, node: BooleanNode): Vec2[][] {
  const children: SubPath[][] = []
  for (const cid of node.children) {
    const child = scene.getNode(cid)
    if (!child || !child.visible) continue
    const subpaths: SubPath[] = []
    collectSubPaths(scene, child, scene.localMatrix(child), subpaths)
    if (subpaths.length > 0) children.push(subpaths)
  }
  const blobs = children.map((c) => encodeSubPaths(c))
  let total = 1
  for (const b of blobs) total += 1 + b.length
  const data = new Float64Array(total)
  data[0] = blobs.length
  let i = 1
  for (const b of blobs) {
    data[i++] = b.length
    data.set(b, i)
    i += b.length
  }
  return decodeRings(wasmHandle().booleanOp(data, OP_CODE[node.booleanOp], 0.01, 0.25))
}

/**
 * Boolean result rings in the boolean node's local space. Fill these with the
 * even-odd rule. Cached per scene version.
 */
export function booleanRings(scene: SceneGraph, node: BooleanNode): Vec2[][] {
  const cached = cache.get(node.id)
  if (cached && cached.version === scene.version) return cached.rings

  if (useWasm('booleans')) {
    try {
      const rings = wasmBooleanRings(scene, node)
      cache.set(node.id, { version: scene.version, rings })
      return rings
    } catch (err) {
      // A trap inside CSG leaves the instance unreliable — drop to TS for
      // the whole session rather than risk corrupted results elsewhere.
      poisonWasmEngine(err)
    }
  }

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
