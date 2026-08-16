// The editor action layer: every user-facing command routes through here
// (menus, shortcuts, toolbar, context menu). Structural mutations use an
// OpRecorder: mutate the scene imperatively while recording reversible ops,
// then commit them as one history entry.

import type {
  BooleanOp,
  DocumentStyles,
  Effect,
  FrameNode,
  Model3dFormat,
  Model3dNode,
  NodeId,
  Page,
  Paint,
  SceneNode,
  TextNode,
  RGBA,
  TextStyleProps,
  Vec2,
  VectorNetwork,
} from '../engine/types'
import { cloneNode, createNode, createPage, isContainer, newId } from '../engine/types'
import type { PatchOp, NodeBundle } from '../engine/commands'
import { applyOp, extractBundle, makeUpdateOp, reIdBundle, removeSubtreeOps, undoOps } from '../engine/commands'
import { constrainFrameChildren, type ChildRect } from '../engine/constraints'
import { applyMat, matInvert, matMultiply, aabbIsEmpty, aabbUnion, emptyAABB, type AABB } from '../engine/geometry'
import { MIN_ZOOM, clampZoom } from '../engine/zoom'
import { documentStore } from './document'
import { editor } from './editor'
import { assetCache } from '../engine/assets'
import { exportPng } from '../engine/export/png'
import { exportSvg } from '../engine/export/svg'
import { findDropFrame, isInsideInstance, nearestInstanceAncestor } from '../engine/hit-test'
import { hasClosedGeometry } from '../engine/paintbox'
import { applyColorToUses, type ColorUse } from '../engine/selection-colors'
import { collapseAll, expandSelected } from '../engine/layer-collapse'
import { bridgeVertices, joinVertices, weldLooseEnds } from '../engine/vector-connect'
import { dissolveEdges, dissolveParts } from '../engine/vector-dissolve'
import { networkParts } from '../engine/vector-parts'
import { partAtPoint, withPartFill } from '../engine/vector-paint'
import { importSvgDocument } from '../engine/import/svg-import'
import { describeFigReport, mapFigDocument } from '../engine/import/fig/map'
import { nodeOutline, type SubPath } from '../engine/shapes'
import { booleanRings } from '../engine/booleans'
import {
  anchorNetworkAtOrigin,
  networkBounds,
  carveWinding,
  normalizeWinding,
  ringsToSubPaths,
  subPathsToNetwork,
  transformSubPath,
} from '../engine/flatten'
import { listComponents } from '../engine/components'
import { SceneGraph } from '../engine/scene'
import { decodeScene } from '../engine/serialization'
import { pointerWorld } from './pointer'
import { CLIP_MARKER } from '../../../shared/types'

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

  /**
   * `roots` defaults to the whole bundle. Pass a subset to place part of it
   * somewhere of its own — a `.fig` import puts each Figma page's roots on its own
   * Polyform page, from one bundle, in one commit.
   */
  addBundle(bundle: NodeBundle, parentId: NodeId | null, baseIndex: number, roots = bundle.rootIds): void {
    roots.forEach((rid, i) => this.addSubtree(bundle, rid, parentId, baseIndex + i))
  }

  /** A new page, in the same undo step as whatever is about to go onto it. */
  addPage(page: Page, index: number): void {
    this.scene.doc.pages.splice(Math.min(index, this.scene.doc.pages.length), 0, page)
    this.ops.push({ kind: 'page-add', index, page: { ...page, rootIds: [] } })
  }

  renamePage(pageId: string, after: string): void {
    const page = this.scene.getPage(pageId)
    if (!page || page.name === after) return
    const before = page.name
    page.name = after
    this.ops.push({ kind: 'page-rename', pageId, before, after })
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

  /**
   * Re-capture the node state inside recorded `add` ops. Needed when a node
   * is mutated after being added but before the recorder commits (shape
   * drawing) — otherwise redo would recreate the stale creation snapshot.
   */
  refreshAddSnapshots(): void {
    for (const op of this.ops) {
      if (op.kind !== 'add') continue
      const live = this.scene.getNode(op.node.id)
      if (!live) continue
      const snapshot = cloneNode(live)
      if (isContainer(snapshot)) snapshot.children = []
      op.node = snapshot
    }
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

/**
 * Say something on the status bar for a few seconds. The app had no way to
 * explain a refusal, so a command that declined to run just looked broken.
 */
let statusTimer: ReturnType<typeof setTimeout> | null = null
export function setStatus(text: string | null): void {
  editor.set({ status: text })
  if (statusTimer) clearTimeout(statusTimer)
  if (!text) return
  statusTimer = setTimeout(() => {
    if (editor.get().status === text) editor.set({ status: null })
  }, 4500)
}

export function copySelection(): void {
  const ids = byZ(topSelection())
  if (ids.length === 0) return
  clipboard = extractBundle(documentStore.scene, ids)
  // Claim the system clipboard. The layers stay here — they mean nothing to
  // another application — but this is not bookkeeping: WRITING clears whatever
  // was on the clipboard, which is the only way paste can tell that the image
  // someone copied in a browser ten minutes ago is no longer the newest thing.
  // Without it, copying layers and pressing Ctrl+V would paste that image.
  void window.polyform.clipboardWriteMarker(`${CLIP_MARKER}${newId()}`)
}

/**
 * Where a paste lands: on the pointer, or in the middle of the view.
 *
 * Pasting at the pointer is what every editor does and what makes Ctrl+V a
 * placement rather than a lucky dip — but only while there IS a pointer on the
 * canvas. Triggered from the menu, or with the mouse parked over the inspector,
 * the honest answer is the centre of what you are looking at.
 */
function pasteAnchor(): Vec2 {
  const at = pointerWorld()
  if (at) return at
  const { camera, viewportSize } = editor.get()
  return {
    x: camera.x + viewportSize.w / (2 * camera.zoom),
    y: camera.y + viewportSize.h / (2 * camera.zoom),
  }
}

function insertBundleCopy(source: NodeBundle, label: string, at: Vec2 | null): void {
  const scene = documentStore.scene
  const bundle = reIdBundle(source, newId)
  if (at) {
    // Centre the whole bundle on the point, not each root on it: a copied group
    // of shapes has to arrive in the arrangement it left in.
    let box = emptyAABB()
    for (const rid of bundle.rootIds) {
      const n = bundle.nodes[rid]
      const b = { minX: n.x, minY: n.y, maxX: n.x + n.width, maxY: n.y + n.height }
      box = aabbIsEmpty(box) ? b : aabbUnion(box, b)
    }
    const dx = at.x - (box.minX + box.maxX) / 2
    const dy = at.y - (box.minY + box.maxY) / 2
    for (const rid of bundle.rootIds) {
      bundle.nodes[rid].x += dx
      bundle.nodes[rid].y += dy
    }
  } else {
    for (const rid of bundle.rootIds) {
      bundle.nodes[rid].x += 10
      bundle.nodes[rid].y += 10
    }
  }
  const rec = new OpRecorder()
  const parent = editor.get().enteredContainer
  const parentValid = parent && scene.hasNode(parent) ? parent : null
  const index = scene.childListOf(parentValid).length
  rec.addBundle(bundle, parentValid, index)
  rec.commit(label)
  setSelection(bundle.rootIds)
}

/**
 * Ctrl+V: an image off the system clipboard, or the layers copied in here.
 *
 * Which one is a question of what was copied LAST, and the OS cannot be asked
 * that — there is no "when did this change". It does not have to be: a copy in
 * any application, including ours, empties the clipboard first. So an image
 * being there at all means it is the most recent thing copied anywhere, and
 * Copy claiming the clipboard is what makes that true in the other direction.
 *
 * Measured, not assumed — `clipboard.writeText` was checked against a seeded
 * image and does drop it, on this platform, in this Electron.
 */
export async function paste(): Promise<void> {
  const read = await window.polyform.clipboardRead().catch(() => null)
  const image = read?.image ?? null
  if (image) {
    await withBusy('Pasting image…', () => pasteImage(image))
    return
  }
  if (!clipboard) {
    setStatus('Nothing to paste')
    return
  }
  insertBundleCopy(clipboard, 'Paste', pasteAnchor())
}

/**
 * An image off the clipboard, as a rectangle with an image fill — the same
 * shape File → Import Image produces, because a pasted screenshot and an
 * imported PNG are the same object and should behave identically afterwards.
 *
 * Arrives as PNG whatever it started as: the system clipboard holds a bitmap,
 * not a file, so there is no original encoding to preserve.
 */
async function pasteImage(image: { bytes: Uint8Array; width: number; height: number }): Promise<void> {
  const written = await window.polyform.assetsWrite(image.bytes, 'png')
  if (!written) {
    setStatus('Could not store the pasted image')
    return
  }
  const scene = documentStore.scene
  const { camera, viewportSize } = editor.get()
  let w = image.width
  let h = image.height
  // Same fit as an imported image: a 4K screenshot pasted at full size is a
  // wall you then have to zoom out of to find.
  const scale = Math.min(1, ((viewportSize.w / camera.zoom) * 0.7) / w, ((viewportSize.h / camera.zoom) * 0.7) / h)
  w *= scale
  h *= scale
  try {
    await assetCache.primeFromBytes(written.hash, image.bytes, written.mime)
  } catch {
    /* the fill still resolves once the asset is read back from the bundle */
  }
  const at = pasteAnchor()
  const node = createNode('RECTANGLE', 'Pasted Image')
  node.width = w
  node.height = h
  node.x = at.x - w / 2
  node.y = at.y - h / 2
  node.fills = [{ type: 'IMAGE', visible: true, opacity: 1, assetHash: written.hash, scaleMode: 'FILL' }]
  const dropFrame = findDropFrame(scene, documentStore.index, at)
  if (dropFrame) {
    const inv = matInvert(scene.worldMatrix(dropFrame))
    const local = applyMat(inv, { x: node.x, y: node.y })
    node.x = local.x
    node.y = local.y
  }
  const rec = new OpRecorder()
  rec.add(node, dropFrame, scene.childListOf(dropFrame).length)
  rec.commit('Paste Image')
  setSelection([node.id])
}

/**
 * Where a copy of this node belongs: with its original.
 *
 * The exception is a materialized INSTANCE subtree. Those children are
 * regenerated from the component on every sync, so a copy placed among them is
 * wiped by the next derived pass — it goes beside the instance instead, which is
 * the closest place it can legally live. The instance itself is an ordinary child
 * of its own parent; only its insides are off limits.
 */
function duplicateParent(scene: SceneGraph, id: NodeId): NodeId | null {
  const parent = scene.parentOf(id)
  if (!parent) return null
  const owner =
    scene.getNode(parent)?.type === 'INSTANCE' ? parent : nearestInstanceAncestor(scene, parent)
  return owner ? scene.parentOf(owner) : parent
}

/** Duplicate never touches the user's clipboard. */
export function duplicateSelection(): void {
  const scene = documentStore.scene
  const ids = byZ(topSelection())
  if (ids.length === 0) return
  // Beside the original, not wherever the viewport happens to have been entered.
  // This went through `insertBundleCopy`, which inserts into `enteredContainer` —
  // the page root unless you had drilled into something — so duplicating a layer
  // inside a frame lifted the copy out of the frame, and out of its clipping and
  // auto layout with it.
  //
  // A selection can span parents, so the ids are grouped and each group inserted
  // under its own. One recorder for all of them keeps it one undo entry.
  const groups = new Map<NodeId | null, NodeId[]>()
  for (const id of ids) {
    const parent = duplicateParent(scene, id)
    const group = groups.get(parent)
    if (group) group.push(id)
    else groups.set(parent, [id])
  }
  const rec = new OpRecorder()
  const made: NodeId[] = []
  for (const [parent, group] of groups) {
    const bundle = reIdBundle(extractBundle(scene, group), newId)
    for (const rid of bundle.rootIds) {
      bundle.nodes[rid].x += 10
      bundle.nodes[rid].y += 10
    }
    rec.addBundle(bundle, parent, scene.childListOf(parent).length)
    made.push(...bundle.rootIds)
  }
  rec.commit('Duplicate')
  setSelection(made)
}

export function deleteSelection(): void {
  const scene = documentStore.scene
  // Nodes inside instances are structurally locked — delete the instance
  // itself if the user wants it gone.
  const ids = topSelection().filter((id) => !isInsideInstance(scene, id))
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
  const list = container && scene.hasNode(container) ? scene.childListOf(container) : scene.rootIds()
  setSelection(list.filter((id) => !scene.getNode(id)?.locked))
}

/**
 * Put one colour everywhere the selection's palette says it is used.
 *
 * `live` keeps it out of the history while a picker is being dragged — the same
 * arrangement the inspector's own paint editing uses, so recolouring a whole
 * frame is one undo step rather than one per pixel of slider travel.
 */
export function recolorSelectionUses(uses: readonly ColorUse[], next: RGBA, live: boolean): void {
  if (uses.length === 0) return
  const scene = documentStore.scene
  const before = new Map<NodeId, { fills: Paint[]; strokes: Paint[] }>()
  for (const use of uses) {
    if (before.has(use.nodeId)) continue
    const node = scene.getNode(use.nodeId)
    if (node) before.set(use.nodeId, structuredClone({ fills: node.fills, strokes: node.strokes }))
  }
  const touched = applyColorToUses(scene, uses, next)
  if (touched.length === 0) return
  scene.bump()
  if (live) {
    documentStore.transient()
    return
  }
  documentStore.commit(
    touched.map((id) => {
      const node = scene.requireNode(id)
      return {
        kind: 'update' as const,
        id,
        before: before.get(id) as unknown as Record<string, unknown>,
        after: structuredClone({ fills: node.fills, strokes: node.strokes }) as unknown as Record<string, unknown>,
      }
    }),
    touched.length === 1 ? 'Set Color' : `Recolor ${touched.length} Layers`,
    true,
  )
}

// ---------------------------------------------------------------------------
// Vector edit commands that act on the selected POINTS
//
// The rules are in engine/vector-connect; these are the parts that need the
// document: find the node, land one history entry, and say why when a command
// declines. They live here rather than in the pointer controller because
// nothing about them is a gesture — the same command comes from a button, a
// menu and a shortcut.
// ---------------------------------------------------------------------------

/** Run `edit` against the open path's network and commit it as one entry. */
function editOpenVector(label: string, edit: (net: VectorNetwork) => string | null): void {
  const { vectorEditId } = editor.get()
  const node = vectorEditId ? documentStore.scene.getNode(vectorEditId) : null
  if (!node || node.type !== 'VECTOR') return
  const before = structuredClone(node.network)
  const refusal = edit(node.network)
  if (refusal) {
    // Restored, not trusted: a rule that gave up half way would otherwise leave
    // the shape in whatever state it got to before it changed its mind.
    node.network = before
    setStatus(refusal)
    return
  }
  documentStore.scene.bump()
  documentStore.commit(
    [{ kind: 'update', id: node.id, before: { network: before }, after: { network: structuredClone(node.network) } }],
    label,
    true,
  )
}

/** Connect the two selected points with a straight segment. */
export function joinVectorPoints(): void {
  const sel = editor.get().vectorSelection
  editOpenVector('Join Points', (net) => joinVertices(net, sel))
}

/** Connect selected points across two detached parts of the same shape. */
export function bridgeVectorPoints(): void {
  const sel = editor.get().vectorSelection
  editOpenVector('Bridge Parts', (net) => bridgeVertices(net, sel))
}

/**
 * Close the open path: weld ends that sit on top of each other.
 *
 * The tolerance is a fraction of the shape's own size rather than a fixed
 * number of units, so it means the same thing on a 20px leaf and a 2000px one.
 * Deliberately small — this is for ends that are already in the same place, not
 * for pulling a visible gap shut, which is a move the user should make.
 *
 * Reports the outcome either way. "It did nothing" and "it worked" look
 * identical on a shape whose ends were already touching, and the whole reason
 * this command exists is that an open path is invisible.
 */
export function closeVectorPath(): void {
  const { vectorEditId } = editor.get()
  const node = vectorEditId ? documentStore.scene.getNode(vectorEditId) : null
  if (!node || node.type !== 'VECTOR') return
  const tolerance = Math.max(0.01, Math.hypot(node.width, node.height) * 0.0025)
  let welded = 0
  editOpenVector('Close Path', (net) => {
    welded = weldLooseEnds(net, tolerance)
    return welded > 0 ? null : 'No loose ends were close enough to weld together'
  })
  if (welded === 0) return
  const after = documentStore.scene.getNode(node.id)
  const closed = after && after.type === 'VECTOR' && hasClosedGeometry(after)
  setStatus(
    closed
      ? `Closed — welded ${welded} loose end${welded > 1 ? 's' : ''}, the fill applies now`
      : `Welded ${welded} loose end${welded > 1 ? 's' : ''} — the path is still open`,
  )
}

/**
 * Give the part under `local` (the open path's own space) its own fill.
 *
 * Clicking a part that already carries exactly this colour clears it instead,
 * so the bucket undoes itself with the same gesture that applied it — the
 * alternative is a tool you can only ever add with.
 */
export function paintVectorPartAt(local: Vec2): void {
  const { vectorEditId, paintColor } = editor.get()
  const node = vectorEditId ? documentStore.scene.getNode(vectorEditId) : null
  if (!node || node.type !== 'VECTOR') return
  const key = partAtPoint(node, local)
  if (key === null) {
    setStatus('Click inside a closed part of the shape to paint it')
    return
  }
  const current = node.partFills?.[String(key)]
  const same =
    current?.length === 1 &&
    current[0].type === 'SOLID' &&
    current[0].color.r === paintColor.r &&
    current[0].color.g === paintColor.g &&
    current[0].color.b === paintColor.b &&
    current[0].color.a === paintColor.a
  const fills: Paint[] | null = same
    ? null
    : [{ type: 'SOLID', visible: true, opacity: 1, color: { ...paintColor } }]
  const before = node.partFills ? structuredClone(node.partFills) : undefined
  const after = withPartFill(node.partFills, key, fills)
  documentStore.scene.updateNode(node.id, { partFills: after } as unknown as Partial<SceneNode>)
  documentStore.scene.bump()
  documentStore.commit(
    [{ kind: 'update', id: node.id, before: { partFills: before }, after: { partFills: after } }],
    same ? 'Clear Part Fill' : 'Paint Part',
    true,
  )
}

/**
 * Merge overlapping parts of the open path into single outlines.
 *
 * Says how many parts are left afterwards, always. Dissolve is the one command
 * here whose success is not obvious on screen — two overlapping shapes look
 * identical before and after if they were the same colour — and geometry it
 * cannot walk into one outline leaves more parts than you expected. A count is
 * the difference between "it worked" and "it did some of it".
 */
export function dissolveVectorParts(): void {
  const { vectorEditId, vectorSelection } = editor.get()
  const node = vectorEditId ? documentStore.scene.getNode(vectorEditId) : null
  if (!node || node.type !== 'VECTOR') return
  const tolerance = Math.max(0.01, Math.hypot(node.width, node.height) * 0.0025)
  // Points selected means you have AIMED at something — the seam between them —
  // and that reading has to win. Ignoring the selection and hunting for
  // overlapping parts instead is what made this look broken: two halves sharing
  // a seam do not overlap, they touch, so the answer came back "those parts do
  // not overlap" while a line sat down the middle of the shape.
  if (vectorSelection.length >= 2) {
    editOpenVector('Dissolve Segments', (net) => dissolveEdges(net, vectorSelection, tolerance))
  } else {
    editOpenVector('Dissolve Parts', (net) => dissolveParts(net))
  }
  const after = documentStore.scene.getNode(node.id)
  if (!after || after.type !== 'VECTOR') return
  if (editor.get().status) return // a refusal already said more than a count would
  const left = networkParts(after.network).length
  setStatus(left === 1 ? 'Dissolved into one outline' : `Dissolved — ${left} parts left`)
}

// ---------------------------------------------------------------------------
// Layer tree disclosure
//
// Which rows are folded shut is view state, not document state: it is not
// recorded, not undoable and not saved. The rules are in engine/layer-collapse.
// ---------------------------------------------------------------------------

/**
 * Fold every container on the page shut.
 *
 * The selection is left where it is, even though it may end up inside something
 * collapsed — that is what "collapse all" means, and the panel's reveal effect
 * only reopens ancestors when the selection CHANGES, so it does not undo this on
 * the next render.
 */
export function collapseAllLayers(): void {
  editor.set({ collapsedLayers: collapseAll(documentStore.scene) })
}

export function expandAllLayers(): void {
  editor.set({ collapsedLayers: new Set<NodeId>() })
}

/** Open the selected layers, their subtrees, and the path down to them. */
export function expandSelectedLayers(): void {
  const { selection, collapsedLayers, leftTab } = editor.get()
  if (selection.length === 0) return
  editor.set({
    collapsedLayers: expandSelected(documentStore.scene, collapsedLayers, selection),
    // This can be given from the canvas, where the Assets tab may be the one
    // showing — and then the tree it just opened is not on screen at all.
    ...(leftTab === 'layers' ? null : { leftTab: 'layers' as const }),
  })
  revealLayerRow(selection[0])
}

/**
 * Scroll a layer row into view, once React has rendered it. Found through the
 * document rather than a ref because the command also comes from the canvas
 * context menu, which holds no handle on the panel.
 */
function revealLayerRow(id: NodeId): void {
  requestAnimationFrame(() => {
    document.querySelector(`[data-layer-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  })
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

function wrapSelection(kind: 'GROUP' | 'FRAME' | 'BOOLEAN' | 'COMPONENT', op?: BooleanOp): void {
  const scene = documentStore.scene
  const ids = byZ(topSelection()).filter((id) => !isInsideInstance(scene, id))
  if (ids.length === 0) return
  if (kind === 'GROUP' && ids.length < 2) return

  const topId = ids[ids.length - 1]
  const parentId = scene.parentOf(topId)
  const sameParent = ids.every((id) => scene.parentOf(id) === parentId)
  const targetParent = sameParent ? parentId : null
  const bounds = selectionBoundsInParent(scene, ids, targetParent)

  const rec = new OpRecorder()
  const wrapper = createNode(
    kind,
    kind === 'GROUP'
      ? 'Group'
      : kind === 'FRAME'
        ? 'Frame'
        : kind === 'COMPONENT'
          ? 'Component'
          : (op ?? 'UNION').toLowerCase().replace(/^./, (c) => c.toUpperCase()),
  )
  wrapper.x = bounds.minX
  wrapper.y = bounds.minY
  wrapper.width = Math.max(1, bounds.maxX - bounds.minX)
  wrapper.height = Math.max(1, bounds.maxY - bounds.minY)
  if (wrapper.type === 'FRAME' || wrapper.type === 'COMPONENT') {
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

  rec.commit(
    kind === 'GROUP'
      ? 'Group Selection'
      : kind === 'FRAME'
        ? 'Frame Selection'
        : kind === 'COMPONENT'
          ? 'Create Component'
          : `Boolean ${op}`,
  )
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

/**
 * Bake the selection into one editable VECTOR (Figma's Flatten).
 *
 * A primitive has no anchors to grab — flattening an ellipse is how you get
 * its four points and their handles so you can start pulling the curve about.
 * A BOOLEAN contributes its computed rings, so its operation is baked in
 * rather than lost.
 *
 * Contours are concatenated as subpaths, not CSG-merged, so curves survive.
 * Winding is normalised first (see engine/flatten) so nonzero filling shows
 * the union of overlapping contours instead of cancelling them into holes.
 */
/**
 * Bake shapes into one VECTOR. Flatten and Carve differ only in how contours
 * are wound: same direction unions them, nesting-parity turns the enclosed ones
 * into holes.
 */
function bakeToVector(mode: 'flatten' | 'carve'): void {
  const scene = documentStore.scene
  const ids = byZ(topSelection()).filter((id) => {
    const n = scene.getNode(id)
    return n && !n.locked && !isInsideInstance(scene, id)
  })
  if (ids.length === 0) return

  // TEXT would need glyph outlines, which nodeOutline does not produce (it
  // returns the layout box) — flattening it would silently turn words into a
  // rectangle, so it is refused rather than mangled.
  const text = ids.filter((id) => scene.getNode(id)?.type === 'TEXT')
  if (text.length > 0) {
    setStatus(`${mode === 'carve' ? 'Carve' : 'Flatten'} cannot outline text yet — deselect the text layer first.`)
    return
  }
  if (mode === 'carve' && ids.length < 2) {
    setStatus('Carve needs at least two layers: the one being carved, and the shapes carving it.')
    return
  }
  if (mode === 'flatten' && ids.length === 1 && scene.getNode(ids[0])?.type === 'VECTOR') {
    setStatus('That layer is already a vector.')
    return
  }

  const topId = ids[ids.length - 1]
  const parentId = scene.parentOf(topId)
  const sameParent = ids.every((id) => scene.parentOf(id) === parentId)
  const targetParent = sameParent ? parentId : null
  // Everything is gathered in the target parent's space, so the result sits
  // exactly where the originals looked.
  const toParent = targetParent ? matInvert(scene.worldMatrix(targetParent)) : null

  const paths: SubPath[] = []
  for (const id of ids) {
    const node = scene.requireNode(id)
    const own = node.type === 'BOOLEAN' ? ringsToSubPaths(booleanRings(scene, node)) : nodeOutline(node)
    const world = scene.worldMatrix(id)
    const m = toParent ? matMultiply(toParent, world) : world
    for (const sp of own) paths.push(transformSubPath(sp, m))
  }
  const wound = mode === 'carve' ? carveWinding(paths) : normalizeWinding(paths)
  const network = subPathsToNetwork(wound)
  if (network.vertices.length < 2) return

  const { network: local, dx, dy } = anchorNetworkAtOrigin(network)
  const bounds = networkBounds(network)

  // Paint comes from the bottom-most source, matching how a boolean adopts it.
  // For a carve that is also the shape being carved, which is the one you were
  // looking at.
  const source = scene.requireNode(ids[0])
  const name = ids.length === 1 ? source.name : mode === 'carve' ? source.name : 'Flattened'
  const vector = createNode('VECTOR', name)
  if (vector.type !== 'VECTOR') return
  vector.network = local
  vector.x = dx
  vector.y = dy
  vector.width = Math.max(1, bounds.maxX - bounds.minX)
  vector.height = Math.max(1, bounds.maxY - bounds.minY)
  vector.fills = structuredClone(source.fills)
  vector.strokes = structuredClone(source.strokes)
  vector.strokeWeight = source.strokeWeight
  vector.strokeAlign = source.strokeAlign
  vector.strokeDash = [...source.strokeDash]
  vector.effects = structuredClone(source.effects)
  vector.opacity = source.opacity
  vector.blendMode = source.blendMode

  const insertIndex = sameParent ? scene.indexInParent(topId) + 1 : scene.childListOf(targetParent).length
  const rec = new OpRecorder()
  rec.add(vector, targetParent, insertIndex)
  for (const id of ids) rec.removeSubtree(id)
  rec.commit(mode === 'carve' ? 'Carve' : 'Flatten')
  setSelection([vector.id])
  // One shape in means "show me its points", so open the editor on it.
  if (mode === 'flatten' && ids.length === 1) editor.set({ vectorEditId: vector.id, vectorSelection: [] })
}

export function flattenSelection(): void {
  bakeToVector('flatten')
}

/**
 * Carve: one vector whose enclosed contours are holes. The shapes you put
 * inside cut through the one underneath, and the result is a single editable
 * path rather than a live boolean — the difference being that you can then drag
 * the hole's points.
 */
export function carveSelection(): void {
  bakeToVector('carve')
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
  const selected = new Set(ids)
  const rec = new OpRecorder()
  // Iteration order preserves the selection's internal stacking:
  //   forward/back  -> top-most first;  backward/front -> bottom-most first.
  // forward/backward also skip past neighbours that are themselves selected
  // so a contiguous selected run moves as a block instead of swapping.
  const ordered = mode === 'forward' || mode === 'back' ? [...ids].reverse() : ids
  for (const id of ordered) {
    const parent = scene.parentOf(id)
    const list = scene.childListOf(parent)
    const idx = list.indexOf(id)
    let target = idx
    if (mode === 'forward') {
      if (idx < list.length - 1 && !selected.has(list[idx + 1])) target = idx + 1
    } else if (mode === 'backward') {
      if (idx > 0 && !selected.has(list[idx - 1])) target = idx - 1
    } else if (mode === 'front') {
      target = list.length - 1
    } else {
      target = 0
    }
    if (target !== idx) rec.move(id, parent, target)
  }
  if (rec.ops.length > 0) rec.commit('Reorder Layers')
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

/**
 * Quarter-turn the selection, the way Figma's rotate button does.
 *
 * One node turns about its own centre — the box is unchanged, only `rotation`
 * moves, so a 90° turn is reversible to the exact number it started from. Two
 * or more turn RIGIDLY about the shared centre: each node keeps its own turn and
 * orbits, which is the same maths the rotate gesture uses (interactions/
 * controller), so dragging the knob a quarter turn and pressing the button land
 * in the same place.
 */
export function rotateSelection(deg: number): void {
  const scene = documentStore.scene
  const ids = topSelection().filter((id) => !isInsideInstance(scene, id))
  if (ids.length === 0) return
  const box = selectionWorldBounds(scene, ids)
  const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const rec = new OpRecorder()
  for (const id of ids) {
    const node = scene.requireNode(id)
    const patch: Partial<SceneNode> = { rotation: norm180(node.rotation + deg) }
    if (ids.length > 1) {
      // Orbit this node's centre about the selection's.
      const c0 = applyMat(scene.worldMatrix(id), { x: node.width / 2, y: node.height / 2 })
      const dx = c0.x - centre.x
      const dy = c0.y - centre.y
      const moved = { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos }
      const parentId = scene.parentOf(id)
      const local =
        parentId && !scene.isPage(parentId)
          ? applyMat(matInvert(scene.worldMatrix(parentId)), moved)
          : moved
      patch.x = local.x - node.width / 2
      patch.y = local.y - node.height / 2
    }
    rec.update(id, patch)
  }
  rec.commit(deg === 90 ? 'Rotate 90° Right' : deg === -90 ? 'Rotate 90° Left' : 'Rotate')
}

/**
 * Mirror the selection about its own centre.
 *
 * A transform, not a geometry edit: `flipH`/`flipV` ride in the node matrix
 * (engine/geometry nodeLocalMatrix), which is the only way one operation can
 * mean the same thing for an image fill, shaped text, a vector network and a
 * whole group — and it makes the flip exactly reversible.
 *
 * With several nodes selected the flip is rigid, like the rotation: each node
 * mirrors AND its position mirrors across the selection's centre line, so the
 * arrangement flips rather than each piece flipping in place.
 */
export function flipSelection(axis: 'h' | 'v'): void {
  const scene = documentStore.scene
  const ids = topSelection().filter((id) => {
    const n = scene.getNode(id)
    return n && !n.locked && !isInsideInstance(scene, id)
  })
  if (ids.length === 0) return
  const box = selectionWorldBounds(scene, ids)
  const mid = axis === 'h' ? (box.minX + box.maxX) / 2 : (box.minY + box.maxY) / 2
  const rec = new OpRecorder()
  for (const id of ids) {
    const node = scene.requireNode(id)
    const patch: Partial<SceneNode> =
      axis === 'h' ? { flipH: !(node.flipH ?? false) } : { flipV: !(node.flipV ?? false) }
    if (ids.length > 1) {
      const b = scene.worldAABB(id)
      // Reflect the node's box across the selection's centre line, then convert
      // the world delta into the parent's space so nesting and rotation hold.
      const world = axis === 'h' ? 2 * mid - (b.minX + b.maxX) : 2 * mid - (b.minY + b.maxY)
      const parentId = scene.parentOf(id)
      const pm = parentId && !scene.isPage(parentId) ? scene.worldMatrix(parentId) : null
      const scale = pm ? Math.hypot(pm.a, pm.b) || 1 : 1
      if (axis === 'h') patch.x = node.x + world / scale
      else patch.y = node.y + world / scale
    }
    rec.update(id, patch)
  }
  rec.commit(axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical')
}

/** World-space union of a set of nodes, ignoring the empty ones. */
function selectionWorldBounds(scene: typeof documentStore.scene, ids: NodeId[]): AABB {
  let box = emptyAABB()
  for (const id of ids) {
    const b = scene.worldAABB(id)
    if (!aabbIsEmpty(b)) box = aabbIsEmpty(box) ? b : aabbUnion(box, b)
  }
  return box
}

/** Keep an angle in the readable ±180 half, as the inspector's field shows it. */
function norm180(deg: number): number {
  let d = deg % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
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

// ---------------------------------------------------------------------------
// Scrub gestures (inspector value drags)
//
// A scrub applies to the scene on every pointer move so the canvas updates
// live, but must land in history as ONE entry — per-pixel commits would
// flood the journal. The document store coalesces every commit made between
// these two calls, so this works for any action the inspector routes to,
// not just plain property patches.
// ---------------------------------------------------------------------------

export function beginScrub(): void {
  documentStore.beginScrub()
}

export function endScrub(): void {
  documentStore.endScrub()
}

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
// Pages
// ---------------------------------------------------------------------------

export function switchPage(pageId: string): void {
  const scene = documentStore.scene
  if (!scene.isPage(pageId) || scene.doc.activePageId === pageId) return
  // Persist the current camera on the outgoing page (view state, no undo).
  const { camera } = editor.get()
  scene.activePage.viewport = { x: camera.x, y: camera.y, zoom: camera.zoom }
  scene.setActivePage(pageId)
  editor.set({
    selection: [],
    hover: null,
    enteredContainer: null,
    editingTextId: null,
    penDraft: null,
    vectorEditId: null,
  })
  const vp = scene.activePage.viewport
  if (vp) editor.set({ camera: { x: vp.x, y: vp.y, zoom: vp.zoom } })
  documentStore.transient()
  documentStore.markDirty(true)
  if (!vp) zoomToFit()
}

export function addPage(): void {
  const scene = documentStore.scene
  const page = createPage(`Page ${scene.doc.pages.length + 1}`)
  documentStore.commit([{ kind: 'page-add', index: scene.doc.pages.length, page }], 'Add Page')
  switchPage(page.id)
}

export function renamePage(pageId: string, name: string): void {
  const page = documentStore.scene.getPage(pageId)
  if (!page || !name.trim() || page.name === name.trim()) return
  documentStore.commit(
    [{ kind: 'page-rename', pageId, before: page.name, after: name.trim() }],
    'Rename Page',
  )
}

export function deletePage(pageId: string): void {
  const scene = documentStore.scene
  if (scene.doc.pages.length <= 1) return
  const page = scene.getPage(pageId)
  if (!page) return
  if (scene.doc.activePageId === pageId) {
    const fallback = scene.doc.pages.find((p) => p.id !== pageId)
    if (fallback) switchPage(fallback.id)
  }
  const rec = new OpRecorder()
  for (const rid of [...page.rootIds].reverse()) rec.removeSubtree(rid)
  const index = scene.doc.pages.findIndex((p) => p.id === pageId)
  const snapshot = structuredClone(page)
  snapshot.rootIds = []
  const removeOp: PatchOp = { kind: 'page-remove', index, page: snapshot }
  applyOp(scene, removeOp)
  rec.ops.push(removeOp)
  rec.commit('Delete Page')
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

export function toggleMaskSelection(): void {
  const scene = documentStore.scene
  const ids = topSelection().filter((id) => {
    const n = scene.getNode(id)
    return n && n.type !== 'FRAME'
  })
  if (ids.length === 0) return
  const anyOff = ids.some((id) => !scene.getNode(id)?.isMask)
  const rec = new OpRecorder()
  for (const id of ids) rec.update(id, { isMask: anyOff })
  rec.commit(anyOff ? 'Use as Mask' : 'Remove Mask')
}

// ---------------------------------------------------------------------------
// Sizing with constraints (inspector W/H commits)
// ---------------------------------------------------------------------------

export function setSelectionSize(axis: 'width' | 'height', v: number): void {
  const scene = documentStore.scene
  const rec = new OpRecorder()
  for (const id of selectedIds()) {
    const node = scene.getNode(id)
    if (!node) continue
    if (node.type === 'FRAME' && node.layout.mode === 'NONE') {
      const rects = new Map<NodeId, ChildRect>()
      for (const d of scene.descendants(id)) {
        const n = scene.getNode(d)
        if (n) rects.set(d, { x: n.x, y: n.y, width: n.width, height: n.height })
      }
      const oldW = node.width
      const oldH = node.height
      rec.update(id, { [axis]: v })
      constrainFrameChildren(scene, node, (cid) => rects.get(cid) ?? null, oldW, oldH)
      for (const [cid, r] of rects) {
        const n = scene.getNode(cid)
        if (!n) continue
        const before: Record<string, unknown> = {}
        const after: Record<string, unknown> = {}
        if (n.x !== r.x) (before.x = r.x), (after.x = n.x)
        if (n.y !== r.y) (before.y = r.y), (after.y = n.y)
        if (n.width !== r.width) (before.width = r.width), (after.width = n.width)
        if (n.height !== r.height) (before.height = r.height), (after.height = n.height)
        if (Object.keys(after).length > 0) rec.ops.push({ kind: 'update', id: cid, before, after })
      }
    } else {
      rec.update(id, { [axis]: v })
    }
  }
  rec.commit(axis === 'width' ? 'Set Width' : 'Set Height')
}

// ---------------------------------------------------------------------------
// Shared styles (applied-by-reference; edits propagate to referencing nodes)
// ---------------------------------------------------------------------------

function stylesOp(mutate: (styles: DocumentStyles) => void): { op: PatchOp; after: DocumentStyles } {
  const before = structuredClone(documentStore.scene.doc.styles)
  const after = structuredClone(before)
  mutate(after)
  return { op: { kind: 'styles-set', before, after }, after }
}

export function createColorStyle(name: string, paint: Paint): string {
  const id = newId()
  const { op } = stylesOp((s) => s.colors.push({ id, name, paint: structuredClone(paint) }))
  documentStore.commit([op], 'Create Color Style')
  return id
}

export function applyColorStyle(styleId: string): void {
  const scene = documentStore.scene
  const style = scene.doc.styles.colors.find((s) => s.id === styleId)
  if (!style) return
  const rec = new OpRecorder()
  for (const id of selectedIds()) {
    const node = scene.getNode(id)
    if (!node) continue
    // A colour style is one paint, so it owns the first fill slot only — the
    // layers stacked above it are not the style's to delete.
    rec.update(id, {
      fills: [structuredClone(style.paint), ...node.fills.slice(1)],
      styleRefs: { ...(node.styleRefs ?? {}), fill: styleId },
    })
  }
  rec.commit('Apply Color Style')
}

export function detachStyle(kind: 'fill' | 'text' | 'effect'): void {
  const scene = documentStore.scene
  const rec = new OpRecorder()
  for (const id of selectedIds()) {
    const node = scene.getNode(id)
    if (!node?.styleRefs?.[kind]) continue
    rec.update(id, { styleRefs: { ...node.styleRefs, [kind]: null } })
  }
  rec.commit('Detach Style')
}

export function updateColorStyle(styleId: string, paint: Paint): void {
  const scene = documentStore.scene
  const { op } = stylesOp((s) => {
    const style = s.colors.find((c) => c.id === styleId)
    if (style) style.paint = structuredClone(paint)
  })
  const ops: PatchOp[] = [op]
  for (const node of Object.values(scene.doc.nodes)) {
    if (node.styleRefs?.fill === styleId) {
      ops.push(makeUpdateOp(node, { fills: [structuredClone(paint), ...node.fills.slice(1)] }))
    }
  }
  documentStore.commit(ops, 'Edit Color Style')
}

export function createTextStyle(name: string, props: TextStyleProps): string {
  const id = newId()
  const { op } = stylesOp((s) => s.texts.push({ id, name, props: structuredClone(props) }))
  documentStore.commit([op], 'Create Text Style')
  return id
}

export function applyTextStyle(styleId: string): void {
  const scene = documentStore.scene
  const style = scene.doc.styles.texts.find((s) => s.id === styleId)
  if (!style) return
  const rec = new OpRecorder()
  for (const id of selectedIds()) {
    const node = scene.getNode(id)
    if (!node || node.type !== 'TEXT') continue
    rec.update(id, { ...structuredClone(style.props), styleRefs: { ...(node.styleRefs ?? {}), text: styleId } })
  }
  rec.commit('Apply Text Style')
}

export function updateTextStyle(styleId: string, props: TextStyleProps): void {
  const scene = documentStore.scene
  const { op } = stylesOp((s) => {
    const style = s.texts.find((t) => t.id === styleId)
    if (style) style.props = structuredClone(props)
  })
  const ops: PatchOp[] = [op]
  for (const node of Object.values(scene.doc.nodes)) {
    if (node.type === 'TEXT' && node.styleRefs?.text === styleId) {
      ops.push(makeUpdateOp(node, structuredClone(props) as unknown as Record<string, unknown>))
    }
  }
  documentStore.commit(ops, 'Edit Text Style')
}

export function createEffectStyle(name: string, effects: Effect[]): string {
  const id = newId()
  const { op } = stylesOp((s) => s.effects.push({ id, name, effects: structuredClone(effects) }))
  documentStore.commit([op], 'Create Effect Style')
  return id
}

export function applyEffectStyle(styleId: string): void {
  const scene = documentStore.scene
  const style = scene.doc.styles.effects.find((s) => s.id === styleId)
  if (!style) return
  const rec = new OpRecorder()
  for (const id of selectedIds()) {
    const node = scene.getNode(id)
    if (!node) continue
    rec.update(id, {
      effects: structuredClone(style.effects),
      styleRefs: { ...(node.styleRefs ?? {}), effect: styleId },
    })
  }
  rec.commit('Apply Effect Style')
}

export function renameSharedStyle(kind: 'colors' | 'texts' | 'effects', styleId: string, name: string): void {
  const { op } = stylesOp((s) => {
    const style = (s[kind] as { id: string; name: string }[]).find((x) => x.id === styleId)
    if (style) style.name = name
  })
  documentStore.commit([op], 'Rename Style')
}

export function deleteSharedStyle(kind: 'colors' | 'texts' | 'effects', styleId: string): void {
  const scene = documentStore.scene
  const refKey = kind === 'colors' ? 'fill' : kind === 'texts' ? 'text' : 'effect'
  const { op } = stylesOp((s) => {
    const list = s[kind] as { id: string }[]
    const idx = list.findIndex((x) => x.id === styleId)
    if (idx >= 0) list.splice(idx, 1)
  })
  const ops: PatchOp[] = [op]
  for (const node of Object.values(scene.doc.nodes)) {
    if (node.styleRefs?.[refKey as 'fill' | 'text' | 'effect'] === styleId) {
      ops.push(makeUpdateOp(node, { styleRefs: { ...node.styleRefs, [refKey]: null } }))
    }
  }
  documentStore.commit(ops, 'Delete Style')
}

/** Guides are view furniture: persisted but not journaled. */
export function guidesChanged(): void {
  documentStore.scene.bump()
  documentStore.markDirty(true)
  documentStore.emit()
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export function zoomAt(screenPt: Vec2 | null, factor: number): void {
  const { camera, viewportSize } = editor.get()
  const pt = screenPt ?? { x: viewportSize.w / 2, y: viewportSize.h / 2 }
  const worldBefore = { x: pt.x / camera.zoom + camera.x, y: pt.y / camera.zoom + camera.y }
  const zoom = clampZoom(camera.zoom * factor)
  editor.set({ camera: { zoom, x: worldBefore.x - pt.x / zoom, y: worldBefore.y - pt.y / zoom } })
}

/**
 * Zoom to an exact level, keeping the middle of the viewport where it is — what
 * a typed percentage and the preset rows mean. A factor would have to be derived
 * from the current zoom, and 1.25 × 0.8 does not come back to where it started.
 */
export function zoomTo(level: number): void {
  const { camera, viewportSize } = editor.get()
  const zoom = clampZoom(level)
  const cx = camera.x + viewportSize.w / (2 * camera.zoom)
  const cy = camera.y + viewportSize.h / (2 * camera.zoom)
  editor.set({ camera: { zoom, x: cx - viewportSize.w / (2 * zoom), y: cy - viewportSize.h / (2 * zoom) } })
}

export function zoomActual(): void {
  zoomTo(1)
}

/** Centre a world box in the viewport with room to breathe around it. */
function zoomToBox(box: AABB, margin = 60): void {
  const { viewportSize } = editor.get()
  if (aabbIsEmpty(box)) {
    editor.set({ camera: { x: -viewportSize.w / 2, y: -viewportSize.h / 2, zoom: 1 } })
    return
  }
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY
  // Its own ceiling, deliberately lower than MAX_ZOOM: fitting a 4px dot should
  // not land you at 6400%.
  const zoom = Math.max(MIN_ZOOM, Math.min(4, Math.min((viewportSize.w - margin * 2) / w, (viewportSize.h - margin * 2) / h)))
  editor.set({
    camera: {
      zoom,
      x: box.minX - (viewportSize.w / zoom - w) / 2,
      y: box.minY - (viewportSize.h / zoom - h) / 2,
    },
  })
}

export function zoomToFit(): void {
  zoomToBox(documentStore.scene.documentAABB())
}

/**
 * Frame the selection. With nothing selected this fits the whole page, so the
 * one button in the bottom bar always does the obvious thing.
 */
export function zoomToSelection(): void {
  const scene = documentStore.scene
  const ids = editor.get().selection.filter((id) => scene.hasNode(id))
  if (ids.length === 0) {
    zoomToFit()
    return
  }
  let box: AABB | null = null
  for (const id of ids) {
    const b = scene.worldAABB(id)
    if (aabbIsEmpty(b)) continue
    box = box
      ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) }
      : b
  }
  // A tighter margin than fit-all: you asked for this thing, not its context.
  zoomToBox(box ?? documentStore.scene.documentAABB(), 40)
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

/**
 * Never switch projects over unsaved work: the journal is already persisted
 * as edits happen, so an implicit save keeps scene.bin consistent with it
 * (local-first apps save, they don't prompt).
 */
async function saveIfDirty(): Promise<void> {
  if (documentStore.projectInfo && documentStore.dirty) {
    await saveFlow()
  }
}

// ---------------------------------------------------------------------------
// Busy feedback
// ---------------------------------------------------------------------------

/**
 * Put a label on screen and WAIT until it is actually there.
 *
 * The expensive half of loading a file is synchronous — decoding a `.fig`,
 * then committing every node in it, ~90 s for a 4,600-layer file. A label set in
 * the same tick as that work is never painted: the frame it belongs to would
 * render after the thread frees up, by which time it is wrong. So each step
 * yields for a frame (`requestAnimationFrame`) and then once more through the
 * task queue, which is what actually gets the pixels out.
 */
export async function busyStep(label: string): Promise<void> {
  editor.set({ busy: label })
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/**
 * Run something slow with the spinner up, and take it down whatever happens —
 * including a cancelled file dialog, which is the common way out of these flows.
 * `step` re-labels mid-flight, so a long job can say which part it is on.
 */
export async function withBusy<T>(
  label: string,
  run: (step: (label: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  await busyStep(label)
  try {
    return await run(busyStep)
  } finally {
    editor.set({ busy: null })
  }
}

export async function newProjectFlow(): Promise<void> {
  await saveIfDirty()
  const viewport = await documentStore.newProject()
  if (viewport) applyViewport(viewport)
}

export async function openProjectFlow(path?: string): Promise<void> {
  await saveIfDirty()
  // Reading a bundle back is the same shape of work as importing one: parse,
  // then build every node. A big document is a visible wait.
  const viewport = await withBusy('Opening project…', () => documentStore.openProject(path))
  if (viewport) applyViewport(viewport)
}

function currentViewportState() {
  const { camera } = editor.get()
  return { zoom: camera.zoom, pan_x: camera.x, pan_y: camera.y }
}

/** How long "Saved" stays on screen before the indicator goes quiet again. */
const SAVED_BADGE_MS = 1800
let badgeTimer: number | null = null

function flashSaved(): void {
  if (badgeTimer !== null) window.clearTimeout(badgeTimer)
  editor.set({ saveState: 'saved' })
  badgeTimer = window.setTimeout(() => {
    badgeTimer = null
    editor.set({ saveState: 'idle' })
  }, SAVED_BADGE_MS)
}

/**
 * Write the project. Owns the save-state indicator, because whoever performs
 * the save is the only thing that knows how it went — automatic saves and
 * Ctrl+S then report identically (state/autosave.ts decides *when*).
 */
export async function saveFlow(includeThumbnail = true): Promise<boolean> {
  if (!documentStore.projectInfo) return false
  if (badgeTimer !== null) {
    window.clearTimeout(badgeTimer)
    badgeTimer = null
  }
  editor.set({ saveState: 'saving' })
  let ok = false
  try {
    ok = await documentStore.save(currentViewportState(), includeThumbnail)
  } catch {
    ok = false
  }
  if (ok) flashSaved()
  else editor.set({ saveState: 'error' })
  return ok
}

/**
 * An explicit save. Kept even though saving is automatic, because pressing
 * Ctrl+S is a reflex and appearing to do nothing is worse than a redundant
 * write. With nothing to write it just confirms — the answer the reflex wanted.
 */
export async function saveNow(): Promise<void> {
  if (!documentStore.projectInfo) return
  if (!documentStore.dirty) {
    flashSaved()
    return
  }
  await saveFlow()
}

export async function saveAsFlow(): Promise<boolean> {
  return documentStore.saveAs(currentViewportState())
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export async function importImages(): Promise<void> {
  await withBusy('Importing images…', () => placeImages())
}

async function placeImages(): Promise<void> {
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
  rec.commit(assets.length === 1 ? 'Import Image' : `Import ${assets.length} Images`)
  setSelection(created)
}

// ---------------------------------------------------------------------------
// 3D models (roadmap 6.2, ADR-020)
// ---------------------------------------------------------------------------

const MODEL_FORMAT_BY_EXT: Record<string, Model3dFormat> = {
  glb: 'GLB',
  gltf: 'GLB',
  ply: 'PLY',
  spz: 'SPZ',
  splat: 'SPLAT',
  ksplat: 'KSPLAT',
  sog: 'SOG',
}

export async function importModels(): Promise<void> {
  // A GLB or a splat capture can be tens of megabytes, parsed on this thread.
  await withBusy('Importing 3D model…', () => placeModels())
}

async function placeModels(): Promise<void> {
  const assets = await window.polyform.assetsImportDialog('model')
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
    const format = MODEL_FORMAT_BY_EXT[asset.ext.toLowerCase()]
    if (!format) continue
    // A model has no intrinsic pixel size: the render is framed to the node
    // box, so start from a square at 40% of the viewport's short side.
    const side = Math.min(viewportSize.w / camera.zoom, viewportSize.h / camera.zoom) * 0.4
    const node = createNode('MODEL3D', asset.fileName.replace(/\.[^.]+$/, '')) as Model3dNode
    node.width = side
    node.height = side
    node.x = centerWorld.x - side / 2 + offset
    node.y = centerWorld.y - side / 2 + offset
    node.assetHash = asset.hash
    node.format = format
    const dropFrame = findDropFrame(scene, documentStore.index, {
      x: node.x + side / 2,
      y: node.y + side / 2,
    })
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
  if (created.length === 0) return
  rec.commit(created.length === 1 ? 'Import 3D Model' : `Import ${created.length} 3D Models`)
  setSelection(created)
}

// ---------------------------------------------------------------------------
// Components & instances (roadmap 3.1)
// ---------------------------------------------------------------------------

export function createComponentFromSelection(): void {
  const scene = documentStore.scene
  const ids = topSelection().filter((id) => !isInsideInstance(scene, id))
  if (ids.length === 0) return
  const single = ids.length === 1 ? scene.getNode(ids[0]) : null
  if (single && single.type === 'FRAME') {
    // Convert the frame in place — children, layout and constraints survive.
    const rec = new OpRecorder()
    rec.update(single.id, { type: 'COMPONENT' })
    rec.commit('Create Component')
    setSelection([single.id])
    return
  }
  if (single && (single.type === 'COMPONENT' || single.type === 'INSTANCE')) return
  wrapSelection('COMPONENT')
}

export function createInstanceOf(componentId: NodeId): NodeId | null {
  const scene = documentStore.scene
  const comp = scene.getNode(componentId)
  if (!comp || comp.type !== 'COMPONENT') return null
  const inst = createNode('INSTANCE', comp.name)
  if (inst.type !== 'INSTANCE') return null
  inst.componentId = componentId
  inst.width = comp.width
  inst.height = comp.height
  const { camera, viewportSize } = editor.get()
  inst.x = camera.x + viewportSize.w / (2 * camera.zoom) - comp.width / 2
  inst.y = camera.y + viewportSize.h / (2 * camera.zoom) - comp.height / 2
  const rec = new OpRecorder()
  rec.add(inst, null, scene.childListOf(null).length)
  rec.commit('Create Instance')
  setSelection([inst.id])
  return inst.id
}

export function createInstanceFromSelection(): void {
  const scene = documentStore.scene
  const comps = topSelection().filter((id) => scene.getNode(id)?.type === 'COMPONENT')
  const created: NodeId[] = []
  for (const id of comps) {
    const made = createInstanceOf(id)
    if (made) created.push(made)
  }
  if (created.length > 0) setSelection(created)
}

export function detachSelectedInstances(): void {
  const scene = documentStore.scene
  const ids = topSelection().filter((id) => scene.getNode(id)?.type === 'INSTANCE')
  if (ids.length === 0) return
  const rec = new OpRecorder()
  for (const id of ids) {
    rec.update(id, { type: 'FRAME', componentId: '', overrides: {}, syncedHash: '' })
    // Clear sourceIds so future edits are plain edits, not override captures.
    for (const did of scene.descendants(id)) {
      const d = scene.getNode(did)
      if (d?.sourceId) rec.update(did, { sourceId: '' })
    }
  }
  rec.commit('Detach Instance')
}

export function resetInstanceOverrides(): void {
  const scene = documentStore.scene
  const ids = topSelection().filter((id) => scene.getNode(id)?.type === 'INSTANCE')
  if (ids.length === 0) return
  const rec = new OpRecorder()
  for (const id of ids) rec.update(id, { overrides: {}, syncedHash: '' })
  rec.commit('Reset Overrides')
}

export function swapInstanceComponent(instanceId: NodeId, componentId: NodeId): void {
  const scene = documentStore.scene
  const inst = scene.getNode(instanceId)
  const comp = scene.getNode(componentId)
  if (!inst || inst.type !== 'INSTANCE' || !comp || comp.type !== 'COMPONENT') return
  const rec = new OpRecorder()
  rec.update(instanceId, {
    componentId,
    overrides: {},
    syncedHash: '',
    width: comp.width,
    height: comp.height,
  })
  rec.commit('Swap Instance')
}

// ---------------------------------------------------------------------------
// Local-file libraries (roadmap 3.2)
// ---------------------------------------------------------------------------

export interface LibraryIndexEntry {
  path: string
  title: string
  updatedAt: string
  scene: SceneGraph
  components: { id: NodeId; name: string; width: number; height: number }[]
  colorStyles: { id: string; name: string }[]
}

const libraryCache = new Map<string, LibraryIndexEntry>()

export async function loadLibraryIndex(path: string, force = false): Promise<LibraryIndexEntry | null> {
  if (!force && libraryCache.has(path)) return libraryCache.get(path)!
  const data = await window.polyform.libraryRead(path)
  if (!data) return null
  try {
    const doc = decodeScene(new Uint8Array(data.sceneBytes))
    const scene = new SceneGraph(doc)
    const entry: LibraryIndexEntry = {
      path,
      title: data.title,
      updatedAt: data.updatedAt,
      scene,
      components: listComponents(scene).map((c) => ({ id: c.id, name: c.name, width: c.width, height: c.height })),
      colorStyles: doc.styles.colors.map((s) => ({ id: s.id, name: s.name })),
    }
    libraryCache.set(path, entry)
    return entry
  } catch (err) {
    console.error('Failed to read library:', path, err)
    return null
  }
}

export async function attachLibraryFlow(): Promise<void> {
  const picked = await window.polyform.libraryPick()
  if (!picked) return
  const doc = documentStore.scene.doc
  doc.libraries = doc.libraries ?? []
  if (doc.libraries.some((l) => l.path === picked.path)) return
  doc.libraries.push({ path: picked.path, name: picked.title, attachedAt: new Date().toISOString() })
  documentStore.scene.bump()
  documentStore.markDirty(true)
  documentStore.emit()
  void loadLibraryIndex(picked.path, true)
}

export function detachLibrary(path: string): void {
  const doc = documentStore.scene.doc
  doc.libraries = (doc.libraries ?? []).filter((l) => l.path !== path)
  libraryCache.delete(path)
  documentStore.scene.bump()
  documentStore.markDirty(true)
  documentStore.emit()
}

/**
 * Import a library component into this document (or reuse the existing
 * imported copy) and drop an instance of it at the viewport center.
 */
export async function insertLibraryComponent(path: string, componentId: NodeId): Promise<void> {
  const scene = documentStore.scene
  const existing = listComponents(scene).find(
    (c) => c.origin?.libraryPath === path && c.origin.componentId === componentId,
  )
  if (existing) {
    createInstanceOf(existing.id)
    return
  }
  const lib = await loadLibraryIndex(path)
  if (!lib) return
  const source = lib.scene.getNode(componentId)
  if (!source || source.type !== 'COMPONENT') return
  const bundle = reIdBundle(extractBundle(lib.scene, [componentId]), newId)
  const rootId = bundle.rootIds[0]
  const comp = bundle.nodes[rootId]
  if (comp.type === 'COMPONENT') {
    comp.origin = { libraryPath: path, componentId, importedAt: new Date().toISOString() }
  }
  // Park the imported main component off to the side of the current view.
  const { camera, viewportSize } = editor.get()
  comp.x = camera.x + viewportSize.w / camera.zoom + 100
  comp.y = camera.y + 100
  const rec = new OpRecorder()
  rec.addBundle(bundle, null, scene.childListOf(null).length)
  rec.commit('Import Library Component')
  createInstanceOf(rootId)
}

/** Import a color style from a library into the document's styles. */
export async function importLibraryColorStyle(path: string, styleId: string): Promise<void> {
  const lib = await loadLibraryIndex(path)
  if (!lib) return
  const style = lib.scene.doc.styles.colors.find((s) => s.id === styleId)
  if (!style) return
  const existing = documentStore.scene.doc.styles.colors.find((s) => s.id === styleId)
  if (existing) return
  const { op } = stylesOp((s) => s.colors.push(structuredClone(style)))
  documentStore.commit([op], 'Import Library Style')
}

/**
 * Refresh all components imported from a library: replace their contents
 * from the library file. Instances re-sync automatically; overrides are
 * re-keyed by structural position where possible.
 */
export async function updateLibraryComponents(path: string): Promise<number> {
  const lib = await loadLibraryIndex(path, true)
  if (!lib) return 0
  const scene = documentStore.scene
  let updated = 0
  const rec = new OpRecorder()
  for (const local of listComponents(scene)) {
    if (local.origin?.libraryPath !== path) continue
    const source = lib.scene.getNode(local.origin.componentId)
    if (!source || source.type !== 'COMPONENT') continue
    // Map old child ids -> new child ids by structural (index) path.
    const idMap = new Map<NodeId, NodeId>()
    // Remove current children.
    for (const cid of [...local.children].reverse()) rec.removeSubtree(cid)
    // Insert fresh children from the library.
    const bundle = reIdBundle(
      extractBundle(lib.scene, [...source.children]),
      newId,
    )
    // Structural path mapping: walk old (pre-removal snapshot unavailable) —
    // map via source ids: overrides in instances are keyed by LOCAL child
    // ids; without a stored path map we re-key by matching names + types.
    rec.addBundle(bundle, local.id, 0)
    rec.update(local.id, {
      width: source.width,
      height: source.height,
      fills: structuredClone(source.fills),
      strokes: structuredClone(source.strokes),
      effects: structuredClone(source.effects),
      cornerRadius: structuredClone(source.cornerRadius),
      layout: structuredClone(source.layout),
      clipsContent: source.clipsContent,
      origin: { ...local.origin, importedAt: new Date().toISOString() },
    })
    void idMap
    updated++
  }
  if (updated > 0) rec.commit('Update from Library')
  return updated
}

// ---------------------------------------------------------------------------
// Plugin runner (roadmap 3.4 — dev preview, see docs/Plugin-API.md)
// ---------------------------------------------------------------------------

export async function runPluginFlow(): Promise<void> {
  const file = await window.polyform.pluginOpenDialog()
  if (!file) return
  const ok = window.confirm(
    `Run plugin "${file.fileName}"?\n\nPlugins run with full access to this document. Only run scripts you trust.`,
  )
  if (!ok) return
  const scene = documentStore.scene
  const rec = new OpRecorder()
  const api = {
    /** Current selection (node ids). */
    selection: (): NodeId[] => selectedIds(),
    /** Deep copy of a node, or null. */
    getNode: (id: NodeId) => {
      const n = scene.getNode(id)
      return n ? structuredClone(n) : null
    },
    /** All node ids on the active page (render order). */
    currentPageNodes: (): NodeId[] => [...scene.renderOrder()],
    /** Create a node at root level. Returns its id. */
    create: (type: string, props: Record<string, unknown> = {}): NodeId => {
      const allowed = ['RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'TEXT', 'FRAME']
      if (!allowed.includes(type)) throw new Error(`Plugin cannot create type ${type}`)
      const node = createNode(type as SceneNode['type'], String(props.name ?? type.toLowerCase()))
      const clean = { ...props }
      for (const k of ['id', 'type', 'children', 'sourceId', 'componentId', 'overrides']) delete clean[k]
      Object.assign(node, clean)
      rec.add(node, null, scene.childListOf(null).length)
      return node.id
    },
    /** Update simple props on a node. */
    update: (id: NodeId, props: Record<string, unknown>): void => {
      const clean = { ...props }
      for (const k of ['id', 'type', 'children', 'sourceId', 'componentId', 'overrides']) delete clean[k]
      rec.update(id, clean)
    },
    /** Remove a node (and its subtree). */
    remove: (id: NodeId): void => {
      if (isInsideInstance(scene, id)) throw new Error('Cannot remove nodes inside instances')
      rec.removeSubtree(id)
    },
    notify: (message: string): void => window.alert(`[${file.fileName}] ${message}`),
  }
  try {
    const fn = new Function('polyform', `'use strict';\n${file.text}`)
    fn(api)
    if (rec.ops.length > 0) rec.commit(`Plugin: ${file.fileName}`)
  } catch (err) {
    rec.rollback()
    window.alert(`Plugin "${file.fileName}" failed:\n${String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// SVG import
// ---------------------------------------------------------------------------

export async function importSvgFlow(): Promise<void> {
  await withBusy('Importing SVG…', () => importSvg())
}

async function importSvg(): Promise<void> {
  const files = await window.polyform.svgImportDialog()
  if (!files || files.length === 0) return
  const scene = documentStore.scene
  const { camera, viewportSize } = editor.get()
  const centerWorld = {
    x: camera.x + viewportSize.w / (2 * camera.zoom),
    y: camera.y + viewportSize.h / (2 * camera.zoom),
  }
  const rec = new OpRecorder()
  const created: NodeId[] = []
  let offset = 0
  for (const file of files) {
    const result = importSvgDocument(file.text, file.fileName)
    if (!result) continue
    const dx = centerWorld.x - (result.viewBox.x + result.viewBox.w / 2) + offset
    const dy = centerWorld.y - (result.viewBox.y + result.viewBox.h / 2) + offset
    for (const rid of result.bundle.rootIds) {
      const n = result.bundle.nodes[rid]
      n.x += dx
      n.y += dy
    }
    rec.addBundle(result.bundle, null, scene.childListOf(null).length)
    created.push(...result.bundle.rootIds)
    offset += 24
    if (result.warnings.length > 0) {
      console.warn(`SVG import (${file.fileName}):`, [...new Set(result.warnings)].join('; '))
    }
  }
  if (created.length > 0) {
    rec.commit(files.length === 1 ? 'Import SVG' : `Import ${files.length} SVGs`)
    setSelection(created)
  }
}

/** Sniff a bitmap's type from its own bytes: `.fig` names images by hash, with no extension. */
function imageExtOf(bytes: Uint8Array): string | null {
  const b = bytes
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}

/**
 * Import `.fig` documents — experimental, and it says what it could not carry.
 *
 * Main has already decoded the container (it owns zlib and Zstandard); this side
 * writes the bitmaps into `assets/` as content-addressed files, maps the document
 * onto our nodes, and lands the whole thing as ONE undoable entry. One Ctrl+Z
 * removes an import, however many layers it made.
 */
/**
 * Import one or more `.fig` files.
 *
 * **A Figma page becomes a Polyform page.** Everything used to land on the active
 * page, with each page after the first shoved sideways so they did not overlap —
 * which is a way of coping with pages you have not made rather than making them.
 * The document's own empty starter page is reused for the first one, so importing
 * into a fresh project gives exactly the pages the file has and nothing else.
 */
export async function importFigFlow(paths?: string[]): Promise<void> {
  // The spinner goes up before the file dialog, not after: the dialog is a native
  // window in front of ours, and reading starts the instant it closes — there is no
  // tick in between to paint anything in.
  await withBusy('Importing .fig…', (step) => importFig(paths, step))
}

async function importFig(paths: string[] | undefined, step: (label: string) => Promise<void>): Promise<void> {
  const files = await window.polyform.figImportDialog(paths)
  if (!files || files.length === 0) return
  const scene = documentStore.scene
  const { camera, viewportSize } = editor.get()
  const centerWorld = {
    x: camera.x + viewportSize.w / (2 * camera.zoom),
    y: camera.y + viewportSize.h / (2 * camera.zoom),
  }

  const rec = new OpRecorder()
  const created: NodeId[] = []
  const lines: string[] = []
  let offset = 0
  let firstImportedPage: string | null = null
  // The starter page of an untouched document is fair game for the first imported
  // page; anything the user has already made is not.
  let reusablePage: string | null =
    scene.doc.pages.length === 1 && scene.doc.pages[0].rootIds.length === 0 ? scene.doc.pages[0].id : null

  for (const file of files) {
    if (file.error || !file.root) {
      lines.push(`${file.fileName}: could not be read — ${file.error ?? 'no document inside'}`)
      continue
    }
    // Their SHA-1 → our SHA-256: assets are content-addressed by OUR hash, so the
    // same bitmap imported twice from two files lands once on disk.
    const imageMap = new Map<string, string>()
    const imageCount = Object.keys(file.images).length
    if (imageCount > 0) await step(`${file.fileName}: writing ${imageCount} image${imageCount === 1 ? '' : 's'}…`)
    for (const [figHash, bytes] of Object.entries(file.images)) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>)
      const ext = imageExtOf(data)
      if (!ext) continue
      const written = await window.polyform.assetsWrite(data, ext)
      if (written?.hash) imageMap.set(figHash.toLowerCase(), written.hash)
    }

    await step(`${file.fileName}: reading layers…`)
    const result = mapFigDocument(file.root as Parameters<typeof mapFigDocument>[0], imageMap)
    if (result.bundle.rootIds.length === 0) {
      lines.push(`${file.fileName}: nothing importable found.`)
      continue
    }
    // The long one: several minutes for a few thousand layers, and the reason any
    // of this exists. Named so the wait is legible rather than mysterious.
    const layers = result.report.nodesCreated
    const pageWord = result.pages.length === 1 ? 'page' : 'pages'
    await step(`${file.fileName}: placing ${layers.toLocaleString()} layers on ${result.pages.length} ${pageWord}…`)
    const claimed = new Set<NodeId>()
    for (const page of result.pages) {
      let pageId: string
      if (reusablePage) {
        // Rename rather than add: the page is already there and already active.
        rec.renamePage(reusablePage, page.name)
        pageId = reusablePage
        reusablePage = null
      } else {
        const made = createPage(page.name)
        rec.addPage(made, scene.doc.pages.length)
        pageId = made.id
      }
      if (!firstImportedPage) firstImportedPage = pageId
      // Original coordinates: a page of its own has nothing to collide with, and
      // "where the file put it" is the only placement that survives a re-import.
      rec.addBundle(result.bundle, pageId, scene.childListOf(pageId).length, page.rootIds)
      for (const rid of page.rootIds) claimed.add(rid)
      created.push(...page.rootIds)
    }

    // Anything not under a page of its own — a file with content directly beneath
    // its DOCUMENT — still gets dropped where you are looking, like an SVG import.
    const loose = result.bundle.rootIds.filter((id) => !claimed.has(id))
    if (loose.length > 0) {
      const dx = centerWorld.x - (result.bounds.x + result.bounds.w / 2) + offset
      const dy = centerWorld.y - (result.bounds.y + result.bounds.h / 2) + offset
      for (const rid of loose) {
        const n = result.bundle.nodes[rid]
        n.x += dx
        n.y += dy
      }
      rec.addBundle(result.bundle, null, scene.childListOf(null).length, loose)
      created.push(...loose)
      offset += 24
    }
    const pageNames = result.pages.map((p) => p.name).join(', ')
    lines.push(
      `${file.fileName} (v${file.version}): ${describeFigReport(result.report).join(' ')}` +
        (result.pages.length > 0 ? `\nPages: ${pageNames}.` : ''),
    )
  }

  if (created.length > 0) {
    rec.commit(files.length === 1 ? 'Import .fig' : `Import ${files.length} .fig files`)
    // Land on the first imported page, framed — otherwise the camera is still
    // wherever it was, which for a fresh document is nowhere near the artwork.
    if (firstImportedPage) {
      if (scene.doc.activePageId !== firstImportedPage) switchPage(firstImportedPage)
      setSelection([])
      zoomToFit()
    } else {
      setSelection(created)
    }
  }
  // Said out loud rather than logged: an import that quietly approximated half a
  // document is the thing this feature most needs to be honest about.
  if (lines.length > 0) {
    window.alert(`Imported .fig — experimental\n\n${lines.join('\n\n')}`)
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportTarget {
  format: 'png' | 'svg'
  /** Ignored for SVG, which has no raster size. */
  scale: number
}

/**
 * Render one or more export targets for the current selection.
 *
 * One file still asks where to put it, by name — the common case, and being
 * able to name it matters. Several files ask for a folder ONCE and write them
 * all: a dialog per file is what makes exporting three sizes feel like a chore.
 */
export async function runExports(targets: ExportTarget[]): Promise<void> {
  const scene = documentStore.scene
  let ids = topSelection()
  if (ids.length === 0) ids = scene.rootIds().filter((id) => scene.getNode(id)?.visible)
  if (ids.length === 0 || targets.length === 0) return
  const first = scene.getNode(ids[0])
  const baseName = (ids.length === 1 && first ? first.name : documentStore.projectInfo?.manifest.title || 'export')
    .replace(/[^\w\- ]+/g, '')
    .trim() || 'export'

  const files: { name: string; kind: 'png' | 'svg'; data: Uint8Array }[] = []
  for (const t of targets) {
    if (t.format === 'png') {
      const bytes = await exportPng(scene, documentStore.index, ids, t.scale, assetCache, null)
      if (bytes) files.push({ name: `${baseName}@${t.scale}x.png`, kind: 'png', data: bytes })
    } else {
      const svg = await exportSvg(scene, ids, (hash) => window.polyform.assetsRead(hash))
      files.push({ name: `${baseName}.svg`, kind: 'svg', data: new TextEncoder().encode(svg) })
    }
  }
  if (files.length === 0) return

  if (files.length === 1) {
    const saved = await window.polyform.exportSave(files[0].name, files[0].kind, files[0].data)
    if (saved) setStatus(`Exported ${files[0].name}`)
    return
  }
  const dir = await window.polyform.exportSaveAll(files.map((f) => ({ name: f.name, data: f.data })))
  if (dir) setStatus(`Exported ${files.length} files to ${dir}`)
}

export async function exportSelection(kind: 'png' | 'svg', scale = 1): Promise<void> {
  await runExports([{ format: kind, scale }])
}

// ---------------------------------------------------------------------------
// Menu dispatch
// ---------------------------------------------------------------------------

/**
 * Manual update check.
 *
 * Reports through the platform dialogs rather than a panel of its own: it is a
 * once-in-a-while errand whose answer is one sentence. It never installs
 * anything — `main/updater.ts` says why, and the message it hands back says so
 * to the user too, rather than leaving them wondering where the progress bar is.
 */
export async function checkForUpdatesNow(): Promise<void> {
  const status = await window.polyform.checkUpdates()
  if (status.state === 'available') {
    if (window.confirm(`${status.message}\n\nOpen the release page?`)) void window.polyform.openReleases()
  } else if (status.state === 'current') {
    window.alert(`Polyform ${status.version} is the latest version.`)
  } else if (status.state === 'unsupported') {
    window.alert(status.message ?? 'Update checks only work in an installed build.')
  } else if (status.state === 'error') {
    window.alert(`Could not check for updates.\n\n${status.message ?? ''}`)
  }
}

export function dispatchMenuAction(id: string): void {
  switch (id) {
    case 'file.new':
      void newProjectFlow()
      break
    case 'file.open':
      void openProjectFlow()
      break
    case 'file.save':
      void saveNow()
      break
    case 'file.saveAs':
      void saveAsFlow()
      break
    case 'file.importImage':
      void importImages()
      break
    case 'file.importModel':
      void importModels()
      break
    case 'file.importFig':
      void importFigFlow()
      break
    case 'file.importSvg':
      void importSvgFlow()
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
      void paste()
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
    case 'view.zoomSelection':
      zoomToSelection()
      break
    case 'view.zoomActual':
      zoomActual()
      break
    case 'view.toggleGrid':
      editor.set({ showGrid: !editor.get().showGrid })
      break
    case 'view.toggleRulers':
      editor.set({ showRulers: !editor.get().showRulers })
      break
    case 'view.toggleGpu':
      editor.get().setGpuRender(!editor.get().gpuRender)
      break
    case 'object.toggleMask':
      toggleMaskSelection()
      break
    case 'object.createComponent':
      createComponentFromSelection()
      break
    case 'object.createInstance':
      createInstanceFromSelection()
      break
    case 'object.detachInstance':
      detachSelectedInstances()
      break
    case 'view.history':
      editor.set({ showHistory: !editor.get().showHistory })
      break
    case 'plugins.run':
      void runPluginFlow()
      break
    case 'agent.connection':
      editor.set({ showAgent: !editor.get().showAgent })
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
    case 'object.rotate90':
      rotateSelection(90)
      break
    case 'object.flipH':
      flipSelection('h')
      break
    case 'object.flipV':
      flipSelection('v')
      break
    case 'object.flatten':
      flattenSelection()
      break
    case 'object.carve':
      carveSelection()
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
      // The version is asked for, not written here: this dialog claimed 0.1.0
      // through five releases. __APP_VERSION__ comes from package.json at build
      // time, which is also what the title bar and the welcome screen show.
      void window.polyform.appVersion().then((v) => {
        window.alert(
          `Polyform ${v} — a local-first, open-source vector design tool.\n\n` +
            'MIT licensed. Third-party licences: Help → Third-Party Licences.\n' +
            'https://github.com/AndreaDev3D/Polyform',
        )
      })
      break
    case 'help.checkUpdates':
      void checkForUpdatesNow()
      break
    case 'help.licenses':
      void window.polyform.openLicenses().then((ok) => {
        if (!ok) window.alert('Could not open THIRD-PARTY-NOTICES.md — it should sit beside the app.')
      })
      break
  }
}
