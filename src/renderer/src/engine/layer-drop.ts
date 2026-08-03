// Where a layers-panel drag would land, and why it sometimes can't.
//
// Kept out of the panel because these are tree rules, not pointer plumbing:
// the caller supplies "which row am I over, and how far down it" and gets back
// the drop target plus what to draw. A refusal carries its reason as text, so
// the UI can say why nothing will happen instead of going quiet.

import type { NodeId } from './types'
import { isContainer } from './types'
import type { SceneGraph } from './scene'
import { isInsideInstance } from './hit-test'

export interface DropTarget {
  parentId: NodeId | null
  index: number
  /** Set when the drop nests INTO this container rather than beside it. */
  nestInto: NodeId | null
}

export interface DropPlacement {
  /** Null when the drop is impossible or meaningless. */
  target: DropTarget | null
  /** Which edge of the hovered row the insertion line belongs on. */
  side: 'top' | 'bottom' | null
  /** Human-readable reason the drop is refused, or null. */
  refuse: string | null
}

const NONE: DropPlacement = { target: null, side: null, refuse: null }

/**
 * Instance children are generated from the main component, so structural moves
 * in or out of one are locked. Returns why, or null when the move is allowed.
 */
export function instanceRefusal(
  scene: SceneGraph,
  ids: NodeId[],
  parentId: NodeId | null,
): string | null {
  if (ids.some((id) => isInsideInstance(scene, id))) {
    return 'Layers inside an instance can’t be moved'
  }
  if (parentId === null || scene.isPage(parentId)) return null
  if (scene.getNode(parentId)?.type === 'INSTANCE' || isInsideInstance(scene, parentId)) {
    return 'Can’t drop into an instance'
  }
  return null
}

/**
 * @param ratio Vertical position within the hovered row, 0 = top, 1 = bottom.
 *
 * The panel lists layers topmost-first (reverse z), so the top half of a row
 * means "in front of it" — a HIGHER index in the parent's child list.
 */
export function dropOnRow(
  scene: SceneGraph,
  ids: NodeId[],
  overId: NodeId,
  ratio: number,
): DropPlacement {
  // Hovering one of the rows being dragged: no target, and nothing worth
  // saying — where else would a layer be than where you picked it up.
  if (ids.includes(overId)) return NONE
  const node = scene.getNode(overId)
  if (!node) return NONE
  if (ids.some((d) => scene.isAncestorOf(d, overId))) {
    return { target: null, side: null, refuse: 'Can’t drop a layer inside itself' }
  }

  // The middle of a container nests; its edges still reorder, so a frame can
  // be moved past its neighbours without being swallowed by them.
  const target: DropTarget =
    isContainer(node) && ratio > 0.3 && ratio < 0.7
      ? { parentId: overId, index: node.children.length, nestInto: overId }
      : (() => {
          const parentId = scene.parentOf(overId)
          const overIndex = scene.childListOf(parentId).indexOf(overId)
          return { parentId, index: ratio <= 0.5 ? overIndex + 1 : overIndex, nestInto: null }
        })()

  const refuse = instanceRefusal(scene, ids, target.parentId)
  if (refuse) return { target: null, side: null, refuse }
  return {
    target,
    side: target.nestInto ? null : ratio <= 0.5 ? 'top' : 'bottom',
    refuse: null,
  }
}

/**
 * Dropping in the empty space past the last row: the back of the current
 * page's root list. Without it, pulling a layer out of a frame means finding a
 * gap between two other rows to aim at.
 */
export function dropAtEnd(scene: SceneGraph, ids: NodeId[]): DropPlacement {
  const parentId = scene.activePage.id
  const refuse = instanceRefusal(scene, ids, parentId)
  if (refuse) return { target: null, side: null, refuse }
  return { target: { parentId, index: 0, nestInto: null }, side: 'bottom', refuse: null }
}
