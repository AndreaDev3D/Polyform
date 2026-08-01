// R-tree spatial index (rbush) over world-space AABBs for O(log n + k)
// hit-testing broad-phase and viewport culling (Technical-Specification §2.2).

import RBush from 'rbush'
import type { NodeId } from './types'
import { isContainer } from './types'
import type { SceneGraph } from './scene'
import type { AABB } from './geometry'
import { aabbIsEmpty } from './geometry'

interface IndexEntry {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: NodeId
}

export class SpatialIndex {
  private tree = new RBush<IndexEntry>()
  private builtVersion = -1

  /** Rebuild (bulk-load) if the scene changed since the last build. */
  sync(scene: SceneGraph): void {
    if (this.builtVersion === scene.version) return
    const entries: IndexEntry[] = []
    const walk = (id: NodeId, parentVisible: boolean) => {
      const node = scene.getNode(id)
      if (!node) return
      const visible = parentVisible && node.visible
      if (!visible) return
      const box = scene.worldAABB(id)
      if (!aabbIsEmpty(box)) {
        entries.push({ minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, id })
      }
      if (isContainer(node) && node.type !== 'BOOLEAN') {
        for (const cid of node.children) walk(cid, visible)
      }
    }
    for (const id of scene.rootIds()) walk(id, true)
    this.tree = new RBush<IndexEntry>()
    this.tree.load(entries)
    this.builtVersion = scene.version
  }

  search(box: AABB): NodeId[] {
    return this.tree.search(box).map((e) => e.id)
  }

  searchPoint(x: number, y: number, pad = 0): NodeId[] {
    return this.search({ minX: x - pad, minY: y - pad, maxX: x + pad, maxY: y + pad })
  }
}
