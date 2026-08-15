// Which rows of the layer tree are folded shut.
//
// The panel holds a set of collapsed container ids and these are the answers it
// can replace that set with. They live here rather than in the panel because
// "Expand Selected" is reachable from the object's context menu as well, and a
// command that can be given from two places must not be implemented in one of
// them — the same reason the drop rules live in engine/layer-drop.

import type { SceneGraph } from './scene'
import { isContainer, type NodeId } from './types'

/** Every container on the active page, folded shut. */
export function collapseAll(scene: SceneGraph): Set<NodeId> {
  const out = new Set<NodeId>()
  const walk = (ids: NodeId[]): void => {
    for (const id of ids) {
      const node = scene.getNode(id)
      if (!node || !isContainer(node)) continue
      out.add(id)
      walk(node.children)
    }
  }
  walk(scene.rootIds())
  return out
}

/**
 * The selected layers, open and reachable.
 *
 * Three things are unfolded, and leaving out any one of them makes the command
 * look broken:
 *
 *   * the ANCESTORS, because a row inside a collapsed group is not merely shut,
 *     it is absent from the list — opening the node alone would scroll to
 *     nothing. This is the case the command exists for: collapse all, then open
 *     the one you want.
 *   * the node itself.
 *   * its whole SUBTREE, because "expand this" means "show me what is in it";
 *     one level at a time is the clicking the command replaces.
 *
 * Nothing is folded shut here, so expanding two selected layers in turn keeps
 * both open.
 */
export function expandSelected(
  scene: SceneGraph,
  collapsed: ReadonlySet<NodeId>,
  selection: readonly NodeId[],
): Set<NodeId> {
  const next = new Set(collapsed)
  for (const id of selection) {
    if (!scene.hasNode(id)) continue
    for (const a of scene.ancestors(id)) next.delete(a)
    next.delete(id)
    for (const d of scene.descendants(id)) next.delete(d)
  }
  return next
}
