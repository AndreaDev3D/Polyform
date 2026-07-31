// Pointer interaction state machine for the canvas viewport: selection,
// move (with snapping + reparenting), resize, rotate, marquee, shape drawing,
// pen paths, text placement, panning, and wheel zoom/pan.

import type { NodeId, SceneNode, Vec2, VectorNetwork } from '../engine/types'
import { createNode, isContainer, newId } from '../engine/types'
import { applyMat, clamp, matInvert, matRotateDeg, type AABB } from '../engine/geometry'
import { documentStore } from '../state/document'
import { editor, type Tool } from '../state/editor'
import { OpRecorder, setSelection, topSelection } from '../state/actions'
import { findDropFrame, hitTestAll, resolveClickTarget, nodesInRect } from '../engine/hit-test'
import type { PatchOp } from '../engine/commands'
import {
  boxHandles,
  hitHandle,
  screenToWorld,
  selectionScreenBox,
  frameLabels,
  type Handle,
  type HandleKind,
} from '../engine/render/overlays'
import { snapBox } from './snapping'

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
  | { kind: 'draw'; rec: OpRecorder; nodeId: NodeId; startWorld: Vec2; parentId: NodeId | null }
  | { kind: 'pen' }

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

  /** Include descendants for container scaling. */
  private snapshotWithDescendants(ids: NodeId[], keys: string[]): DragNodeSnapshot[] {
    const all = new Set<NodeId>()
    for (const id of ids) {
      all.add(id)
      const node = this.scene.getNode(id)
      if (node && (node.type === 'GROUP' || node.type === 'BOOLEAN')) {
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
      const handle = hitHandle(boxHandles(box), screen)
      if (handle) {
        if (handle.kind.startsWith('rotate')) this.startRotate(handle)
        else this.startResize(handle)
        return
      }
    }

    // 2. Frame name labels.
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

    // 3. Scene hit test.
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
    const locked = ids.filter((id) => !this.scene.getNode(id)?.locked)
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
    const ids = topSelection()
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
    const ids = topSelection()
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
    if (state.tool !== 'select') {
      if (state.hover) editor.set({ hover: null })
      this.cursorOverride = state.tool === 'hand' ? 'grab' : 'crosshair'
      return
    }
    this.cursorOverride = null
    const box = selectionScreenBox(this.scene, state.selection, state.camera)
    if (box && state.selection.length > 0) {
      const handle = hitHandle(boxHandles(box), screen)
      if (handle) {
        this.cursorOverride = handle.kind.startsWith('rotate') ? rotateCursor() : handle.cursor
        if (state.hover) editor.set({ hover: null })
        return
      }
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
      // Scale children of groups/booleans proportionally.
      if (node.type === 'GROUP' || node.type === 'BOOLEAN') {
        scaleChildren(scene, this.mode.snapshots, node.id, newW / w0, newH / h0)
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
      }
    }
    this.scene.bump()
    documentStore.transient()
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
        this.commitFromSnapshots(this.mode.snapshots, 'Rotate')
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

  /** Escape key: cancel the in-flight interaction and restore node state. */
  cancel(): void {
    if (this.mode.kind === 'draw') {
      this.mode.rec.rollback()
      setSelection([])
    }
    if (this.mode.kind === 'move' || this.mode.kind === 'resize' || this.mode.kind === 'rotate') {
      // Restore every snapshotted property so the aborted drag leaves no trace.
      for (const s of this.mode.snapshots) {
        const node = this.scene.getNode(s.id)
        if (!node) continue
        Object.assign(node, structuredClone(s.props))
      }
      this.scene.bump()
      documentStore.transient()
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

function norm180(deg: number): number {
  let d = deg % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

function rotateCursor(): string {
  return 'alias'
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
