// Precise hit-testing: R-tree broad phase, then exact geometry tests in
// node-local space (rotation-aware via inverse world matrices).

import type { NodeId, SceneNode, Vec2 } from './types'
import { isContainer } from './types'
import type { SceneGraph } from './scene'
import type { SpatialIndex } from './spatial-index'
import type { AABB } from './geometry'
import {
  aabbContainsAABB,
  aabbIntersects,
  applyMat,
  distToSegment,
  matInvert,
  pointInEllipse,
  pointInPolygonRings,
  pointInRoundedRect,
} from './geometry'
import { flattenSubPath, nodeOutline } from './shapes'
import { booleanRings } from './booleans'

export interface HitOptions {
  /** Screen-space tolerance in px. */
  tolerancePx: number
  zoom: number
  /** Node ids to skip (e.g. the nodes currently being dragged). */
  exclude?: Set<NodeId>
  /** Include locked nodes (default false). */
  includeLocked?: boolean
}

function ringsMinDist(p: Vec2, rings: Vec2[][], closed: boolean): number {
  let min = Infinity
  for (const ring of rings) {
    const n = ring.length
    const segs = closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      min = Math.min(min, distToSegment(p, ring[i], ring[(i + 1) % n]))
    }
  }
  return min
}

/** Exact test of a point (world space) against one node. */
export function preciseHit(scene: SceneGraph, id: NodeId, worldPt: Vec2, tolWorld: number): boolean {
  const node = scene.getNode(id)
  if (!node) return false
  const inv = matInvert(scene.worldMatrix(id))
  const p = applyMat(inv, worldPt)
  const hasFill = node.fills.some((f) => f.visible)
  const hasStroke = node.strokes.some((s) => s.visible)
  const strokeTol = tolWorld + (hasStroke ? node.strokeWeight / 2 + 1 : 0)

  switch (node.type) {
    case 'RECTANGLE':
    case 'FRAME':
    case 'COMPONENT':
    case 'INSTANCE': {
      const inside = pointInRoundedRect(p, node.width, node.height, node.cornerRadius)
      if (hasFill && inside) return true
      // Border proximity (frames without fill are pickable by their border).
      const nearX = Math.min(Math.abs(p.x), Math.abs(p.x - node.width))
      const nearY = Math.min(Math.abs(p.y), Math.abs(p.y - node.height))
      const withinY = p.y >= -strokeTol && p.y <= node.height + strokeTol
      const withinX = p.x >= -strokeTol && p.x <= node.width + strokeTol
      return (nearX <= strokeTol && withinY) || (nearY <= strokeTol && withinX)
    }
    case 'ELLIPSE': {
      const rx = node.width / 2
      const ry = node.height / 2
      if (hasFill && pointInEllipse(p, rx, ry, rx, ry)) return true
      // Ring proximity approximation.
      const outer = pointInEllipse(p, rx, ry, rx + strokeTol, ry + strokeTol)
      const inner = pointInEllipse(p, rx, ry, Math.max(0.01, rx - strokeTol), Math.max(0.01, ry - strokeTol))
      return outer && !inner
    }
    case 'LINE':
      return distToSegment(p, { x: 0, y: 0 }, { x: node.width, y: 0 }) <= strokeTol + 2
    case 'TEXT':
    // A model's rendered snapshot fills its box; pick it like a text block.
    case 'MODEL3D':
      return p.x >= 0 && p.y >= 0 && p.x <= node.width && p.y <= node.height
    case 'GROUP':
      return false // groups are hit through their children
    case 'BOOLEAN': {
      const rings = booleanRings(scene, node)
      if (rings.length === 0) return false
      if (hasFill && pointInPolygonRings(p, rings, true)) return true
      return ringsMinDist(p, rings, true) <= strokeTol
    }
    case 'POLYGON':
    case 'STAR':
    case 'VECTOR': {
      const subpaths = nodeOutline(node)
      const closedRings = subpaths.filter((sp) => sp.closed).map((sp) => flattenSubPath(sp, 0.5))
      const openRings = subpaths.filter((sp) => !sp.closed).map((sp) => flattenSubPath(sp, 0.5))
      if (hasFill && closedRings.length > 0) {
        const evenOdd = node.type === 'VECTOR' && node.windingRule === 'EVENODD'
        if (pointInPolygonRings(p, closedRings, evenOdd)) return true
      }
      if (closedRings.length > 0 && ringsMinDist(p, closedRings, true) <= strokeTol) return true
      if (openRings.length > 0 && ringsMinDist(p, openRings, false) <= strokeTol) return true
      return false
    }
  }
}

function eligible(scene: SceneGraph, id: NodeId, opts: HitOptions): boolean {
  if (opts.exclude?.has(id)) return false
  const node = scene.getNode(id)
  if (!node) return false
  if (!opts.includeLocked && node.locked) return false
  // Ancestor lock also blocks interaction.
  if (!opts.includeLocked) {
    for (const aid of scene.ancestors(id)) {
      const a = scene.getNode(aid)
      if (a?.locked) return false
    }
  }
  return true
}

/** True when any ancestor of the node is an INSTANCE (structurally locked). */
export function isInsideInstance(scene: SceneGraph, id: NodeId): boolean {
  return nearestInstanceAncestor(scene, id) !== null
}

/** The closest INSTANCE ancestor of a node, or null. */
export function nearestInstanceAncestor(scene: SceneGraph, id: NodeId): NodeId | null {
  for (const aid of scene.ancestors(id)) {
    if (scene.getNode(aid)?.type === 'INSTANCE') return aid
  }
  return null
}

/** All nodes under a world point, topmost first. */
export function hitTestAll(scene: SceneGraph, index: SpatialIndex, worldPt: Vec2, opts: HitOptions): NodeId[] {
  index.sync(scene)
  const tolWorld = opts.tolerancePx / Math.max(opts.zoom, 1e-6)
  const candidates = index.searchPoint(worldPt.x, worldPt.y, tolWorld)
  const rank = scene.zRank()
  const hits = candidates
    .filter((id) => eligible(scene, id, opts))
    .filter((id) => preciseHit(scene, id, worldPt, tolWorld))
  hits.sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0))
  return hits
}

/** Topmost hit under a world point. */
export function hitTest(scene: SceneGraph, index: SpatialIndex, worldPt: Vec2, opts: HitOptions): NodeId | null {
  return hitTestAll(scene, index, worldPt, opts)[0] ?? null
}

/**
 * Figma-style click resolution: return the top-level ancestor of the deepest
 * hit (or a child of `container` when drilling inside it).
 */
export function resolveClickTarget(
  scene: SceneGraph,
  deepest: NodeId,
  container: NodeId | null,
): NodeId {
  if (container === null) return scene.topLevelAncestor(deepest)
  // Walk up from the deepest hit until the direct child of `container`.
  let cur = deepest
  for (;;) {
    const p = scene.parentOf(cur)
    if (p === null) return cur
    if (p === container) return cur
    cur = p
  }
}

/** Top-level (root-child) nodes whose AABB intersects the marquee rect. */
export function nodesInRect(scene: SceneGraph, index: SpatialIndex, rect: AABB, opts: HitOptions): NodeId[] {
  index.sync(scene)
  const ids = index.search(rect)
  const topLevel = new Set<NodeId>()
  for (const id of ids) {
    if (!eligible(scene, id, opts)) continue
    topLevel.add(scene.topLevelAncestor(id))
  }
  // Frames are only marquee-selected when fully enclosed (Figma behavior);
  // other nodes select on intersection.
  const out: NodeId[] = []
  for (const id of topLevel) {
    const node = scene.getNode(id)
    if (!node) continue
    const box = scene.worldAABB(id)
    if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      if (aabbContainsAABB(rect, box)) out.push(id)
      else {
        // Otherwise select enclosed/intersecting children of the frame.
        for (const cid of node.children) {
          const c = scene.getNode(cid)
          if (!c || !eligible(scene, cid, opts)) continue
          if (aabbIntersects(rect, scene.worldAABB(cid))) out.push(cid)
        }
      }
    } else if (aabbIntersects(rect, box)) {
      out.push(id)
    }
  }
  return out
}

/**
 * Topmost frame (or component) containing a world point — the drop target
 * when drawing/pasting/dragging nodes. Instances are structurally locked and
 * never accept drops. Excludes `exclude` subtrees.
 */
export function findDropFrame(scene: SceneGraph, index: SpatialIndex, worldPt: Vec2, exclude?: Set<NodeId>): NodeId | null {
  index.sync(scene)
  const rank = scene.zRank()
  const candidates = index
    .searchPoint(worldPt.x, worldPt.y, 0)
    .filter((id) => {
      const node = scene.getNode(id)
      if (!node || (node.type !== 'FRAME' && node.type !== 'COMPONENT') || node.locked) return false
      if (isInsideInstance(scene, id)) return false
      if (exclude?.has(id)) return false
      if (exclude && [...exclude].some((e) => scene.isAncestorOf(e, id) || e === id)) return false
      const inv = matInvert(scene.worldMatrix(id))
      const p = applyMat(inv, worldPt)
      return p.x >= 0 && p.y >= 0 && p.x <= node.width && p.y <= node.height
    })
  candidates.sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0))
  return candidates[0] ?? null
}
