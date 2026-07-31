// The editor action layer: every user-facing command routes through here
// (menus, shortcuts, toolbar, context menu). Structural mutations use an
// OpRecorder: mutate the scene imperatively while recording reversible ops,
// then commit them as one history entry.

import type { BooleanOp, FrameNode, NodeId, SceneNode, Vec2 } from '../engine/types'
import { cloneNode, createNode, isContainer, newId } from '../engine/types'
import type { PatchOp, NodeBundle } from '../engine/commands'
import { extractBundle, makeUpdateOp, reIdBundle, removeSubtreeOps, undoOps } from '../engine/commands'
import { applyMat, matInvert, aabbIsEmpty, aabbUnion, emptyAABB, type AABB } from '../engine/geometry'
import { documentStore } from './document'
import { editor } from './editor'
import { assetCache } from '../engine/assets'
import { exportPng } from '../engine/export/png'
import { exportSvg } from '../engine/export/svg'
import { findDropFrame } from '../engine/hit-test'

// ---------------------------------------------------------------------------
// Op recorder: imperative mutation + reversible op capture in one pass
// ---------------------------------------------------------------------------

export class OpRecorder {
  ops: PatchOp[] = []
  private get scene() {
    return documentStore.scene
  }

  add(node: SceneNode, parentId: NodeId | null, index: number): void {
    const snapshot = cloneNode(node)
    if (isContainer(snapshot)) snapshot.children = []
    this.scene.addNode(node, parentId, index)
    this.ops.push({ kind: 'add', parentId, index, node: snapshot })
  }

  addBundle(bundle: NodeBundle, parentId: NodeId | null, baseIndex: number): void {
    bundle.rootIds.forEach((rid, i) => this.addSubtree(bundle, rid, parentId, baseIndex + i))
  }

  private addSubtree(bundle: NodeBundle, id: NodeId, parentId: NodeId | null, index: number): void {
    const node = bundle.nodes[id]
    if (!node) return
    const live = cloneNode(node)
    const childIds = isContainer(live) ? [...live.children] : []
    if (isContainer(live)) live.children = []
    this.add(live, parentId, index)
    childIds.forEach((cid, i) => this.addSubtree(bundle, cid, id, i))
  }

  removeSubtree(id: NodeId): void {
    const ops = removeSubtreeOps(this.scene, id)
    for (const op of ops) {
      if (op.kind === 'remove') this.scene.removeNode(op.node.id)
    }
    this.ops.push(...ops)
  }

  update(id: NodeId, patch: Record<string, unknown>): void {
    const node = this.scene.getNode(id)
    if (!node) return
    const op = makeUpdateOp(node, patch)
    this.scene.updateNode(id, patch as Partial<SceneNode>)
    this.ops.push(op)
  }

  move(id: NodeId, toParent: NodeId | null, toIndex: number): void {
    const fromParent = this.scene.parentOf(id)
    const fromIndex = this.scene.indexInParent(id)
    this.scene.moveNode(id, toParent, toIndex)
    this.ops.push({ kind: 'move', id, from: { parentId: fromParent, index: fromIndex }, to: { parentId: toParent, index: toIndex } })
  }

  commit(label: string): void {
    documentStore.commit(this.ops, label, true)
  }

  /** Roll back everything recorded so far (used on aborted interactions). */
  rollback(): void {
    undoOps(documentStore.scene, this.ops)
    this.ops = []
    documentStore.transient()
  }
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

export function selectedIds(): NodeId[] {
  return editor.get().selection.filter((id) => documentStore.scene.hasNode(id))
}

/** Selection minus nodes whose ancestor is also selected. */
export function topSelection(): NodeId[] {
  const scene = documentStore.scene
  const sel = new Set(selectedIds())
  return [...sel].filter((id) => ![...sel].some((other) => other !== id && scene.isAncestorOf(other, id)))
}

function byZ(ids: NodeId[]): NodeId[] {
  const rank = documentStore.scene.zRank()
  return [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
}

export function setSelection(ids: NodeId[]): void {
  editor.set({ selection: ids })
}

// ---------------------------------------------------------------------------
// Clipboard / duplicate / delete
// ---------------------------------------------------------------------------

let clipboard: NodeBundle | null = null

export function copySelection(): void {
  const ids = byZ(topSelection())
  if (ids.length === 0) return
  clipboard = extractBundle(documentStore.scene, ids)
}

export function paste(): void {
  if (!clipboard) return
  const scene = documentStore.scene
  const bundle = reIdBundle(clipboard, newId)
  for (const rid of bundle.rootIds) {
    const node = bundle.nodes[rid]
    node.x += 10
    node.y += 10
  }
  const rec = new OpRecorder()
  const parent = editor.get().enteredContainer
  const parentValid = parent && scene.hasNode(parent) ? parent : null
  const index = scene.childListOf(parentValid).length
  rec.addBundle(bundle, parentValid, index)
  rec.commit('Paste')
  setSelection(bundle.rootIds)
}

export function duplicateSelection(): void {
  copySelection()
  paste()
}

export function deleteSelection(): void {
  const ids = topSelection()
  if (ids.length === 0) return
  const rec = new OpRecorder()
  for (const id of byZ(ids).reverse()) rec.removeSubtree(id)
  rec.commit(ids.length === 1 ? 'Delete Layer' : `Delete ${ids.length} Layers`)
  setSelection([])
  editor.set({ hover: null, editingTextId: null })
}

export function selectAll(): void {
  const scene = documentStore.scene
  const container = editor.get().enteredContainer
  const list = container && scene.hasNode(container) ? scene.childListOf(container) : scene.doc.rootIds
  setSelection(list.filter((id) => !scene.getNode(id)?.locked))
}

// ---------------------------------------------------------------------------
// Grouping / framing / booleans
// ---------------------------------------------------------------------------

function selectionBoundsInParent(scene = documentStore.scene, ids: NodeId[], parentId: NodeId | null): AABB {
  // World AABB re-expressed in the parent's space (parents are assumed
  // unrotated along this chain for v0.1 grouping).
  let box = emptyAABB()
  for (const id of ids) {
    const b = scene.worldAABB(id)
    if (!aabbIsEmpty(b)) box = aabbIsEmpty(box) ? b : aabbUnion(box, b)
  }
  if (parentId) {
    const inv = matInvert(scene.worldMatrix(parentId))
    const p0 = applyMat(inv, { x: box.minX, y: box.minY })
    const p1 = applyMat(inv, { x: box.maxX, y: box.maxY })
    return { minX: Math.min(p0.x, p1.x), minY: Math.min(p0.y, p1.y), maxX: Math.max(p0.x, p1.x), maxY: Math.max(p0.y, p1.y) }
  }
  return box
}

/** Re-anchor a node's x/y when reparenting so its world center is preserved. */
function reanchorIntoParent(rec: OpRecorder, id: NodeId, newParent: NodeId | null): void {
  const scene = documentStore.scene
  const node = scene.requireNode(id)
  const worldCenter = applyMat(scene.worldMatrix(id), { x: node.width / 2, y: node.height / 2 })
  const targetInv = newParent ? matInvert(scene.worldMatrix(newParent)) : null
  const centerInTarget = targetInv ? applyMat(targetInv, worldCenter) : worldCenter
  rec.update(id, { x: centerInTarget.x - node.width / 2, y: centerInTarget.y - node.height / 2 })
}

function wrapSelection(kind: 'GROUP' | 'FRAME' | 'BOOLEAN', op?: BooleanOp): void {
  const scene = documentStore.scene
  const ids = byZ(topSelection())
  if (ids.length === 0) return
  if (kind !== 'FRAME' && ids.length < 2 && kind !== 'BOOLEAN') return

  const topId = ids[ids.length - 1]
  const parentId = scene.parentOf(topId)
  const sameParent = ids.every((id) => scene.parentOf(id) === parentId)
  const targetParent = sameParent ? parentId : null
  const bounds = selectionBoundsInParent(scene, ids, targetParent)

  const rec = new OpRecorder()
  const wrapper = createNode(kind, kind === 'GROUP' ? 'Group' : kind === 'FRAME' ? 'Frame' : (op ?? 'UNION').toLowerCase().replace(/^./, (c) => c.toUpperCase()))
  wrapper.x = bounds.minX
  wrapper.y = bounds.minY
  wrapper.width = Math.max(1, bounds.maxX - bounds.minX)
  wrapper.height = Math.max(1, bounds.maxY - bounds.minY)
  if (wrapper.type === 'FRAME') {
    wrapper.fills = []
    wrapper.clipsContent = false
  }
  if (wrapper.type === 'BOOLEAN') {
    wrapper.booleanOp = op ?? 'UNION'
    const bottom = scene.getNode(ids[0])
    wrapper.fills = bottom ? structuredClone(bottom.fills) : wrapper.fills
    wrapper.strokes = bottom ? structuredClone(bottom.strokes) : []
    wrapper.strokeWeight = bottom?.strokeWeight ?? 1
  }

  const insertIndex = sameParent && parentId !== undefined ? scene.indexInParent(topId) + 1 : scene.childListOf(targetParent).length
  rec.add(wrapper, targetParent, insertIndex)

  ids.forEach((id, i) => {
    reanchorPreMove.set(id, scene.worldMatrix(id))
    rec.move(id, wrapper.id, i)
    // Re-anchor: preserve world center inside the new wrapper.
    const node = scene.requireNode(id)
    const m = reanchorPreMove.get(id)!
    const worldCenter = applyMat(m, { x: node.width / 2, y: node.height / 2 })
    const inv = matInvert(scene.worldMatrix(wrapper.id))
    const c = applyMat(inv, worldCenter)
    rec.update(id, { x: c.x - node.width / 2, y: c.y - node.height / 2 })
    reanchorPreMove.delete(id)
  })

  rec.commit(kind === 'GROUP' ? 'Group Selection' : kind === 'FRAME' ? 'Frame Selection' : `Boolean ${op}`)
  setSelection([wrapper.id])
}

const reanchorPreMove = new Map<NodeId, ReturnType<typeof documentStore.scene.worldMatrix>>()

export function groupSelection(): void {
  wrapSelection('GROUP')
}

export function frameSelection(): void {
  wrapSelection('FRAME')
}

export function booleanSelection(op: BooleanOp): void {
  if (topSelection().length < 2) return
  wrapSelection('BOOLEAN', op)
}

export function ungroupSelection(): void {
  const scene = documentStore.scene
  const ids = topSelection().filter((id) => {
    const n = scene.getNode(id)
    return n && (n.type === 'GROUP' || n.type === 'BOOLEAN' || n.type === 'FRAME')
  })
  if (ids.length === 0) return
  const rec = new OpRecorder()
  const released: NodeId[] = []
  for (const id of ids) {
    const node = scene.requireNode(id) as SceneNode & { children: NodeId[] }
    const parentId = scene.parentOf(id)
    let index = scene.indexInParent(id)
    const children = [...node.children]
    for (const cid of children) {
      const child = scene.requireNode(cid)
      const worldCenter = applyMat(scene.worldMatrix(cid), { x: child.width / 2, y: child.height / 2 })
      const newRotation = child.rotation + node.rotation
      rec.move(cid, parentId, index++)
      const inv = parentId ? matInvert(scene.worldMatrix(parentId)) : null
      const c = inv ? applyMat(inv, worldCenter) : worldCenter
      rec.update(cid, { x: c.x - child.width / 2, y: c.y - child.height / 2, rotation: newRotation })
      released.push(cid)
    }
    rec.removeSubtree(id)
  }
  rec.commit('Ungroup')
  setSelection(released)
}

// ---------------------------------------------------------------------------
// Z-order
// ---------------------------------------------------------------------------

export function reorderSelection(mode: 'forward' | 'backward' | 'front' | 'back'): void {
  const scene = documentStore.scene
  const ids = byZ(topSelection())
  if (ids.length === 0) return
  const rec = new OpRecorder()
  const ordered = mode === 'forward' || mode === 'front' ? [...ids].reverse() : ids
  for (const id of ordered) {
    const parent = scene.parentOf(id)
    const list = scene.childListOf(parent)
    const idx = list.indexOf(id)
    let target = idx
    if (mode === 'forward') target = Math.min(list.length - 1, idx + 1)
    else if (mode === 'backward') target = Math.max(0, idx - 1)
    else if (mode === 'front') target = list.length - 1
    else target = 0
    if (target !== idx) rec.move(id, parent, target)
  }
  rec.commit('Reorder Layers')
}

// ---------------------------------------------------------------------------
// Align / distribute
// ---------------------------------------------------------------------------

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

export function alignSelection(kind: AlignKind): void {
  const scene = documentStore.scene
  const ids = topSelection()
  if (ids.length === 0) return
  let target: AABB
  if (ids.length === 1) {
    const parent = scene.parentOf(ids[0])
    if (!parent) return
    target = selectionBoundsInParent(scene, [parent], scene.parentOf(parent))
    const pNode = scene.requireNode(parent)
    target = { minX: 0, minY: 0, maxX: pNode.width, maxY: pNode.height }
    // Align within parent's local space.
    const rec = new OpRecorder()
    alignOne(rec, scene, ids[0], target, kind, true)
    rec.commit('Align')
    return
  }
  let box = emptyAABB()
  for (const id of ids) {
    const b = scene.worldAABB(id)
    if (!aabbIsEmpty(b)) box = aabbIsEmpty(box) ? b : aabbUnion(box, b)
  }
  const rec = new OpRecorder()
  for (const id of ids) alignOne(rec, scene, id, box, kind, false)
  rec.commit('Align')
}

function alignOne(
  rec: OpRecorder,
  scene: typeof documentStore.scene,
  id: NodeId,
  box: AABB,
  kind: AlignKind,
  boxIsParentLocal: boolean,
): void {
  const node = scene.requireNode(id)
  const b = boxIsParentLocal
    ? { minX: node.x, minY: node.y, maxX: node.x + node.width, maxY: node.y + node.height }
    : scene.worldAABB(id)
  let dx = 0
  let dy = 0
  if (kind === 'left') dx = box.minX - b.minX
  else if (kind === 'right') dx = box.maxX - b.maxX
  else if (kind === 'hcenter') dx = (box.minX + box.maxX) / 2 - (b.minX + b.maxX) / 2
  else if (kind === 'top') dy = box.minY - b.minY
  else if (kind === 'bottom') dy = box.maxY - b.maxY
  else if (kind === 'vcenter') dy = (box.minY + box.maxY) / 2 - (b.minY + b.maxY) / 2
  if (dx !== 0 || dy !== 0) rec.update(id, { x: node.x + dx, y: node.y + dy })
}

export function distributeSelection(axis: 'h' | 'v'): void {
  const scene = documentStore.scene
  const ids = topSelection()
  if (ids.length < 3) return
  const boxes = ids
    .map((id) => ({ id, box: scene.worldAABB(id) }))
    .filter((e) => !aabbIsEmpty(e.box))
  boxes.sort((a, b) => (axis === 'h' ? a.box.minX - b.box.minX : a.box.minY - b.box.minY))
  const first = boxes[0]
  const last = boxes[boxes.length - 1]
  const sizeSum = boxes.reduce((acc, e) => acc + (axis === 'h' ? e.box.maxX - e.box.minX : e.box.maxY - e.box.minY), 0)
  const span = axis === 'h' ? last.box.maxX - first.box.minX : last.box.maxY - first.box.minY
  const gap = (span - sizeSum) / (boxes.length - 1)
  const rec = new OpRecorder()
  let cursor = axis === 'h' ? first.box.maxX : first.box.maxY
  for (let i = 1; i < boxes.length - 1; i++) {
    const e = boxes[i]
    const node = scene.requireNode(e.id)
    const targetMin = cursor + gap
    const delta = axis === 'h' ? targetMin - e.box.minX : targetMin - e.box.minY
    if (Math.abs(delta) > 1e-6) {
      rec.update(e.id, axis === 'h' ? { x: node.x + delta } : { y: node.y + delta })
    }
    cursor = targetMin + (axis === 'h' ? e.box.maxX - e.box.minX : e.box.maxY - e.box.minY)
  }
  rec.commit('Distribute')
}

// ---------------------------------------------------------------------------
// Nudge
// ---------------------------------------------------------------------------

export function nudgeSelection(dx: number, dy: number): void {
  const scene = documentStore.scene
  const ids = topSelection()
  if (ids.length === 0) return
  const rec = new OpRecorder()
  for (const id of ids) {
    const node = scene.requireNode(id)
    rec.update(id, { x: node.x + dx, y: node.y + dy })
  }
  rec.commit('Nudge')
}

// ---------------------------------------------------------------------------
// Property application (inspector)
// ---------------------------------------------------------------------------

export function updateSelectedNodes(patchFor: (node: SceneNode) => Record<string, unknown> | null, label: string): void {
  const scene = documentStore.scene
  const ids = selectedIds()
  if (ids.length === 0) return
  const rec = new OpRecorder()
  for (const id of ids) {
    const node = scene.getNode(id)
    if (!node) continue
    const patch = patchFor(node)
    if (patch && Object.keys(patch).length > 0) rec.update(id, patch)
  }
  if (rec.ops.length > 0) rec.commit(label)
}

export function renameNode(id: NodeId, name: string): void {
  const rec = new OpRecorder()
  rec.update(id, { name })
  rec.commit('Rename Layer')
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export function zoomAt(screenPt: Vec2 | null, factor: number): void {
  const { camera, viewportSize } = editor.get()
  const pt = screenPt ?? { x: viewportSize.w / 2, y: viewportSize.h / 2 }
  const worldBefore = { x: pt.x / camera.zoom + camera.x, y: pt.y / camera.zoom + camera.y }
  const zoom = Math.max(0.02, Math.min(64, camera.zoom * factor))
  editor.set({ camera: { zoom, x: worldBefore.x - pt.x / zoom, y: worldBefore.y - pt.y / zoom } })
}

export function zoomActual(): void {
  const { camera, viewportSize } = editor.get()
  const cx = camera.x + viewportSize.w / (2 * camera.zoom)
  const cy = camera.y + viewportSize.h / (2 * camera.zoom)
  editor.set({ camera: { zoom: 1, x: cx - viewportSize.w / 2, y: cy - viewportSize.h / 2 } })
}

export function zoomToFit(): void {
  const { viewportSize } = editor.get()
  const box = documentStore.scene.documentAABB()
  if (aabbIsEmpty(box)) {
    editor.set({ camera: { x: -viewportSize.w / 2, y: -viewportSize.h / 2, zoom: 1 } })
    return
  }
  const margin = 60
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY
  const zoom = Math.max(0.02, Math.min(4, Math.min((viewportSize.w - margin * 2) / w, (viewportSize.h - margin * 2) / h)))
  editor.set({
    camera: {
      zoom,
      x: box.minX - (viewportSize.w / zoom - w) / 2,
      y: box.minY - (viewportSize.h / zoom - h) / 2,
    },
  })
}

// ---------------------------------------------------------------------------
// Project flows
// ---------------------------------------------------------------------------

function applyViewport(viewport: { zoom: number; pan_x: number; pan_y: number } | null): void {
  editor.set({
    selection: [],
    hover: null,
    editingTextId: null,
    enteredContainer: null,
    penDraft: null,
    hasProject: documentStore.projectInfo !== null,
  })
  if (viewport) {
    editor.set({ camera: { zoom: viewport.zoom || 1, x: viewport.pan_x || 0, y: viewport.pan_y || 0 } })
  }
}

export async function newProjectFlow(): Promise<void> {
  const viewport = await documentStore.newProject()
  if (viewport) applyViewport(viewport)
}

export async function openProjectFlow(path?: string): Promise<void> {
  const viewport = await documentStore.openProject(path)
  if (viewport) applyViewport(viewport)
}

function currentViewportState() {
  const { camera } = editor.get()
  return { zoom: camera.zoom, pan_x: camera.x, pan_y: camera.y }
}

export async function saveFlow(): Promise<boolean> {
  return documentStore.save(currentViewportState())
}

export async function saveAsFlow(): Promise<boolean> {
  return documentStore.saveAs(currentViewportState())
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export async function placeImages(): Promise<void> {
  const assets = await window.polyform.assetsImportDialog()
  if (!assets || assets.length === 0) return
  const scene = documentStore.scene
  const { camera, viewportSize } = editor.get()
  const centerWorld = {
    x: camera.x + viewportSize.w / (2 * camera.zoom),
    y: camera.y + viewportSize.h / (2 * camera.zoom),
  }
  const rec = new OpRecorder()
  const created: NodeId[] = []
  let offset = 0
  for (const asset of assets) {
    let w = 400
    let h = 300
    try {
      const bmp = await assetCache.primeFromBytes(asset.hash, asset.bytes, asset.mime)
      w = bmp.width
      h = bmp.height
    } catch {
      /* keep defaults */
    }
    // Scale down to fit 70% of the viewport.
    const maxW = (viewportSize.w / camera.zoom) * 0.7
    const maxH = (viewportSize.h / camera.zoom) * 0.7
    const scale = Math.min(1, maxW / w, maxH / h)
    w *= scale
    h *= scale
    const node = createNode('RECTANGLE', asset.fileName.replace(/\.[^.]+$/, ''))
    node.width = w
    node.height = h
    node.x = centerWorld.x - w / 2 + offset
    node.y = centerWorld.y - h / 2 + offset
    node.fills = [{ type: 'IMAGE', visible: true, opacity: 1, assetHash: asset.hash, scaleMode: 'FILL' }]
    const dropFrame = findDropFrame(scene, documentStore.index, { x: node.x + w / 2, y: node.y + h / 2 })
    if (dropFrame) {
      const inv = matInvert(scene.worldMatrix(dropFrame))
      const local = applyMat(inv, { x: node.x, y: node.y })
      node.x = local.x
      node.y = local.y
    }
    rec.add(node, dropFrame, scene.childListOf(dropFrame).length)
    created.push(node.id)
    offset += 24
  }
  rec.commit(assets.length === 1 ? 'Place Image' : `Place ${assets.length} Images`)
  setSelection(created)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportSelection(kind: 'png' | 'svg', scale = 1): Promise<void> {
  const scene = documentStore.scene
  let ids = topSelection()
  if (ids.length === 0) ids = scene.doc.rootIds.filter((id) => scene.getNode(id)?.visible)
  if (ids.length === 0) return
  const first = scene.getNode(ids[0])
  const baseName = (ids.length === 1 && first ? first.name : documentStore.projectInfo?.manifest.title || 'export')
    .replace(/[^\w\- ]+/g, '')
    .trim() || 'export'
  if (kind === 'png') {
    const bytes = await exportPng(scene, documentStore.index, ids, scale, assetCache, null)
    if (bytes) await window.polyform.exportSave(`${baseName}@${scale}x.png`, 'png', bytes)
  } else {
    const svg = await exportSvg(scene, ids, (hash) => window.polyform.assetsRead(hash))
    await window.polyform.exportSave(`${baseName}.svg`, 'svg', new TextEncoder().encode(svg))
  }
}

// ---------------------------------------------------------------------------
// Menu dispatch
// ---------------------------------------------------------------------------

export function dispatchMenuAction(id: string): void {
  switch (id) {
    case 'file.new':
      void newProjectFlow()
      break
    case 'file.open':
      void openProjectFlow()
      break
    case 'file.save':
      void saveFlow()
      break
    case 'file.saveAs':
      void saveAsFlow()
      break
    case 'file.placeImage':
      void placeImages()
      break
    case 'file.exportPng':
      void exportSelection('png', 2)
      break
    case 'file.exportSvg':
      void exportSelection('svg')
      break
    case 'edit.undo':
      documentStore.undo()
      break
    case 'edit.redo':
      documentStore.redo()
      break
    case 'edit.copy':
      copySelection()
      break
    case 'edit.paste':
      paste()
      break
    case 'edit.duplicate':
      duplicateSelection()
      break
    case 'edit.delete':
      deleteSelection()
      break
    case 'edit.selectAll':
      selectAll()
      break
    case 'view.zoomIn':
      zoomAt(null, 1.25)
      break
    case 'view.zoomOut':
      zoomAt(null, 0.8)
      break
    case 'view.zoomFit':
      zoomToFit()
      break
    case 'view.zoomActual':
      zoomActual()
      break
    case 'view.toggleGrid':
      editor.set({ showGrid: !editor.get().showGrid })
      break
    case 'object.group':
      groupSelection()
      break
    case 'object.ungroup':
      ungroupSelection()
      break
    case 'object.frameSelection':
      frameSelection()
      break
    case 'object.bringForward':
      reorderSelection('forward')
      break
    case 'object.sendBackward':
      reorderSelection('backward')
      break
    case 'object.bringToFront':
      reorderSelection('front')
      break
    case 'object.sendToBack':
      reorderSelection('back')
      break
    case 'object.union':
      booleanSelection('UNION')
      break
    case 'object.subtract':
      booleanSelection('SUBTRACT')
      break
    case 'object.intersect':
      booleanSelection('INTERSECT')
      break
    case 'object.exclude':
      booleanSelection('EXCLUDE')
      break
    case 'help.about':
      window.alert('Polyform 0.1.0 — a local-first, open-source vector design tool.\nhttps://github.com/polyform/polyform')
      break
  }
}
