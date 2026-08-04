// Pointer interaction state machine for the canvas viewport: selection,
// move (with snapping + reparenting), resize, rotate, marquee, shape drawing,
// pen paths, text placement, panning, and wheel zoom/pan.

import type {
  EllipseNode,
  ModelPose,
  NodeId,
  SceneNode,
  Vec2,
  VectorNetwork,
  VectorNode,
} from '../engine/types'
import { createNode, isContainer, newId } from '../engine/types'
import { applyMat, clamp, distToSegment, flattenCubic, matInvert, matRotateDeg, type AABB } from '../engine/geometry'
import { documentStore } from '../state/document'
import { editor, type Tool } from '../state/editor'
import { OpRecorder, guidesChanged, setSelection, topSelection } from '../state/actions'
import { findDropFrame, hitTestAll, nearestInstanceAncestor, resolveClickTarget, nodesInRect } from '../engine/hit-test'
import { constrainFrameChildren } from '../engine/constraints'
import type { PatchOp } from '../engine/commands'
import { removeSubtreeOps } from '../engine/commands'
import {
  CORNER_KEYS,
  ROTATE_CURSOR,
  RULER_SIZE,
  arcEditTarget,
  arcHandles,
  arcRadiusFromLocal,
  arcTurnsFromLocal,
  boxHandles,
  canRotate,
  cornerEditTarget,
  cornerHandles,
  cornerRadiusFromLocal,
  hitArcHandle,
  hitCornerHandle,
  hitHandle,
  screenToWorld,
  selectionScreenBox,
  frameLabels,
  worldToScreen,
  type ArcHandleKind,
  type CornerKind,
  type Handle,
  type HandleKind,
} from '../engine/render/overlays'
import { applyMirror, bendEdge, removeEdge, removeVertex } from '../engine/vector-edit'
import { snapBox } from './snapping'

/** Vector-edit hit radii in screen px — generous enough to grab at any zoom. */
const VERTEX_HIT_PX = 7
const EDGE_HIT_PX = 5
/** Bend grabs a wider band: you are aiming at a line, not at a dot. */
const BEND_HIT_PX = 9

interface PointerMods {
  shift: boolean
  alt: boolean
  ctrl: boolean
}

interface DragNodeSnapshot {
  id: NodeId
  props: Record<string, unknown>
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'pan'; lastScreen: Vec2 }
  | { kind: 'marquee'; startWorld: Vec2; additive: boolean; baseSelection: NodeId[] }
  | {
      kind: 'move'
      startWorld: Vec2
      snapshots: DragNodeSnapshot[]
      startBox: AABB
      moved: boolean
      suppressedClickTarget: NodeId | null
    }
  | {
      kind: 'resize'
      handle: HandleKind
      startWorld: Vec2
      startBox: AABB
      snapshots: DragNodeSnapshot[]
      tops: NodeId[]
      single: NodeId | null
    }
  | {
      kind: 'rotate'
      center: Vec2
      startAngle: number
      snapshots: DragNodeSnapshot[]
      worldCenters: Map<NodeId, Vec2>
    }
  | {
      kind: 'arc'
      part: ArcHandleKind
      nodeId: NodeId
      snapshots: DragNodeSnapshot[]
      /** Turns accumulated since pointerdown, unwrapped across the ±180° seam
       *  so a full spin keeps counting instead of snapping back. */
      delta: number
      lastTurns: number
      start0: number
      sweep0: number
      /** Both ends of a whole turn sit in the same place, so which way the
       *  drag opens the arc is undecidable until the pointer actually moves;
       *  the first movement direction resolves it (see pointerMove). */
      wholeTurn: boolean
    }
  | {
      kind: 'corner'
      part: CornerKind
      nodeId: NodeId
      snapshots: DragNodeSnapshot[]
      /** Alt at pointerdown means "all four corners", decided once so the
       *  gesture does not change meaning halfway through. */
      allCorners: boolean
    }
  | { kind: 'draw'; rec: OpRecorder; nodeId: NodeId; startWorld: Vec2; parentId: NodeId | null }
  | { kind: 'pen' }
  | { kind: 'guide'; axis: 'x' | 'y'; index: number }
  | {
      kind: 'vector-vertex'
      vids: number[]
      startWorld: Vec2
      startVerts: Map<number, Vec2>
      startCps: Map<string, Vec2>
    }
  | { kind: 'vector-cp'; edgeIndex: number; key: 'cp0' | 'cp1' }
  /** Bend: the segment and the point along it that follows the pointer. */
  | { kind: 'vector-bend'; edgeIndex: number; t: number }
  | { kind: 'orbit'; nodeId: NodeId; lastScreen: Vec2; before: ModelPose; dolly: boolean }

interface PenAnchor {
  p: Vec2
  handleOut: Vec2 | null
}

const CLICK_SLOP_PX = 4

export class InteractionController {
  private mode: Mode = { kind: 'idle' }
  private penAnchors: PenAnchor[] = []
  private penParent: NodeId | null = null
  private downScreen: Vec2 = { x: 0, y: 0 }
  private lastHoverUpdate = 0
  cursorOverride: string | null = null

  private get scene() {
    return documentStore.scene
  }

  private get index() {
    return documentStore.index
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private snapshotNodes(ids: NodeId[], keys: string[]): DragNodeSnapshot[] {
    const out: DragNodeSnapshot[] = []
    for (const id of ids) {
      const node = this.scene.getNode(id)
      if (!node) continue
      const rec = node as unknown as Record<string, unknown>
      const props: Record<string, unknown> = {}
      for (const k of keys) props[k] = structuredClone(rec[k])
      out.push({ id, props })
    }
    return out
  }

  /** Include descendants for container scaling / frame constraints. */
  private snapshotWithDescendants(ids: NodeId[], keys: string[]): DragNodeSnapshot[] {
    const all = new Set<NodeId>()
    for (const id of ids) {
      all.add(id)
      const node = this.scene.getNode(id)
      if (node && (node.type === 'GROUP' || node.type === 'BOOLEAN' || node.type === 'FRAME')) {
        for (const d of this.scene.descendants(id)) all.add(d)
      }
    }
    return this.snapshotNodes([...all], keys)
  }

  private commitFromSnapshots(snapshots: DragNodeSnapshot[], label: string): void {
    const ops: PatchOp[] = []
    for (const snap of snapshots) {
      const node = this.scene.getNode(snap.id)
      if (!node) continue
      const rec = node as unknown as Record<string, unknown>
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      let changed = false
      for (const key of Object.keys(snap.props)) {
        const prev = snap.props[key]
        const cur = rec[key]
        if (JSON.stringify(prev) !== JSON.stringify(cur)) {
          before[key] = prev
          after[key] = structuredClone(cur)
          changed = true
        }
      }
      if (changed) ops.push({ kind: 'update', id: snap.id, before, after })
    }
    if (ops.length > 0) documentStore.commit(ops, label, true)
  }

  private selectionWorldBox(ids: NodeId[]): AABB {
    let box: AABB | null = null
    for (const id of ids) {
      const b = this.scene.worldAABB(id)
      box = box
        ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) }
        : { ...b }
    }
    return box ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }

  private toolNodeType(tool: Tool): SceneNode['type'] | null {
    switch (tool) {
      case 'frame':
        return 'FRAME'
      case 'rectangle':
        return 'RECTANGLE'
      case 'ellipse':
        return 'ELLIPSE'
      case 'line':
        return 'LINE'
      case 'polygon':
        return 'POLYGON'
      case 'star':
        return 'STAR'
      default:
        return null
    }
  }

  // -----------------------------------------------------------------------
  // Pointer events (screen coords are CSS px relative to the canvas)
  // -----------------------------------------------------------------------

  pointerDown(screen: Vec2, button: number, mods: PointerMods, isDouble: boolean): void {
    const state = editor.get()
    const world = screenToWorld(state.camera, screen)
    this.downScreen = screen
    editor.set({ contextMenu: null })

    // Panning: middle mouse, space-drag, or hand tool.
    if (button === 1 || state.spacePanning || state.tool === 'hand') {
      this.mode = { kind: 'pan', lastScreen: screen }
      this.cursorOverride = 'grabbing'
      return
    }
    if (button !== 0) return

    // Orbit mode: dragging the model spins it; anything else exits.
    if (state.orbitingId && !isDouble) {
      const node = this.scene.getNode(state.orbitingId)
      if (node?.type === 'MODEL3D' && state.tool === 'select' && this.hitsNode(node.id, world)) {
        this.mode = {
          kind: 'orbit',
          nodeId: node.id,
          lastScreen: screen,
          before: { ...node.camera },
          dolly: mods.alt,
        }
        return
      }
      this.exitOrbit()
    }

    // Vector edit mode captures all primary-button interaction.
    if (state.vectorEditId) {
      if (state.tool !== 'select') {
        this.exitVectorEdit(true)
      } else {
        this.vectorPointerDown(screen, world, mods, isDouble)
        return
      }
    }

    // Rulers: drag out a new guide (top ruler -> horizontal, left -> vertical).
    if (state.showRulers && state.tool === 'select') {
      const page = this.scene.activePage
      if (screen.y < RULER_SIZE && screen.x >= RULER_SIZE) {
        page.guides.push({ axis: 'y', pos: Math.round(world.y) })
        this.mode = { kind: 'guide', axis: 'y', index: page.guides.length - 1 }
        guidesChanged()
        return
      }
      if (screen.x < RULER_SIZE && screen.y >= RULER_SIZE) {
        page.guides.push({ axis: 'x', pos: Math.round(world.x) })
        this.mode = { kind: 'guide', axis: 'x', index: page.guides.length - 1 }
        guidesChanged()
        return
      }
      // Grab an existing guide.
      const grabbed = this.guideAt(screen)
      if (grabbed !== null) {
        this.mode = { kind: 'guide', axis: page.guides[grabbed].axis, index: grabbed }
        return
      }
    }

    if (state.tool === 'pen') {
      this.penPointerDown(world)
      return
    }

    if (state.tool === 'text') {
      this.placeText(world)
      return
    }

    const shapeType = this.toolNodeType(state.tool)
    if (shapeType) {
      this.startDrawing(shapeType, world, mods)
      return
    }

    // --- Select tool ---
    if (state.editingTextId) {
      // Clicking outside the text editor: the overlay commits via blur.
      editor.set({ editingTextId: null })
    }

    // 1. Handles on the current selection.
    const box = selectionScreenBox(this.scene, state.selection, state.camera)
    if (box && state.selection.length > 0) {
      const handle = hitHandle(boxHandles(box, canRotate(this.scene, state.selection)), screen)
      if (handle) {
        if (handle.kind.startsWith('rotate')) this.startRotate(handle)
        else this.startResize(handle)
        return
      }
    }

    // 2. Arc handles on a selected ellipse. After the box handles, which sit
    //    on the outline itself; the arc ring handles are inset clear of them.
    const arcNode = arcEditTarget(this.scene, state.selection)
    if (arcNode) {
      const arc = hitArcHandle(arcHandles(this.scene, arcNode, state.camera), screen)
      if (arc) {
        this.startArcDrag(arcNode, arc.kind, world)
        return
      }
    }

    // 3. Corner-radius handles (rounded shapes only).
    const cornerNode = cornerEditTarget(this.scene, state.selection)
    if (cornerNode) {
      const corner = hitCornerHandle(cornerHandles(this.scene, cornerNode, state.camera), screen)
      if (corner) {
        this.mode = {
          kind: 'corner',
          part: corner.kind,
          nodeId: cornerNode.id,
          snapshots: this.snapshotNodes([cornerNode.id], ['cornerRadius']),
          allCorners: mods.alt,
        }
        editor.set({ cornerDrag: corner.kind })
        return
      }
    }

    // 4. Frame name labels.
    for (const label of frameLabels(this.scene, state.camera)) {
      if (
        screen.x >= label.x - 2 &&
        screen.x <= label.x + label.width + 4 &&
        screen.y >= label.y - label.height &&
        screen.y <= label.y + 4
      ) {
        this.beginMove([label.id], world, mods, label.id)
        return
      }
    }

    // 5. Scene hit test.
    const hits = hitTestAll(this.scene, this.index, world, {
      tolerancePx: 4,
      zoom: state.camera.zoom,
    })
    const deepest = hits[0] ?? null

    if (!deepest) {
      // Marquee.
      if (!mods.shift) setSelection([])
      editor.set({ enteredContainer: null })
      this.mode = {
        kind: 'marquee',
        startWorld: world,
        additive: mods.shift,
        baseSelection: mods.shift ? state.selection : [],
      }
      return
    }

    let target: NodeId
    if (mods.ctrl) {
      // Deep select.
      target = deepest
    } else {
      const container =
        state.enteredContainer &&
        this.scene.hasNode(state.enteredContainer) &&
        (this.scene.isAncestorOf(state.enteredContainer, deepest) || state.enteredContainer === deepest)
          ? state.enteredContainer
          : null
      target = resolveClickTarget(this.scene, deepest, container)
      if (target === state.enteredContainer && state.enteredContainer !== null) {
        target = deepest
      }
    }

    if (isDouble) {
      const targetNode = this.scene.getNode(target)
      if (targetNode?.type === 'TEXT') {
        setSelection([target])
        editor.set({ editingTextId: target })
        this.mode = { kind: 'idle' }
        return
      }
      if (targetNode?.type === 'VECTOR') {
        this.enterVectorEdit(target)
        this.mode = { kind: 'idle' }
        return
      }
      if (targetNode?.type === 'MODEL3D') {
        this.enterOrbit(target)
        this.mode = { kind: 'idle' }
        return
      }
      if (targetNode && isContainer(targetNode) && targetNode.type !== 'BOOLEAN') {
        // Drill into the container.
        editor.set({ enteredContainer: target })
        const child = resolveClickTarget(this.scene, deepest, target)
        setSelection([child === target ? deepest : child])
        this.mode = { kind: 'idle' }
        return
      }
    }

    let selection = state.selection
    let suppressed: NodeId | null = null
    if (mods.shift) {
      selection = selection.includes(target) ? selection.filter((s) => s !== target) : [...selection, target]
      setSelection(selection)
    } else if (!selection.includes(target)) {
      selection = [target]
      setSelection(selection)
    } else {
      suppressed = target
    }

    if (selection.length > 0) {
      this.beginMove(topSelection(), world, mods, suppressed)
    }
  }

  private beginMove(ids: NodeId[], world: Vec2, _mods: PointerMods, suppressedClickTarget: NodeId | null): void {
    if (ids.length === 0) return
    // Instance internals cannot be dragged — drag the instance instead.
    const redirected = [
      ...new Set(ids.map((id) => nearestInstanceAncestor(this.scene, id) ?? id)),
    ]
    const locked = redirected.filter((id) => !this.scene.getNode(id)?.locked)
    if (locked.length === 0) return
    this.mode = {
      kind: 'move',
      startWorld: world,
      snapshots: this.snapshotNodes(locked, ['x', 'y']),
      startBox: this.selectionWorldBox(locked),
      moved: false,
      suppressedClickTarget,
    }
  }

  private startResize(handle: Handle): void {
    const ids = topSelection().filter((id) => nearestInstanceAncestor(this.scene, id) === null)
    if (ids.length === 0) return
    const single = ids.length === 1 ? ids[0] : null
    this.mode = {
      kind: 'resize',
      handle: handle.kind,
      startWorld: screenToWorld(editor.get().camera, { x: handle.x, y: handle.y }),
      startBox: this.selectionWorldBox(ids),
      snapshots: this.snapshotWithDescendants(ids, ['x', 'y', 'width', 'height', 'autoResize']),
      tops: ids,
      single,
    }
  }

  private startRotate(handle: Handle): void {
    const ids = topSelection().filter((id) => nearestInstanceAncestor(this.scene, id) === null)
    if (ids.length === 0) return
    const box = this.selectionWorldBox(ids)
    const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
    const camera = editor.get().camera
    const world = screenToWorld(camera, { x: handle.x, y: handle.y })
    const worldCenters = new Map<NodeId, Vec2>()
    for (const id of ids) {
      const node = this.scene.getNode(id)
      if (!node) continue
      worldCenters.set(id, applyMat(this.scene.worldMatrix(id), { x: node.width / 2, y: node.height / 2 }))
    }
    this.mode = {
      kind: 'rotate',
      center,
      startAngle: Math.atan2(world.y - center.y, world.x - center.x),
      snapshots: this.snapshotNodes(ids, ['rotation', 'x', 'y']),
      worldCenters,
    }
    editor.set({ rotating: true })
  }

  /** World point in a node's own space (rotation- and nesting-aware). */
  private toLocal(id: NodeId, world: Vec2): Vec2 {
    return applyMat(matInvert(this.scene.worldMatrix(id)), world)
  }

  private startArcDrag(node: EllipseNode, part: ArcHandleKind, world: Vec2): void {
    this.mode = {
      kind: 'arc',
      part,
      nodeId: node.id,
      snapshots: this.snapshotNodes([node.id], ['arcStart', 'arcSweep', 'arcRatio']),
      delta: 0,
      lastTurns: arcTurnsFromLocal(node, this.toLocal(node.id, world)),
      start0: node.arcStart ?? 0,
      sweep0: clamp(node.arcSweep ?? 1, -1, 1),
      wholeTurn: Math.abs(Math.abs(node.arcSweep ?? 1) - 1) < 1e-6,
    }
    editor.set({ arcDrag: part })
  }

  private startDrawing(type: SceneNode['type'], world: Vec2, _mods: PointerMods): void {
    const rec = new OpRecorder()
    const node = createNode(type, defaultName(type, this.scene))
    const parentId = type === 'FRAME' ? null : findDropFrame(this.scene, this.index, world)
    let local = world
    if (parentId) {
      local = applyMat(matInvert(this.scene.worldMatrix(parentId)), world)
    }
    node.x = local.x
    node.y = local.y
    node.width = type === 'LINE' ? 0.01 : 0.01
    node.height = type === 'LINE' ? 0 : 0.01
    rec.add(node, parentId, this.scene.childListOf(parentId).length)
    documentStore.transient()
    this.mode = { kind: 'draw', rec, nodeId: node.id, startWorld: world, parentId }
    setSelection([node.id])
  }

  private placeText(world: Vec2): void {
    const rec = new OpRecorder()
    const node = createNode('TEXT', 'Text')
    if (node.type !== 'TEXT') return
    const parentId = findDropFrame(this.scene, this.index, world)
    let local = world
    if (parentId) local = applyMat(matInvert(this.scene.worldMatrix(parentId)), world)
    node.x = local.x
    node.y = local.y
    node.width = 1
    node.height = node.fontSize * node.lineHeight
    rec.add(node, parentId, this.scene.childListOf(parentId).length)
    rec.commit('Add Text')
    setSelection([node.id])
    editor.set({ editingTextId: node.id, tool: 'select' })
    this.mode = { kind: 'idle' }
  }

  // -----------------------------------------------------------------------

  pointerMove(screen: Vec2, mods: PointerMods): void {
    const state = editor.get()
    const world = screenToWorld(state.camera, screen)

    switch (this.mode.kind) {
      case 'pan': {
        const dx = (screen.x - this.mode.lastScreen.x) / state.camera.zoom
        const dy = (screen.y - this.mode.lastScreen.y) / state.camera.zoom
        editor.set({ camera: { ...state.camera, x: state.camera.x - dx, y: state.camera.y - dy } })
        this.mode.lastScreen = screen
        return
      }
      case 'marquee': {
        const rect: AABB = {
          minX: Math.min(this.mode.startWorld.x, world.x),
          minY: Math.min(this.mode.startWorld.y, world.y),
          maxX: Math.max(this.mode.startWorld.x, world.x),
          maxY: Math.max(this.mode.startWorld.y, world.y),
        }
        editor.set({ marquee: rect })
        const found = nodesInRect(this.scene, this.index, rect, {
          tolerancePx: 0,
          zoom: state.camera.zoom,
        })
        const merged = this.mode.additive ? [...new Set([...this.mode.baseSelection, ...found])] : found
        setSelection(merged)
        return
      }
      case 'move': {
        let dx = world.x - this.mode.startWorld.x
        let dy = world.y - this.mode.startWorld.y
        if (mods.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        if (!this.mode.moved && Math.hypot(screen.x - this.downScreen.x, screen.y - this.downScreen.y) < CLICK_SLOP_PX) {
          return
        }
        this.mode.moved = true
        // Snap the proposed box.
        const movingIds = new Set(this.mode.snapshots.map((s) => s.id))
        const proposed: AABB = {
          minX: this.mode.startBox.minX + dx,
          minY: this.mode.startBox.minY + dy,
          maxX: this.mode.startBox.maxX + dx,
          maxY: this.mode.startBox.maxY + dy,
        }
        const snap = snapBox(this.scene, movingIds, proposed, state.camera.zoom, mods.ctrl)
        dx += snap.dx
        dy += snap.dy
        editor.set({ guides: snap.guides })
        for (const s of this.mode.snapshots) {
          const node = this.scene.getNode(s.id)
          if (!node) continue
          // Convert world delta into the parent's space (rotation-aware).
          const parentId = this.scene.parentOf(s.id)
          let pdx = dx
          let pdy = dy
          if (parentId) {
            const inv = matInvert(this.scene.worldMatrix(parentId))
            pdx = inv.a * dx + inv.c * dy
            pdy = inv.b * dx + inv.d * dy
          }
          node.x = (s.props.x as number) + pdx
          node.y = (s.props.y as number) + pdy
        }
        this.scene.bump()
        documentStore.transient()
        return
      }
      case 'resize': {
        this.applyResize(world, mods)
        return
      }
      case 'rotate': {
        const angle = Math.atan2(world.y - this.mode.center.y, world.x - this.mode.center.x)
        let deltaDeg = ((angle - this.mode.startAngle) * 180) / Math.PI
        if (mods.shift) deltaDeg = Math.round(deltaDeg / 15) * 15
        const rad = (deltaDeg * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        for (const s of this.mode.snapshots) {
          const node = this.scene.getNode(s.id)
          if (!node) continue
          node.rotation = norm180((s.props.rotation as number) + deltaDeg)
          // Orbit the node's center around the shared selection center so a
          // multi-selection rotates rigidly (no-op for a single node).
          const c0 = this.mode.worldCenters.get(s.id)
          if (c0) {
            const dx = c0.x - this.mode.center.x
            const dy = c0.y - this.mode.center.y
            const cNew = {
              x: this.mode.center.x + dx * cos - dy * sin,
              y: this.mode.center.y + dx * sin + dy * cos,
            }
            const parentId = this.scene.parentOf(s.id)
            const local = parentId ? applyMat(matInvert(this.scene.worldMatrix(parentId)), cNew) : cNew
            node.x = local.x - node.width / 2
            node.y = local.y - node.height / 2
          }
        }
        this.scene.bump()
        documentStore.transient()
        return
      }
      case 'arc': {
        const node = this.scene.getNode(this.mode.nodeId)
        if (!node || node.type !== 'ELLIPSE') return
        const local = this.toLocal(node.id, world)
        if (this.mode.part === 'arc-ratio') {
          const k = arcRadiusFromLocal(node, local)
          node.arcRatio = clamp(mods.shift ? Math.round(k * 20) / 20 : k, 0, 0.99)
        } else {
          const turns = arcTurnsFromLocal(node, local)
          this.mode.delta += wrapTurns(turns - this.mode.lastTurns)
          this.mode.lastTurns = turns
          if (this.mode.wholeTurn && this.mode.delta !== 0) {
            // Opening a whole ellipse: dragging the way the sweep runs carves
            // the arc out of nothing (0 -> the pointer), dragging against it
            // takes a bite out of a full turn instead.
            const dir = Math.sign(this.mode.sweep0) || 1
            this.mode.sweep0 = Math.sign(this.mode.delta) === dir ? 0 : dir
            this.mode.wholeTurn = false
          }
          const snap = (t: number) => (mods.shift ? Math.round(t * 24) / 24 : t)
          if (this.mode.part === 'arc-start') {
            // Move this end, leave the other where it is.
            const raw = snap(this.mode.start0 + this.mode.delta)
            node.arcSweep = clamp(this.mode.start0 + this.mode.sweep0 - raw, -1, 1)
            node.arcStart = wrapTurns(raw)
          } else {
            node.arcSweep = clamp(snap(this.mode.sweep0 + this.mode.delta), -1, 1)
          }
        }
        this.scene.bump()
        documentStore.transient()
        return
      }
      case 'corner': {
        const node = this.scene.getNode(this.mode.nodeId)
        if (!node || !('cornerRadius' in node)) return
        const local = this.toLocal(node.id, world)
        let radius = cornerRadiusFromLocal(node, this.mode.part, local)
        if (mods.shift) radius = Math.round(radius / 4) * 4
        const next = { ...node.cornerRadius }
        if (this.mode.allCorners) {
          next.tl = radius
          next.tr = radius
          next.br = radius
          next.bl = radius
        } else {
          next[CORNER_KEYS[this.mode.part]] = radius
        }
        node.cornerRadius = next
        this.scene.bump()
        documentStore.transient()
        return
      }
      case 'draw': {
        const node = this.scene.getNode(this.mode.nodeId)
        if (!node) return
        const startLocal = this.mode.parentId
          ? applyMat(matInvert(this.scene.worldMatrix(this.mode.parentId)), this.mode.startWorld)
          : this.mode.startWorld
        const curLocal = this.mode.parentId
          ? applyMat(matInvert(this.scene.worldMatrix(this.mode.parentId)), world)
          : world
        if (node.type === 'LINE') {
          const ddx = curLocal.x - startLocal.x
          const ddy = curLocal.y - startLocal.y
          let angle = (Math.atan2(ddy, ddx) * 180) / Math.PI
          if (mods.shift) angle = Math.round(angle / 45) * 45
          const len = Math.hypot(ddx, ddy)
          const rad = (angle * Math.PI) / 180
          // Line runs from (0,0) to (width,0); rotation is about the center,
          // so recompute x/y such that the start stays under the cursor start.
          node.width = Math.max(0.01, len)
          node.rotation = angle
          const cx = startLocal.x + (len / 2) * Math.cos(rad)
          const cy = startLocal.y + (len / 2) * Math.sin(rad)
          node.x = cx - node.width / 2
          node.y = cy
        } else {
          let w = curLocal.x - startLocal.x
          let h = curLocal.y - startLocal.y
          if (mods.shift) {
            const m = Math.max(Math.abs(w), Math.abs(h))
            w = Math.sign(w || 1) * m
            h = Math.sign(h || 1) * m
          }
          node.x = Math.min(startLocal.x, startLocal.x + w)
          node.y = Math.min(startLocal.y, startLocal.y + h)
          node.width = Math.max(0.01, Math.abs(w))
          node.height = Math.max(0.01, Math.abs(h))
        }
        this.scene.bump()
        documentStore.transient()
        return
      }
      case 'pen': {
        this.updatePenPreview(world, state.camera.zoom)
        return
      }
      case 'guide': {
        const page = this.scene.activePage
        const guide = page.guides[this.mode.index]
        if (guide) {
          guide.pos = Math.round(this.mode.axis === 'x' ? world.x : world.y)
          guidesChanged()
        }
        this.cursorOverride = this.mode.axis === 'x' ? 'ew-resize' : 'ns-resize'
        return
      }
      case 'vector-vertex': {
        const id = editor.get().vectorEditId
        const node = id ? this.scene.getNode(id) : null
        if (!node || node.type !== 'VECTOR') return
        const inv = matInvert(this.scene.worldMatrix(node.id))
        const dx = inv.a * (world.x - this.mode.startWorld.x) + inv.c * (world.y - this.mode.startWorld.y)
        const dy = inv.b * (world.x - this.mode.startWorld.x) + inv.d * (world.y - this.mode.startWorld.y)
        const moving = new Set(this.mode.vids)
        for (const v of node.network.vertices) {
          const start = this.mode.startVerts.get(v.id)
          if (!start || !moving.has(v.id)) continue
          v.x = start.x + dx
          v.y = start.y + dy
        }
        node.network.edges.forEach((e, i) => {
          const cp0Start = this.mode.kind === 'vector-vertex' ? this.mode.startCps.get(`${i}:cp0`) : null
          const cp1Start = this.mode.kind === 'vector-vertex' ? this.mode.startCps.get(`${i}:cp1`) : null
          if (e.cp0 && cp0Start && moving.has(e.v0)) e.cp0 = { x: cp0Start.x + dx, y: cp0Start.y + dy }
          if (e.cp1 && cp1Start && moving.has(e.v1)) e.cp1 = { x: cp1Start.x + dx, y: cp1Start.y + dy }
        })
        this.scene.bump()
        documentStore.transient()
        return
      }
      case 'orbit': {
        const node = this.scene.getNode(this.mode.nodeId)
        if (!node || node.type !== 'MODEL3D') return
        const dx = screen.x - this.mode.lastScreen.x
        const dy = screen.y - this.mode.lastScreen.y
        this.mode.lastScreen = screen
        if (this.mode.dolly) {
          // Alt-drag pulls the camera in and out (multiplicative so the
          // feel is even across scales).
          node.camera.distance = clamp(node.camera.distance * Math.exp(dy * 0.005), 0.2, 8)
        } else {
          node.camera.yaw = (node.camera.yaw - dx * 0.4) % 360
          node.camera.pitch = clamp(node.camera.pitch + dy * 0.4, -89, 89)
        }
        this.scene.bump()
        documentStore.transient()
        return
      }
      case 'vector-cp': {
        const id = editor.get().vectorEditId
        const node = id ? this.scene.getNode(id) : null
        if (!node || node.type !== 'VECTOR') return
        const local = applyMat(matInvert(this.scene.worldMatrix(node.id)), world)
        const edge = node.network.edges[this.mode.edgeIndex]
        if (edge) {
          edge[this.mode.key] = { x: local.x, y: local.y }
          // Alt breaks the pairing for this drag without changing the point's
          // mode — the standard escape hatch for "just this once".
          if (!mods.alt) applyMirror(node.network, this.mode.edgeIndex, this.mode.key)
          this.scene.bump()
          documentStore.transient()
        }
        return
      }
      case 'vector-bend': {
        const id = editor.get().vectorEditId
        const node = id ? this.scene.getNode(id) : null
        if (!node || node.type !== 'VECTOR') return
        const local = applyMat(matInvert(this.scene.worldMatrix(node.id)), world)
        bendEdge(node.network, this.mode.edgeIndex, this.mode.t, local)
        this.scene.bump()
        documentStore.transient()
        return
      }
      case 'idle': {
        // The pen rubber-band must track the cursor between clicks too
        // (mode returns to idle after each anchor is placed).
        if (state.tool === 'pen' && state.penDraft) {
          this.updatePenPreview(world, state.camera.zoom)
          return
        }
        // Hover + cursor updates, throttled.
        const now = performance.now()
        if (now - this.lastHoverUpdate < 30) return
        this.lastHoverUpdate = now
        this.updateHoverAndCursor(screen, world)
        return
      }
    }
  }

  private updatePenPreview(world: Vec2, zoom: number): void {
    const draft = editor.get().penDraft
    if (!draft) return
    editor.set({
      penDraft: {
        ...draft,
        cursor: world,
        closable:
          this.penAnchors.length >= 3 &&
          Math.hypot((world.x - this.penAnchors[0].p.x) * zoom, (world.y - this.penAnchors[0].p.y) * zoom) < 8,
      },
    })
  }

  private updateHoverAndCursor(screen: Vec2, world: Vec2): void {
    const state = editor.get()
    if (state.vectorEditId) {
      if (state.hover) editor.set({ hover: null })
      this.cursorOverride = 'crosshair'
      return
    }
    if (state.tool !== 'select') {
      if (state.hover) editor.set({ hover: null })
      this.cursorOverride = state.tool === 'hand' ? 'grab' : 'crosshair'
      return
    }
    this.cursorOverride = null
    if (state.showRulers) {
      if (screen.x < RULER_SIZE || screen.y < RULER_SIZE) {
        this.cursorOverride = screen.y < RULER_SIZE && screen.x >= RULER_SIZE ? 'ns-resize' : screen.x < RULER_SIZE && screen.y >= RULER_SIZE ? 'ew-resize' : null
        if (state.hover) editor.set({ hover: null })
        return
      }
      const gi = this.guideAt(screen)
      if (gi !== null) {
        this.cursorOverride = this.scene.activePage.guides[gi].axis === 'x' ? 'ew-resize' : 'ns-resize'
        if (state.hover) editor.set({ hover: null })
        return
      }
    }
    const box = selectionScreenBox(this.scene, state.selection, state.camera)
    if (box && state.selection.length > 0) {
      const handle = hitHandle(boxHandles(box, canRotate(this.scene, state.selection)), screen)
      if (handle) {
        this.cursorOverride = handle.cursor
        if (state.hover) editor.set({ hover: null })
        return
      }
    }
    const arcNode = arcEditTarget(this.scene, state.selection)
    if (arcNode && hitArcHandle(arcHandles(this.scene, arcNode, state.camera), screen)) {
      this.cursorOverride = 'crosshair'
      if (state.hover) editor.set({ hover: null })
      return
    }
    const cornerNode = cornerEditTarget(this.scene, state.selection)
    if (cornerNode && hitCornerHandle(cornerHandles(this.scene, cornerNode, state.camera), screen)) {
      this.cursorOverride = 'crosshair'
      if (state.hover) editor.set({ hover: null })
      return
    }
    const hits = hitTestAll(this.scene, this.index, world, { tolerancePx: 4, zoom: state.camera.zoom })
    const deepest = hits[0] ?? null
    let hover: NodeId | null = null
    if (deepest) {
      const container =
        state.enteredContainer && this.scene.hasNode(state.enteredContainer) && this.scene.isAncestorOf(state.enteredContainer, deepest)
          ? state.enteredContainer
          : null
      hover = resolveClickTarget(this.scene, deepest, container)
    }
    if (hover !== state.hover) editor.set({ hover })
  }

  private applyResize(world: Vec2, mods: PointerMods): void {
    if (this.mode.kind !== 'resize') return
    const { handle, startBox, single } = this.mode
    const scene = this.scene

    if (single) {
      const node = scene.getNode(single)
      if (!node) return
      const snap = this.mode.snapshots.find((s) => s.id === single)!
      const rot = node.rotation
      const w0 = snap.props.width as number
      const h0 = snap.props.height as number
      const x0 = snap.props.x as number
      const y0 = snap.props.y as number
      // Pointer in the node's start-local space.
      const parentId = scene.parentOf(single)
      const parentMat = parentId ? scene.worldMatrix(parentId) : null
      const localOfParent = parentMat ? applyMat(matInvert(parentMat), world) : world
      // Undo the start rotation about the start center.
      const c0 = { x: x0 + w0 / 2, y: y0 + h0 / 2 }
      const invRot = matRotateDeg(-rot)
      const rel = { x: localOfParent.x - c0.x, y: localOfParent.y - c0.y }
      const un = applyMat(invRot, rel)
      const pLocal = { x: un.x + w0 / 2, y: un.y + h0 / 2 }

      let newW = w0
      let newH = h0
      let anchorLocal = { x: 0, y: 0 }
      const affectsW = handle.includes('e') || handle.includes('w')
      const affectsH = handle.includes('n') || handle.includes('s')
      if (handle.includes('e')) {
        newW = pLocal.x
        anchorLocal.x = 0
      } else if (handle.includes('w')) {
        newW = w0 - pLocal.x
        anchorLocal.x = w0
      }
      if (handle.includes('s')) {
        newH = pLocal.y
        anchorLocal.y = 0
      } else if (handle.includes('n')) {
        newH = h0 - pLocal.y
        anchorLocal.y = h0
      }
      if (handle === 'n' || handle === 's') anchorLocal.x = w0 / 2
      if (handle === 'e' || handle === 'w') anchorLocal.y = h0 / 2
      if (mods.shift && affectsW && affectsH && h0 > 0.01) {
        const ratio = w0 / h0
        if (Math.abs(newW / Math.max(newH, 0.01)) > ratio) newH = newW / ratio
        else newW = newH * ratio
      }
      newW = Math.max(0.5, newW)
      newH = node.type === 'LINE' ? 0 : Math.max(0.5, newH)

      // Keep the anchor point stationary (in parent space).
      const anchorWorldBefore = anchorPointInParent(x0, y0, w0, h0, rot, anchorLocal)
      const anchorLocalAfter = {
        x: anchorLocal.x === 0 ? 0 : anchorLocal.x === w0 ? newW : (anchorLocal.x / w0) * newW,
        y: anchorLocal.y === 0 ? 0 : anchorLocal.y === h0 ? newH : (anchorLocal.y / h0) * newH,
      }
      // Solve x,y: parentPt = (x,y) + c + R(a - c), where c = (newW/2,newH/2).
      const cNew = { x: newW / 2, y: newH / 2 }
      const rotMat = matRotateDeg(rot)
      const rotated = applyMat(rotMat, { x: anchorLocalAfter.x - cNew.x, y: anchorLocalAfter.y - cNew.y })
      node.x = anchorWorldBefore.x - cNew.x - rotated.x
      node.y = anchorWorldBefore.y - cNew.y - rotated.y
      node.width = newW
      node.height = newH
      if (node.type === 'TEXT' && node.autoResize === 'WIDTH_AND_HEIGHT' && affectsW) {
        node.autoResize = 'HEIGHT'
      }
      // Scale children of groups/booleans proportionally; constrain frame
      // children per their pin/scale constraints.
      if (node.type === 'GROUP' || node.type === 'BOOLEAN') {
        scaleChildren(scene, this.mode.snapshots, node.id, newW / w0, newH / h0)
      } else if (node.type === 'FRAME') {
        constrainFrameChildren(scene, node, this.snapLookup(this.mode.snapshots), w0, h0)
      }
      this.scene.bump()
      documentStore.transient()
      return
    }

    // Multi-selection: world-box scaling.
    let minX = startBox.minX
    let minY = startBox.minY
    let maxX = startBox.maxX
    let maxY = startBox.maxY
    if (handle.includes('e')) maxX = world.x
    if (handle.includes('w')) minX = world.x
    if (handle.includes('s')) maxY = world.y
    if (handle.includes('n')) minY = world.y
    const w0 = startBox.maxX - startBox.minX
    const h0 = startBox.maxY - startBox.minY
    if (w0 < 0.01 || h0 < 0.01) return
    let sx = (maxX - minX) / w0
    let sy = (maxY - minY) / h0
    if (mods.shift) {
      const s = Math.max(Math.abs(sx), Math.abs(sy))
      sx = Math.sign(sx || 1) * s
      sy = Math.sign(sy || 1) * s
    }
    sx = Math.max(0.01, sx)
    sy = Math.max(0.01, sy)
    const anchorX = handle.includes('w') ? startBox.maxX : startBox.minX
    const anchorY = handle.includes('n') ? startBox.maxY : startBox.minY
    // Only scale the top-level selected nodes directly; their descendants
    // (in snapshots for undo diffing) are scaled via scaleChildren in the
    // container's LOCAL space — never with the world anchor.
    for (const id of this.mode.tops) {
      const s = this.mode.snapshots.find((snap) => snap.id === id)
      const node = scene.getNode(id)
      if (!s || !node) continue
      const px = s.props.x as number
      const py = s.props.y as number
      const pw = (s.props.width as number) ?? node.width
      const ph = (s.props.height as number) ?? node.height
      // Express the world anchor in this node's parent space.
      let ax = anchorX
      let ay = anchorY
      const parentId = scene.parentOf(id)
      if (parentId) {
        const a = applyMat(matInvert(scene.worldMatrix(parentId)), { x: anchorX, y: anchorY })
        ax = a.x
        ay = a.y
      }
      node.x = ax + (px - ax) * sx
      node.y = ay + (py - ay) * sy
      node.width = Math.max(0.5, pw * sx)
      node.height = node.type === 'LINE' ? 0 : Math.max(0.5, ph * sy)
      if (node.type === 'GROUP' || node.type === 'BOOLEAN') {
        scaleChildren(scene, this.mode.snapshots, node.id, sx, sy)
      } else if (node.type === 'FRAME') {
        constrainFrameChildren(scene, node, this.snapLookup(this.mode.snapshots), pw, ph)
      }
    }
    this.scene.bump()
    documentStore.transient()
  }

  /** Snapshot lookup adapter for the constraints engine. */
  private snapLookup(snapshots: DragNodeSnapshot[]) {
    const map = new Map(snapshots.map((s) => [s.id, s.props]))
    return (id: NodeId) => {
      const p = map.get(id)
      if (!p || p.x === undefined) return null
      return { x: p.x as number, y: p.y as number, width: p.width as number, height: p.height as number }
    }
  }

  // -----------------------------------------------------------------------

  pointerUp(screen: Vec2, mods: PointerMods): void {
    const state = editor.get()
    const world = screenToWorld(state.camera, screen)

    switch (this.mode.kind) {
      case 'pan':
        this.cursorOverride = null
        break
      case 'marquee':
        editor.set({ marquee: null })
        break
      case 'move': {
        editor.set({ guides: [] })
        if (this.mode.moved) {
          // Reparent if dropped over a different frame.
          const movingIds = this.mode.snapshots.map((s) => s.id)
          const exclude = new Set(movingIds)
          const dropFrame = findDropFrame(this.scene, this.index, world, exclude)
          const rec = new OpRecorder()
          this.commitFromSnapshots(this.mode.snapshots, 'Move')
          for (const id of movingIds) {
            const node = this.scene.getNode(id)
            if (!node || node.type === 'FRAME') continue
            const curParent = this.scene.parentOf(id)
            if (dropFrame !== curParent && dropFrame !== id) {
              const worldCenter = applyMat(this.scene.worldMatrix(id), { x: node.width / 2, y: node.height / 2 })
              rec.move(id, dropFrame, this.scene.childListOf(dropFrame).length)
              const inv = dropFrame ? matInvert(this.scene.worldMatrix(dropFrame)) : null
              const c = inv ? applyMat(inv, worldCenter) : worldCenter
              rec.update(id, { x: c.x - node.width / 2, y: c.y - node.height / 2 })
            }
          }
          if (rec.ops.length > 0) rec.commit('Move into Frame')
        } else if (this.mode.suppressedClickTarget && !mods.shift) {
          // Click (no drag) on an already-selected node narrows selection.
          setSelection([this.mode.suppressedClickTarget])
        }
        break
      }
      case 'resize':
        this.commitFromSnapshots(this.mode.snapshots, 'Resize')
        break
      case 'rotate':
        editor.set({ rotating: false })
        this.commitFromSnapshots(this.mode.snapshots, 'Rotate')
        break
      case 'arc':
        editor.set({ arcDrag: null })
        this.commitFromSnapshots(this.mode.snapshots, 'Edit Arc')
        break
      case 'corner':
        editor.set({ cornerDrag: null })
        this.commitFromSnapshots(this.mode.snapshots, 'Corner Radius')
        break
      case 'draw': {
        const node = this.scene.getNode(this.mode.nodeId)
        if (node) {
          if (node.width < 2 && node.height < 2 && node.type !== 'LINE') {
            // Click without drag: default size.
            node.width = node.type === 'FRAME' ? 375 : 100
            node.height = node.type === 'FRAME' ? 667 : 100
            this.scene.bump()
          } else if (node.type === 'LINE' && node.width < 2) {
            node.width = 100
            this.scene.bump()
          }
        }
        // Re-capture the final node state into the add op so redo restores
        // the drawn size, not the 0.01px creation stub.
        this.mode.rec.refreshAddSnapshots()
        this.mode.rec.commit(`Draw ${node?.type.toLowerCase() ?? 'shape'}`)
        editor.set({ tool: 'select' })
        break
      }
      case 'pen':
        // Anchors are added on pointerDown; nothing to finalize here.
        this.mode = { kind: 'idle' }
        return
      case 'guide': {
        // Dropping a guide back onto a ruler removes it.
        const page = this.scene.activePage
        if (screen.x < RULER_SIZE || screen.y < RULER_SIZE) {
          page.guides.splice(this.mode.index, 1)
        }
        guidesChanged()
        this.cursorOverride = null
        break
      }
      case 'vector-vertex':
      case 'vector-cp':
      case 'vector-bend':
        this.commitVectorGesture()
        break
      case 'orbit': {
        const { nodeId, before } = this.mode
        const node = this.scene.getNode(nodeId)
        if (node?.type === 'MODEL3D' && JSON.stringify(node.camera) !== JSON.stringify(before)) {
          documentStore.commit(
            [{ kind: 'update', id: nodeId, before: { camera: before }, after: { camera: { ...node.camera } } }],
            'Orbit Model',
            true,
          )
        }
        break
      }
      case 'idle':
        break
    }
    if (this.mode.kind !== 'idle') this.mode = { kind: 'idle' }
  }

  // -----------------------------------------------------------------------
  // Pen tool
  // -----------------------------------------------------------------------

  private penPointerDown(world: Vec2): void {
    const state = editor.get()
    const zoom = state.camera.zoom
    if (
      this.penAnchors.length >= 3 &&
      Math.hypot((world.x - this.penAnchors[0].p.x) * zoom, (world.y - this.penAnchors[0].p.y) * zoom) < 8
    ) {
      this.finishPen(true)
      return
    }
    if (this.penAnchors.length === 0) {
      this.penParent = findDropFrame(this.scene, this.index, world)
    }
    this.penAnchors.push({ p: world, handleOut: null })
    editor.set({
      penDraft: {
        anchors: this.penAnchors.map((a) => a.p),
        cursor: world,
        closable: false,
      },
    })
    this.mode = { kind: 'pen' }
  }

  finishPen(close: boolean): void {
    const anchors = this.penAnchors
    this.penAnchors = []
    editor.set({ penDraft: null })
    this.mode = { kind: 'idle' }
    if (anchors.length < 2) return

    // Build the vector network in node-local coordinates.
    const xs = anchors.map((a) => a.p.x)
    const ys = anchors.map((a) => a.p.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const network: VectorNetwork = { vertices: [], edges: [] }
    anchors.forEach((a, i) => {
      network.vertices.push({ id: i, x: a.p.x - minX, y: a.p.y - minY })
    })
    const segCount = close ? anchors.length : anchors.length - 1
    for (let i = 0; i < segCount; i++) {
      const a = anchors[i]
      const b = anchors[(i + 1) % anchors.length]
      const cp0 = a.handleOut ? { x: a.handleOut.x - minX, y: a.handleOut.y - minY } : null
      const cp1 = b.handleOut
        ? { x: 2 * (b.p.x - minX) - (b.handleOut.x - minX), y: 2 * (b.p.y - minY) - (b.handleOut.y - minY) }
        : null
      network.edges.push({ id: i, v0: i, v1: (i + 1) % anchors.length, cp0, cp1 })
    }

    const node = createNode('VECTOR', 'Vector')
    if (node.type !== 'VECTOR') return
    node.network = network
    node.width = Math.max(1, Math.max(...xs) - minX)
    node.height = Math.max(1, Math.max(...ys) - minY)
    if (close) {
      node.fills = [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } }]
    }
    let x = minX
    let y = minY
    const parentId = this.penParent && this.scene.hasNode(this.penParent) ? this.penParent : null
    if (parentId) {
      const local = applyMat(matInvert(this.scene.worldMatrix(parentId)), { x: minX, y: minY })
      x = local.x
      y = local.y
    }
    node.x = x
    node.y = y
    const rec = new OpRecorder()
    rec.add(node, parentId, this.scene.childListOf(parentId).length)
    rec.commit('Draw Vector')
    setSelection([node.id])
    editor.set({ tool: 'select' })
  }

  cancelPen(): void {
    this.penAnchors = []
    editor.set({ penDraft: null })
    if (this.mode.kind === 'pen') this.mode = { kind: 'idle' }
  }

  // -----------------------------------------------------------------------
  // Guides
  // -----------------------------------------------------------------------

  /** Index of the page guide under the pointer (screen coords), or null. */
  private guideAt(screen: Vec2): number | null {
    const { camera } = editor.get()
    const guides = this.scene.activePage.guides
    for (let i = 0; i < guides.length; i++) {
      const g = guides[i]
      const s = g.axis === 'x' ? (g.pos - camera.x) * camera.zoom : (g.pos - camera.y) * camera.zoom
      const p = g.axis === 'x' ? screen.x : screen.y
      if (Math.abs(p - s) <= 4) return i
    }
    return null
  }

  // -----------------------------------------------------------------------
  // Vector edit mode
  // -----------------------------------------------------------------------

  private gestureNetwork: VectorNetwork | null = null

  /** Enter orbit mode on a 3D model (double-click, like vector edit). */
  enterOrbit(id: NodeId): void {
    const node = this.scene.getNode(id)
    if (!node || node.type !== 'MODEL3D') return
    editor.set({ orbitingId: id, selection: [id], tool: 'select' })
  }

  exitOrbit(): void {
    if (editor.get().orbitingId) editor.set({ orbitingId: null })
  }

  /** Point-in-node test in world space (orbit hit uses the node's box). */
  private hitsNode(id: NodeId, world: Vec2): boolean {
    const local = applyMat(matInvert(this.scene.worldMatrix(id)), world)
    const node = this.scene.getNode(id)
    if (!node) return false
    return local.x >= 0 && local.y >= 0 && local.x <= node.width && local.y <= node.height
  }

  enterVectorEdit(id: NodeId): void {
    const node = this.scene.getNode(id)
    if (!node || node.type !== 'VECTOR') return
    editor.set({ vectorEditId: id, vectorSelection: [], selection: [id], tool: 'select' })
  }

  /** Exit edit mode; when committing, normalize the node's bbox. */
  exitVectorEdit(commit: boolean): void {
    const id = editor.get().vectorEditId
    // vectorMode resets here too: leaving a path in Delete mode and coming back
    // to it later, still armed to delete, is a trap. (This sets the state
    // directly rather than going through setVectorEditId, so the reset has to
    // be spelled out — the store's setter does the same thing.)
    editor.set({ vectorEditId: null, vectorSelection: [], vectorMode: 'move' })
    this.gestureNetwork = null
    if (!id || !commit) return
    const node = this.scene.getNode(id)
    if (!node || node.type !== 'VECTOR') return
    if (node.network.vertices.length === 0) {
      // Everything was deleted — remove the empty node.
      const ops = removeSubtreeOps(this.scene, id)
      for (const op of ops) if (op.kind === 'remove') this.scene.removeNode(op.node.id)
      documentStore.commit(ops, 'Delete Vector', true)
      setSelection([])
      return
    }
    if (node.rotation !== 0) return
    // Normalize: shift network so its bbox starts at (0,0), move the node.
    const pts: Vec2[] = node.network.vertices.map((v) => ({ x: v.x, y: v.y }))
    for (const e of node.network.edges) {
      if (e.cp0) pts.push(e.cp0)
      if (e.cp1) pts.push(e.cp1)
    }
    const minX = Math.min(...pts.map((p) => p.x))
    const minY = Math.min(...pts.map((p) => p.y))
    const maxX = Math.max(...pts.map((p) => p.x))
    const maxY = Math.max(...pts.map((p) => p.y))
    const before = {
      network: structuredClone(node.network),
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }
    if (Math.abs(minX) < 1e-6 && Math.abs(minY) < 1e-6 && Math.abs(node.width - (maxX - minX)) < 1e-6 && Math.abs(node.height - (maxY - minY)) < 1e-6) {
      return
    }
    // Shift a COPY and land it through updateNode, which invalidates the
    // world-matrix and AABB caches by contract. Writing node.x directly (which
    // this did) left the selection box drawing at the pre-edit position with
    // the post-edit size, until something else happened to bump the scene.
    const shifted = structuredClone(node.network)
    for (const v of shifted.vertices) {
      v.x -= minX
      v.y -= minY
    }
    for (const e of shifted.edges) {
      if (e.cp0) e.cp0 = { x: e.cp0.x - minX, y: e.cp0.y - minY }
      if (e.cp1) e.cp1 = { x: e.cp1.x - minX, y: e.cp1.y - minY }
    }
    const after = {
      network: shifted,
      x: node.x + minX,
      y: node.y + minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    }
    this.scene.updateNode(id, after as unknown as Partial<SceneNode>)
    documentStore.commit(
      [
        {
          kind: 'update',
          id,
          before: before as unknown as Record<string, unknown>,
          after: structuredClone(after) as unknown as Record<string, unknown>,
        },
      ],
      'Edit Vector',
      true,
    )
  }

  private vectorPointerDown(screen: Vec2, world: Vec2, mods: PointerMods, isDouble: boolean): void {
    const state = editor.get()
    const id = state.vectorEditId!
    const node = this.scene.getNode(id)
    if (!node || node.type !== 'VECTOR') {
      this.exitVectorEdit(false)
      return
    }
    const m = this.scene.worldMatrix(id)
    const toScreen = (p: Vec2) => worldToScreen(state.camera, applyMat(m, p))
    const net = node.network
    const selected = new Set(state.vectorSelection)

    // Delete mode: a click removes what it lands on, points before segments.
    if (state.vectorMode === 'delete') {
      for (const v of net.vertices) {
        const s = toScreen({ x: v.x, y: v.y })
        if (Math.hypot(s.x - screen.x, s.y - screen.y) <= VERTEX_HIT_PX) {
          const before = structuredClone(net)
          removeVertex(net, v.id)
          this.commitVectorChange(node, before, 'Delete Point')
          editor.set({ vectorSelection: state.vectorSelection.filter((x) => x !== v.id) })
          return
        }
      }
      const onEdge = this.nearestEdgePoint(node, screen, state.camera.zoom)
      if (onEdge && onEdge.distPx <= EDGE_HIT_PX) {
        const before = structuredClone(net)
        removeEdge(net, onEdge.edgeIndex)
        this.commitVectorChange(node, before, 'Delete Segment')
      }
      return
    }

    // Bend mode: dragging a segment pulls the curve to the pointer. Points and
    // handles still drag, so you are not forced back to Move to nudge one.
    if (state.vectorMode === 'bend') {
      const onVertexOrHandle = this.vectorHandleAt(node, screen, selected)
      if (!onVertexOrHandle) {
        const hit = this.nearestEdgePoint(node, screen, state.camera.zoom)
        if (hit && hit.distPx <= BEND_HIT_PX) {
          this.gestureNetwork = structuredClone(net)
          this.mode = { kind: 'vector-bend', edgeIndex: hit.edgeIndex, t: hit.t }
          return
        }
        editor.set({ vectorSelection: [] })
        return
      }
    }

    // 1. Vertices.
    for (const v of net.vertices) {
      const s = toScreen({ x: v.x, y: v.y })
      if (Math.hypot(s.x - screen.x, s.y - screen.y) <= VERTEX_HIT_PX) {
        let sel: number[]
        if (mods.shift) {
          sel = selected.has(v.id) ? state.vectorSelection.filter((x) => x !== v.id) : [...state.vectorSelection, v.id]
        } else {
          sel = selected.has(v.id) ? state.vectorSelection : [v.id]
        }
        editor.set({ vectorSelection: sel })
        this.beginVectorVertexDrag(node, sel, world)
        return
      }
    }

    // 2. Control points of edges touching selected vertices.
    for (let i = 0; i < net.edges.length; i++) {
      const e = net.edges[i]
      if (e.cp0 && selected.has(e.v0)) {
        const s = toScreen(e.cp0)
        if (Math.hypot(s.x - screen.x, s.y - screen.y) <= 6) {
          this.gestureNetwork = structuredClone(net)
          this.mode = { kind: 'vector-cp', edgeIndex: i, key: 'cp0' }
          return
        }
      }
      if (e.cp1 && selected.has(e.v1)) {
        const s = toScreen(e.cp1)
        if (Math.hypot(s.x - screen.x, s.y - screen.y) <= 6) {
          this.gestureNetwork = structuredClone(net)
          this.mode = { kind: 'vector-cp', edgeIndex: i, key: 'cp1' }
          return
        }
      }
    }

    // 3. Edges: click to insert a vertex at the nearest curve point.
    const hit = this.nearestEdgePoint(node, screen, state.camera.zoom)
    if (hit && hit.distPx <= EDGE_HIT_PX) {
      this.gestureNetwork = structuredClone(net)
      const vid = this.splitEdge(node, hit.edgeIndex, hit.t)
      editor.set({ vectorSelection: [vid] })
      this.scene.bump()
      documentStore.transient()
      this.beginVectorVertexDrag(node, [vid], world, this.gestureNetwork)
      return
    }

    // 4. Empty space.
    if (isDouble) {
      this.exitVectorEdit(true)
    } else {
      editor.set({ vectorSelection: [] })
    }
  }

  /** True when the pointer is on a vertex or on a visible control handle. */
  private vectorHandleAt(node: VectorNode, screen: Vec2, selected: Set<number>): boolean {
    const state = editor.get()
    const m = this.scene.worldMatrix(node.id)
    const toScreen = (p: Vec2) => worldToScreen(state.camera, applyMat(m, p))
    for (const v of node.network.vertices) {
      const s = toScreen({ x: v.x, y: v.y })
      if (Math.hypot(s.x - screen.x, s.y - screen.y) <= VERTEX_HIT_PX) return true
    }
    for (const e of node.network.edges) {
      if (e.cp0 && selected.has(e.v0)) {
        const s = toScreen(e.cp0)
        if (Math.hypot(s.x - screen.x, s.y - screen.y) <= VERTEX_HIT_PX) return true
      }
      if (e.cp1 && selected.has(e.v1)) {
        const s = toScreen(e.cp1)
        if (Math.hypot(s.x - screen.x, s.y - screen.y) <= VERTEX_HIT_PX) return true
      }
    }
    return false
  }

  /** Land a whole-network change as one history entry. */
  private commitVectorChange(node: VectorNode, before: VectorNetwork, label: string): void {
    this.scene.bump()
    documentStore.commit(
      [{ kind: 'update', id: node.id, before: { network: before }, after: { network: structuredClone(node.network) } }],
      label,
      true,
    )
  }

  private beginVectorVertexDrag(node: VectorNode, vids: number[], world: Vec2, presetGesture?: VectorNetwork): void {
    this.gestureNetwork = presetGesture ?? structuredClone(node.network)
    const startVerts = new Map<number, Vec2>()
    for (const v of node.network.vertices) startVerts.set(v.id, { x: v.x, y: v.y })
    const startCps = new Map<string, Vec2>()
    node.network.edges.forEach((e, i) => {
      if (e.cp0) startCps.set(`${i}:cp0`, { ...e.cp0 })
      if (e.cp1) startCps.set(`${i}:cp1`, { ...e.cp1 })
    })
    this.mode = { kind: 'vector-vertex', vids, startWorld: world, startVerts, startCps }
  }

  /** Nearest point on any edge (screen-space distance + curve parameter). */
  private nearestEdgePoint(
    node: VectorNode,
    screen: Vec2,
    _zoom: number,
  ): { edgeIndex: number; t: number; distPx: number } | null {
    const state = editor.get()
    const m = this.scene.worldMatrix(node.id)
    const toScreen = (p: Vec2) => worldToScreen(state.camera, applyMat(m, p))
    const vmap = new Map(node.network.vertices.map((v) => [v.id, v]))
    let best: { edgeIndex: number; t: number; distPx: number } | null = null
    node.network.edges.forEach((e, ei) => {
      const a = vmap.get(e.v0)
      const b = vmap.get(e.v1)
      if (!a || !b) return
      const p0 = { x: a.x, y: a.y }
      const p1 = { x: b.x, y: b.y }
      let samples: Vec2[]
      if (e.cp0 || e.cp1) {
        samples = [p0, ...flattenCubic(p0, e.cp0 ?? p0, e.cp1 ?? p1, p1, 0.1)]
      } else {
        samples = [p0, p1]
      }
      const screenPts = samples.map(toScreen)
      for (let i = 0; i < screenPts.length - 1; i++) {
        const d = distToSegment(screen, screenPts[i], screenPts[i + 1])
        if (!best || d < best.distPx) {
          best = { edgeIndex: ei, t: (i + 0.5) / (screenPts.length - 1), distPx: d }
        }
      }
    })
    return best
  }

  /** Split an edge at parameter t; returns the new vertex id. */
  private splitEdge(node: VectorNode, edgeIndex: number, t: number): number {
    const net = node.network
    const edge = net.edges[edgeIndex]
    const vmap = new Map(net.vertices.map((v) => [v.id, v]))
    const a = vmap.get(edge.v0)!
    const b = vmap.get(edge.v1)!
    const nextVid = Math.max(0, ...net.vertices.map((v) => v.id)) + 1
    const nextEid = Math.max(0, ...net.edges.map((e) => e.id)) + 1
    const lerp = (p: Vec2, q: Vec2, s: number): Vec2 => ({ x: p.x + (q.x - p.x) * s, y: p.y + (q.y - p.y) * s })

    if (edge.cp0 || edge.cp1) {
      // De Casteljau split of the cubic.
      const p0 = { x: a.x, y: a.y }
      const p3 = { x: b.x, y: b.y }
      const c0 = edge.cp0 ?? p0
      const c1 = edge.cp1 ?? p3
      const q0 = lerp(p0, c0, t)
      const q1 = lerp(c0, c1, t)
      const q2 = lerp(c1, p3, t)
      const r0 = lerp(q0, q1, t)
      const r1 = lerp(q1, q2, t)
      const s = lerp(r0, r1, t)
      net.vertices.push({ id: nextVid, x: s.x, y: s.y })
      net.edges.splice(edgeIndex, 1,
        { id: edge.id, v0: edge.v0, v1: nextVid, cp0: q0, cp1: r0 },
        { id: nextEid, v0: nextVid, v1: edge.v1, cp0: r1, cp1: q2 },
      )
    } else {
      const s = lerp({ x: a.x, y: a.y }, { x: b.x, y: b.y }, t)
      net.vertices.push({ id: nextVid, x: s.x, y: s.y })
      net.edges.splice(edgeIndex, 1,
        { id: edge.id, v0: edge.v0, v1: nextVid, cp0: null, cp1: null },
        { id: nextEid, v0: nextVid, v1: edge.v1, cp0: null, cp1: null },
      )
    }
    return nextVid
  }

  /** Commit the in-flight vector gesture as one history entry. */
  private commitVectorGesture(): void {
    const id = editor.get().vectorEditId
    const before = this.gestureNetwork
    this.gestureNetwork = null
    if (!id || !before) return
    const node = this.scene.getNode(id)
    if (!node || node.type !== 'VECTOR') return
    if (JSON.stringify(node.network) === JSON.stringify(before)) return
    documentStore.commit(
      [{ kind: 'update', id, before: { network: before }, after: { network: structuredClone(node.network) } }],
      'Edit Vector',
      true,
    )
  }

  /** Delete the selected vertices (and their edges) in vector edit mode. */
  deleteVectorVertices(): void {
    const state = editor.get()
    const id = state.vectorEditId
    if (!id || state.vectorSelection.length === 0) return
    const node = this.scene.getNode(id)
    if (!node || node.type !== 'VECTOR') return
    const doomed = new Set(state.vectorSelection)
    const before = structuredClone(node.network)
    node.network.vertices = node.network.vertices.filter((v) => !doomed.has(v.id))
    node.network.edges = node.network.edges.filter((e) => !doomed.has(e.v0) && !doomed.has(e.v1))
    editor.set({ vectorSelection: [] })
    if (node.network.vertices.length === 0) {
      node.network = before // restore so the exit path records a clean delete
      this.scene.bump()
      this.exitVectorEdit(true)
      const live = this.scene.getNode(id)
      if (live && live.type === 'VECTOR') {
        const ops = removeSubtreeOps(this.scene, id)
        for (const op of ops) if (op.kind === 'remove') this.scene.removeNode(op.node.id)
        documentStore.commit(ops, 'Delete Vector', true)
        setSelection([])
      }
      return
    }
    documentStore.commit(
      [{ kind: 'update', id, before: { network: before }, after: { network: structuredClone(node.network) } }],
      'Delete Points',
      true,
    )
  }

  /** Escape key: cancel the in-flight interaction and restore node state. */
  cancel(): void {
    if (this.mode.kind === 'draw') {
      this.mode.rec.rollback()
      setSelection([])
    }
    if (
      this.mode.kind === 'move' ||
      this.mode.kind === 'resize' ||
      this.mode.kind === 'rotate' ||
      this.mode.kind === 'arc' ||
      this.mode.kind === 'corner'
    ) {
      // Restore every snapshotted property so the aborted drag leaves no trace.
      for (const s of this.mode.snapshots) {
        const node = this.scene.getNode(s.id)
        if (!node) continue
        Object.assign(node, structuredClone(s.props))
      }
      this.scene.bump()
      documentStore.transient()
      editor.set({ arcDrag: null, cornerDrag: null, rotating: false })
    }
    if (
      this.mode.kind === 'vector-vertex' ||
      this.mode.kind === 'vector-cp' ||
      this.mode.kind === 'vector-bend'
    ) {
      const id = editor.get().vectorEditId
      const node = id ? this.scene.getNode(id) : null
      if (node && node.type === 'VECTOR' && this.gestureNetwork) {
        node.network = this.gestureNetwork
        this.scene.bump()
        documentStore.transient()
      }
      this.gestureNetwork = null
    }
    if (this.mode.kind === 'pen' || editor.get().penDraft) {
      this.cancelPen()
    }
    editor.set({ marquee: null, guides: [] })
    this.mode = { kind: 'idle' }
  }

  wheel(screen: Vec2, deltaX: number, deltaY: number, ctrl: boolean, shift: boolean): void {
    const state = editor.get()
    if (ctrl) {
      const factor = Math.pow(1.0018, -deltaY)
      const worldBefore = screenToWorld(state.camera, screen)
      const zoom = clamp(state.camera.zoom * factor, 0.02, 64)
      editor.set({
        camera: { zoom, x: worldBefore.x - screen.x / zoom, y: worldBefore.y - screen.y / zoom },
      })
      return
    }
    const dx = shift ? deltaY : deltaX
    const dy = shift ? 0 : deltaY
    editor.set({
      camera: {
        ...state.camera,
        x: state.camera.x + dx / state.camera.zoom,
        y: state.camera.y + dy / state.camera.zoom,
      },
    })
  }

  get cursor(): string {
    const state = editor.get()
    if (this.mode.kind === 'pan') return 'grabbing'
    // A live rotate keeps the rotation cursor even where the pointer wanders to.
    if (this.mode.kind === 'rotate') return ROTATE_CURSOR
    if (state.spacePanning || state.tool === 'hand') return 'grab'
    if (this.cursorOverride) return this.cursorOverride
    if (state.tool !== 'select') return 'crosshair'
    return 'default'
  }
}

// ---------------------------------------------------------------------------

function anchorPointInParent(x: number, y: number, w: number, h: number, rotDeg: number, anchorLocal: Vec2): Vec2 {
  const c = { x: w / 2, y: h / 2 }
  const rot = matRotateDeg(rotDeg)
  const r = applyMat(rot, { x: anchorLocal.x - c.x, y: anchorLocal.y - c.y })
  return { x: x + c.x + r.x, y: y + c.y + r.y }
}

function scaleChildren(
  scene: typeof documentStore.scene,
  snapshots: DragNodeSnapshot[],
  containerId: NodeId,
  sx: number,
  sy: number,
): void {
  const snapMap = new Map(snapshots.map((s) => [s.id, s.props]))
  const walk = (id: NodeId) => {
    const node = scene.getNode(id)
    if (!node) return
    const snap = snapMap.get(id)
    if (snap) {
      node.x = (snap.x as number) * sx
      node.y = (snap.y as number) * sy
      node.width = Math.max(0.5, (snap.width as number) * sx)
      node.height = node.type === 'LINE' ? 0 : Math.max(0.5, (snap.height as number) * sy)
    }
    if (isContainer(node)) for (const cid of node.children) walk(cid)
  }
  const container = scene.getNode(containerId)
  if (container && isContainer(container)) {
    for (const cid of container.children) walk(cid)
  }
}

/** Wrap turns into [-0.5, 0.5) — used both to unwrap a drag across the seam
 *  and to keep a stored start angle in the readable ±180° half. */
function wrapTurns(t: number): number {
  let v = t % 1
  if (v >= 0.5) v -= 1
  if (v < -0.5) v += 1
  return v
}

function norm180(deg: number): number {
  let d = deg % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

function defaultName(type: SceneNode['type'], scene: typeof documentStore.scene): string {
  const base =
    type === 'FRAME'
      ? 'Frame'
      : type === 'RECTANGLE'
        ? 'Rectangle'
        : type === 'ELLIPSE'
          ? 'Ellipse'
          : type === 'LINE'
            ? 'Line'
            : type === 'POLYGON'
              ? 'Polygon'
              : type === 'STAR'
                ? 'Star'
                : 'Shape'
  let n = 1
  for (const node of Object.values(scene.doc.nodes)) {
    const m = node.name.match(new RegExp(`^${base} (\\d+)$`))
    if (m) n = Math.max(n, parseInt(m[1], 10) + 1)
    else if (node.name === base) n = Math.max(n, 2)
  }
  return `${base} ${n}`
}

export const interactionController = new InteractionController()
