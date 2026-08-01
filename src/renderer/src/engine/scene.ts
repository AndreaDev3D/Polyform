// SceneGraph: the single mutable document store. Lives outside React; UI
// subscribes to a version counter (see state/document.ts). API mirrors what
// the future Rust/WASM core will expose.

import type { NodeId, Page, PolyformDocument, SceneNode } from './types'
import { SCHEMA_VERSION, createPage, emptyStyles, isContainer, isFrameLike } from './types'
import type { AABB, Mat } from './geometry'
import {
  IDENTITY,
  aabbExpand,
  aabbIsEmpty,
  aabbOfPoints,
  aabbUnion,
  applyMat,
  emptyAABB,
  matMultiply,
  nodeLocalMatrix,
  transformedRectAABB,
} from './geometry'
import { flattenSubPath, nodeOutline } from './shapes'

export class SceneGraph {
  doc: PolyformDocument
  version = 0
  private parents = new Map<NodeId, NodeId | null>()
  private aabbCache = new Map<NodeId, AABB>()
  private matrixCache = new Map<NodeId, Mat>()
  private renderOrderCache: NodeId[] | null = null
  private zRankCache: Map<NodeId, number> | null = null

  constructor(doc?: PolyformDocument) {
    if (doc) {
      this.doc = doc
    } else {
      const page = createPage('Page 1')
      this.doc = {
        schemaVersion: SCHEMA_VERSION,
        nodes: {},
        pages: [page],
        activePageId: page.id,
        styles: emptyStyles(),
      }
    }
    this.rebuildParents()
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  isPage(id: string): boolean {
    return this.doc.pages.some((p) => p.id === id)
  }

  getPage(id: string): Page | undefined {
    return this.doc.pages.find((p) => p.id === id)
  }

  get activePage(): Page {
    const page = this.getPage(this.doc.activePageId) ?? this.doc.pages[0]
    if (!page) throw new Error('Document has no pages')
    return page
  }

  /** Root z-order of the ACTIVE page, bottom to top. */
  rootIds(): NodeId[] {
    return this.activePage.rootIds
  }

  /** View-state change (not undoable). */
  setActivePage(id: string): void {
    if (!this.isPage(id) || this.doc.activePageId === id) return
    this.doc.activePageId = id
    this.bump()
  }

  loadDocument(doc: PolyformDocument): void {
    this.doc = doc
    this.rebuildParents()
    this.bump()
  }

  bump(): void {
    this.version++
    this.aabbCache.clear()
    this.matrixCache.clear()
    this.renderOrderCache = null
    this.zRankCache = null
  }

  private rebuildParents(): void {
    this.parents.clear()
    for (const page of this.doc.pages) {
      for (const id of page.rootIds) this.parents.set(id, page.id)
    }
    for (const node of Object.values(this.doc.nodes)) {
      if (isContainer(node)) {
        for (const cid of node.children) this.parents.set(cid, node.id)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getNode(id: NodeId): SceneNode | undefined {
    return this.doc.nodes[id]
  }

  requireNode(id: NodeId): SceneNode {
    const n = this.doc.nodes[id]
    if (!n) throw new Error(`Node not found: ${id}`)
    return n
  }

  hasNode(id: NodeId): boolean {
    return id in this.doc.nodes
  }

  /** Parent node id, or a PAGE id for page roots (check with isPage). */
  parentOf(id: NodeId): NodeId | null {
    return this.parents.get(id) ?? null
  }

  /**
   * The mutable child-id array for a parent. Accepts a node id, a page id,
   * or null (= the active page, kept for v0.1 journal compatibility).
   */
  childListOf(parentId: NodeId | null): NodeId[] {
    if (parentId === null) return this.activePage.rootIds
    const page = this.getPage(parentId)
    if (page) return page.rootIds
    const p = this.requireNode(parentId)
    if (!isContainer(p)) throw new Error(`Not a container: ${parentId}`)
    return p.children
  }

  indexInParent(id: NodeId): number {
    return this.childListOf(this.parentOf(id)).indexOf(id)
  }

  /** Pre-order descendants (excluding the node itself). */
  descendants(id: NodeId): NodeId[] {
    const out: NodeId[] = []
    const walk = (nid: NodeId) => {
      const n = this.getNode(nid)
      if (n && isContainer(n)) {
        for (const cid of n.children) {
          out.push(cid)
          walk(cid)
        }
      }
    }
    walk(id)
    return out
  }

  /** All ancestor NODE ids from the direct parent up to a page root. */
  ancestors(id: NodeId): NodeId[] {
    const out: NodeId[] = []
    let cur = this.parentOf(id)
    while (cur !== null && !this.isPage(cur)) {
      out.push(cur)
      cur = this.parentOf(cur)
    }
    return out
  }

  isAncestorOf(maybeAncestor: NodeId, id: NodeId): boolean {
    let cur = this.parentOf(id)
    while (cur !== null && !this.isPage(cur)) {
      if (cur === maybeAncestor) return true
      cur = this.parentOf(cur)
    }
    return false
  }

  /** The page-root-level ancestor of a node (the node itself if at root). */
  topLevelAncestor(id: NodeId): NodeId {
    let cur = id
    for (;;) {
      const p = this.parentOf(cur)
      if (p === null || this.isPage(p)) return cur
      cur = p
    }
  }

  // -------------------------------------------------------------------------
  // Mutations (low-level; used by the command system only)
  // -------------------------------------------------------------------------

  addNode(node: SceneNode, parentId: NodeId | null, index: number): void {
    if (this.doc.nodes[node.id]) throw new Error(`Duplicate node id: ${node.id}`)
    this.doc.nodes[node.id] = node
    const resolvedParent = parentId ?? this.activePage.id
    const list = this.childListOf(resolvedParent)
    const i = Math.max(0, Math.min(index, list.length))
    list.splice(i, 0, node.id)
    this.parents.set(node.id, resolvedParent)
    // A container may arrive with children already registered (subtree adds
    // register parents when each child op runs); nothing else to do here.
    if (isContainer(node)) {
      for (const cid of node.children) this.parents.set(cid, node.id)
    }
    this.bump()
  }

  /** Detach a single node (its children ops must be handled by the caller). */
  removeNode(id: NodeId): void {
    const parentId = this.parentOf(id)
    const list = this.childListOf(parentId)
    const i = list.indexOf(id)
    if (i >= 0) list.splice(i, 1)
    delete this.doc.nodes[id]
    this.parents.delete(id)
    this.bump()
  }

  moveNode(id: NodeId, toParent: NodeId | null, toIndex: number): void {
    const fromParent = this.parentOf(id)
    const fromList = this.childListOf(fromParent)
    const fromIdx = fromList.indexOf(id)
    if (fromIdx >= 0) fromList.splice(fromIdx, 1)
    const resolvedTo = toParent ?? this.activePage.id
    const toList = this.childListOf(resolvedTo)
    const i = Math.max(0, Math.min(toIndex, toList.length))
    toList.splice(i, 0, id)
    this.parents.set(id, resolvedTo)
    this.bump()
  }

  updateNode(id: NodeId, patch: Partial<SceneNode>): void {
    const node = this.requireNode(id)
    Object.assign(node, patch)
    this.bump()
  }

  // -------------------------------------------------------------------------
  // Transforms & bounds
  // -------------------------------------------------------------------------

  localMatrix(node: SceneNode): Mat {
    return nodeLocalMatrix(node.x, node.y, node.width, node.height, node.rotation)
  }

  worldMatrix(id: NodeId): Mat {
    const cached = this.matrixCache.get(id)
    if (cached) return cached
    const node = this.getNode(id)
    if (!node) return IDENTITY
    const parentId = this.parentOf(id)
    const parentMat = parentId && !this.isPage(parentId) ? this.worldMatrix(parentId) : IDENTITY
    const m = matMultiply(parentMat, this.localMatrix(node))
    this.matrixCache.set(id, m)
    return m
  }

  /** Extra padding needed around geometry for strokes and effects. */
  nodePad(node: SceneNode): number {
    let pad = 0
    if (node.strokes.some((s) => s.visible)) {
      pad = node.strokeAlign === 'INSIDE' ? 0 : node.strokeAlign === 'CENTER' ? node.strokeWeight / 2 : node.strokeWeight
    }
    for (const fx of node.effects) {
      if (!fx.visible) continue
      if (fx.type === 'DROP_SHADOW') {
        pad = Math.max(pad, Math.abs(fx.offset.x) + fx.blur, Math.abs(fx.offset.y) + fx.blur)
      } else if (fx.type === 'LAYER_BLUR') {
        pad = Math.max(pad, fx.radius * 2)
      }
    }
    return pad
  }

  /** World-space AABB including descendants, strokes and effects. */
  worldAABB(id: NodeId): AABB {
    const cached = this.aabbCache.get(id)
    if (cached) return cached
    const node = this.getNode(id)
    if (!node) return emptyAABB()
    const m = this.worldMatrix(id)
    let box: AABB

    if (node.type === 'VECTOR') {
      const pts = nodeOutline(node).flatMap((sp) => flattenSubPath(sp, 1))
      const local = pts.length ? aabbOfPoints(pts) : { minX: 0, minY: 0, maxX: node.width, maxY: node.height }
      const pad = this.nodePad(node)
      box = aabbOfPoints([
        applyMat(m, { x: local.minX - pad, y: local.minY - pad }),
        applyMat(m, { x: local.maxX + pad, y: local.minY - pad }),
        applyMat(m, { x: local.maxX + pad, y: local.maxY + pad }),
        applyMat(m, { x: local.minX - pad, y: local.maxY + pad }),
      ])
    } else {
      const pad = this.nodePad(node)
      box = transformedRectAABB(m, node.width, node.height)
      box = aabbExpand(box, pad)
    }

    if (isContainer(node) && node.type !== 'BOOLEAN') {
      const clips = isFrameLike(node) && node.clipsContent
      if (!clips) {
        for (const cid of node.children) {
          const child = this.getNode(cid)
          if (!child || !child.visible) continue
          const cb = this.worldAABB(cid)
          if (!aabbIsEmpty(cb)) box = aabbUnion(box, cb)
        }
      }
    }
    this.aabbCache.set(id, box)
    return box
  }

  /** Union of all visible root subtrees on the ACTIVE page. */
  documentAABB(): AABB {
    let box = emptyAABB()
    for (const id of this.rootIds()) {
      const n = this.getNode(id)
      if (!n || !n.visible) continue
      const b = this.worldAABB(id)
      if (!aabbIsEmpty(b)) box = aabbIsEmpty(box) ? b : aabbUnion(box, b)
    }
    return box
  }

  // -------------------------------------------------------------------------
  // Z-order
  // -------------------------------------------------------------------------

  /**
   * Render order of the ACTIVE page: parents before children, roots bottom
   * -> top. BOOLEAN children are excluded (geometry sources, not layers).
   */
  renderOrder(): NodeId[] {
    if (this.renderOrderCache) return this.renderOrderCache
    const out: NodeId[] = []
    const walk = (id: NodeId) => {
      const n = this.getNode(id)
      if (!n) return
      out.push(id)
      if (isContainer(n) && n.type !== 'BOOLEAN') {
        for (const cid of n.children) walk(cid)
      }
    }
    for (const id of this.rootIds()) walk(id)
    this.renderOrderCache = out
    return out
  }

  zRank(): Map<NodeId, number> {
    if (this.zRankCache) return this.zRankCache
    const map = new Map<NodeId, number>()
    this.renderOrder().forEach((id, i) => map.set(id, i))
    this.zRankCache = map
    return map
  }
}
