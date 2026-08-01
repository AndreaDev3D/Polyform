// Smart-guide snapping: aligns moving/resizing bounds to sibling edges and
// centers (and the parent frame), producing red guide lines for the overlay.

import type { NodeId } from '../engine/types'
import type { SceneGraph } from '../engine/scene'
import type { AABB } from '../engine/geometry'
import { aabbIsEmpty } from '../engine/geometry'
import type { SnapGuide } from '../engine/render/overlays'

const THRESHOLD_PX = 6

interface SnapCandidate {
  value: number
  box: AABB
}

function edgesOf(box: AABB, axis: 'x' | 'y'): number[] {
  return axis === 'x'
    ? [box.minX, (box.minX + box.maxX) / 2, box.maxX]
    : [box.minY, (box.minY + box.maxY) / 2, box.maxY]
}

function overlaps(a: AABB, b: AABB, axis: 'x' | 'y'): boolean {
  return axis === 'x'
    ? a.minY <= b.maxY && a.maxY >= b.minY // horizontal neighbours share Y range
    : a.minX <= b.maxX && a.maxX >= b.minX
}

/**
 * Equal-spacing correction: find neighbours left/right (or above/below) of
 * the moving box and snap so that both gaps are equal.
 */
function spacingSnap(
  candidates: AABB[],
  box: AABB,
  axis: 'x' | 'y',
  threshold: number,
): { delta: number; cand: SnapCandidate } | null {
  const lo = axis === 'x' ? box.minX : box.minY
  const hi = axis === 'x' ? box.maxX : box.maxY
  const size = hi - lo
  let left: AABB | null = null
  let right: AABB | null = null
  for (const c of candidates) {
    if (!overlaps(c, box, axis)) continue
    const cLo = axis === 'x' ? c.minX : c.minY
    const cHi = axis === 'x' ? c.maxX : c.maxY
    if (cHi <= lo && (!left || cHi > (axis === 'x' ? left.maxX : left.maxY))) left = c
    if (cLo >= hi && (!right || cLo < (axis === 'x' ? right.minX : right.minY))) right = c
  }
  if (!left || !right) return null
  const leftEdge = axis === 'x' ? left.maxX : left.maxY
  const rightEdge = axis === 'x' ? right.minX : right.minY
  const targetLo = leftEdge + (rightEdge - leftEdge - size) / 2
  const delta = targetLo - lo
  if (Math.abs(delta) > threshold) return null
  return {
    delta,
    cand: {
      value: axis === 'x' ? targetLo : targetLo,
      box: {
        minX: axis === 'x' ? leftEdge : Math.min(left.minX, right.minX),
        maxX: axis === 'x' ? rightEdge : Math.max(left.maxX, right.maxX),
        minY: axis === 'y' ? leftEdge : Math.min(left.minY, right.minY),
        maxY: axis === 'y' ? rightEdge : Math.max(left.maxY, right.maxY),
      },
    },
  }
}

export interface SnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

/**
 * Given the proposed world box of the moving selection, return a correction
 * delta that snaps it to nearby sibling/parent edges plus guide lines.
 */
export function snapBox(
  scene: SceneGraph,
  movingIds: Set<NodeId>,
  box: AABB,
  zoom: number,
  disabled = false,
): SnapResult {
  if (disabled) return { dx: 0, dy: 0, guides: [] }
  const threshold = THRESHOLD_PX / Math.max(zoom, 1e-6)

  // Candidate set: siblings of the first moving node + parent frame bounds.
  const first = [...movingIds][0]
  if (!first || !scene.hasNode(first)) return { dx: 0, dy: 0, guides: [] }
  const parentId = scene.parentOf(first)
  const siblingIds = scene
    .childListOf(parentId)
    .filter((id) => !movingIds.has(id) && scene.getNode(id)?.visible)
  const candidates: AABB[] = siblingIds.map((id) => scene.worldAABB(id)).filter((b) => !aabbIsEmpty(b))
  if (parentId) {
    const pb = scene.worldAABB(parentId)
    if (!aabbIsEmpty(pb)) candidates.push(pb)
  }
  if (candidates.length === 0) return { dx: 0, dy: 0, guides: [] }

  let bestDx: { delta: number; cand: SnapCandidate } | null = null
  let bestDy: { delta: number; cand: SnapCandidate } | null = null

  for (const cand of candidates) {
    for (const cx of edgesOf(cand, 'x')) {
      for (const mx of edgesOf(box, 'x')) {
        const delta = cx - mx
        if (Math.abs(delta) <= threshold && (!bestDx || Math.abs(delta) < Math.abs(bestDx.delta))) {
          bestDx = { delta, cand: { value: cx, box: cand } }
        }
      }
    }
    for (const cy of edgesOf(cand, 'y')) {
      for (const my of edgesOf(box, 'y')) {
        const delta = cy - my
        if (Math.abs(delta) <= threshold && (!bestDy || Math.abs(delta) < Math.abs(bestDy.delta))) {
          bestDy = { delta, cand: { value: cy, box: cand } }
        }
      }
    }
  }

  // User guides on the active page snap like infinite edges.
  for (const g of scene.activePage.guides) {
    if (g.axis === 'x') {
      for (const mx of edgesOf(box, 'x')) {
        const delta = g.pos - mx
        if (Math.abs(delta) <= threshold && (!bestDx || Math.abs(delta) < Math.abs(bestDx.delta))) {
          bestDx = { delta, cand: { value: g.pos, box: { minX: g.pos, maxX: g.pos, minY: box.minY, maxY: box.maxY } } }
        }
      }
    } else {
      for (const my of edgesOf(box, 'y')) {
        const delta = g.pos - my
        if (Math.abs(delta) <= threshold && (!bestDy || Math.abs(delta) < Math.abs(bestDy.delta))) {
          bestDy = { delta, cand: { value: g.pos, box: { minX: box.minX, maxX: box.maxX, minY: g.pos, maxY: g.pos } } }
        }
      }
    }
  }

  // Equal-spacing snap: when the moving box sits between two candidates on
  // an axis, prefer the position where both gaps match.
  if (!bestDx) {
    const spacing = spacingSnap(candidates, box, 'x', threshold)
    if (spacing) bestDx = spacing
  }
  if (!bestDy) {
    const spacing = spacingSnap(candidates, box, 'y', threshold)
    if (spacing) bestDy = spacing
  }

  const guides: SnapGuide[] = []
  if (bestDx) {
    guides.push({
      axis: 'x',
      pos: bestDx.cand.value,
      from: Math.min(box.minY + (bestDy?.delta ?? 0), bestDx.cand.box.minY),
      to: Math.max(box.maxY + (bestDy?.delta ?? 0), bestDx.cand.box.maxY),
    })
  }
  if (bestDy) {
    guides.push({
      axis: 'y',
      pos: bestDy.cand.value,
      from: Math.min(box.minX + (bestDx?.delta ?? 0), bestDy.cand.box.minX),
      to: Math.max(box.maxX + (bestDx?.delta ?? 0), bestDy.cand.box.maxX),
    })
  }
  return { dx: bestDx?.delta ?? 0, dy: bestDy?.delta ?? 0, guides }
}
