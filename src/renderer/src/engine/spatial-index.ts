// R-tree spatial index over world-space AABBs for O(log n + k) hit-testing
// broad-phase and viewport culling (Technical-Specification §2.2).
//
// Dual backend behind one class (ADR-002): rbush (TS) or the rstar-based
// polyform-core WASM tree, chosen per rebuild by the 'spatial' engine flag.
// Both use inclusive edge-touch intersection; result order is unspecified
// API-wise (callers sort by z-rank or dedupe into sets) — the WASM path
// returns entries in scene-walk order, rbush in tree order.

import RBush from 'rbush'
import type { NodeId } from './types'
import { isContainer } from './types'
import type { SceneGraph } from './scene'
import type { AABB } from './geometry'
import { aabbIsEmpty } from './geometry'
import { poisonWasmEngine, useWasm, wasmHandle } from './backend'
import type { SpatialIndex as WasmTree } from './wasm/pkg/polyform_core'

interface IndexEntry {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: NodeId
}

export class SpatialIndex {
  private tree = new RBush<IndexEntry>()
  private wasmTree: WasmTree | null = null
  /** WASM entry index (= load order) -> node id. */
  private ids: NodeId[] = []
  private backend: 'ts' | 'wasm' = 'ts'
  private builtVersion = -1

  /** Rebuild (bulk-load) if the scene — or the backend flag — changed. */
  sync(scene: SceneGraph): void {
    const desired: 'ts' | 'wasm' = useWasm('spatial') ? 'wasm' : 'ts'
    if (this.builtVersion === scene.version && this.backend === desired) return
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

    this.backend = desired
    if (desired === 'wasm') {
      const boxes = new Float64Array(entries.length * 4)
      this.ids = new Array<NodeId>(entries.length)
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        boxes[i * 4] = e.minX
        boxes[i * 4 + 1] = e.minY
        boxes[i * 4 + 2] = e.maxX
        boxes[i * 4 + 3] = e.maxY
        this.ids[i] = e.id
      }
      if (!this.wasmTree) this.wasmTree = new (wasmHandle().SpatialIndex)()
      this.wasmTree.load(boxes)
      this.tree = new RBush<IndexEntry>()
    } else {
      this.tree = new RBush<IndexEntry>()
      this.tree.load(entries)
      this.ids = []
    }
    this.builtVersion = scene.version
  }

  search(box: AABB): NodeId[] {
    if (this.backend === 'wasm' && this.wasmTree) {
      try {
        const hits = this.wasmTree.search(box.minX, box.minY, box.maxX, box.maxY)
        const out: NodeId[] = new Array(hits.length)
        for (let i = 0; i < hits.length; i++) out[i] = this.ids[hits[i]]
        return out
      } catch (err) {
        // Engine poisoned elsewhere (or trapped here): next sync() rebuilds
        // on rbush; miss one query rather than throw into the render loop.
        poisonWasmEngine(err)
        this.builtVersion = -1
        return []
      }
    }
    return this.tree.search(box).map((e) => e.id)
  }

  searchPoint(x: number, y: number, pad = 0): NodeId[] {
    return this.search({ minX: x - pad, minY: y - pad, maxX: x + pad, maxY: y + pad })
  }
}
