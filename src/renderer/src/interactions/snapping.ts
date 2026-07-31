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
