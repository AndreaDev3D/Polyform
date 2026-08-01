// Screen-space editor overlays: hover/selection outlines, resize/rotate
// handles, marquee, snap guides, frame name labels, pen-tool preview.
// Handle geometry is exported so pointer interaction shares one source.

import type { Guide, NodeId, Vec2, VectorNode } from '../types'
import type { SceneGraph } from '../scene'
import type { AABB } from '../geometry'
import { aabbIsEmpty, applyMat } from '../geometry'
import type { Camera } from './canvas2d'

export const HANDLE_SIZE = 8
export const ROTATE_ZONE = 14
export const RULER_SIZE = 20
const ACCENT = '#4f9eff'
const ACCENT_DIM = 'rgba(79, 158, 255, 0.9)'
const GUIDE_COLOR = '#67b8ff'
const COMPONENT_COLOR = '#a78bfa'

export function worldToScreen(camera: Camera, p: Vec2): Vec2 {
  return { x: (p.x - camera.x) * camera.zoom, y: (p.y - camera.y) * camera.zoom }
}

export function screenToWorld(camera: Camera, p: Vec2): Vec2 {
  return { x: p.x / camera.zoom + camera.x, y: p.y / camera.zoom + camera.y }
}

export interface SnapGuide {
  axis: 'x' | 'y'
  /** World position of the guide line. */
  pos: number
  from: number
  to: number
}

export interface PenDraft {
  /** World-space committed anchors. */
  anchors: Vec2[]
  /** Current cursor (world) for the preview segment. */
  cursor: Vec2 | null
  closable: boolean
}

export interface OverlayState {
  camera: Camera
  width: number
  height: number
  dpr: number
  selection: NodeId[]
  hover: NodeId | null
  marquee: AABB | null
  guides: SnapGuide[]
  penDraft: PenDraft | null
  editingTextId: NodeId | null
  /** Persistent user guides of the active page. */
  pageGuides?: Guide[]
  showRulers?: boolean
  vectorEditId?: NodeId | null
  vectorSelection?: number[]
}

/** Screen-space corners (nw, ne, se, sw order) of a node's oriented box. */
export function nodeScreenCorners(scene: SceneGraph, id: NodeId, camera: Camera): Vec2[] | null {
  const node = scene.getNode(id)
  if (!node) return null
  const m = scene.worldMatrix(id)
  return [
    worldToScreen(camera, applyMat(m, { x: 0, y: 0 })),
    worldToScreen(camera, applyMat(m, { x: node.width, y: 0 })),
    worldToScreen(camera, applyMat(m, { x: node.width, y: node.height })),
    worldToScreen(camera, applyMat(m, { x: 0, y: node.height })),
  ]
}

/**
 * Selection box in screen space. Single node -> oriented corners; multiple
 * nodes -> axis-aligned union box.
 */
export function selectionScreenBox(scene: SceneGraph, ids: NodeId[], camera: Camera): Vec2[] | null {
  const valid = ids.filter((id) => scene.hasNode(id))
  if (valid.length === 0) return null
  if (valid.length === 1) return nodeScreenCorners(scene, valid[0], camera)
  let box: AABB | null = null
  for (const id of valid) {
    const b = scene.worldAABB(id)
    if (aabbIsEmpty(b)) continue
    box = box
      ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) }
      : { ...b }
  }
  if (!box) return null
  return [
    worldToScreen(camera, { x: box.minX, y: box.minY }),
    worldToScreen(camera, { x: box.maxX, y: box.minY }),
    worldToScreen(camera, { x: box.maxX, y: box.maxY }),
    worldToScreen(camera, { x: box.minX, y: box.maxY }),
  ]
}

export type HandleKind =
  | 'nw'
  | 'ne'
  | 'se'
  | 'sw'
  | 'n'
  | 'e'
  | 's'
  | 'w'
  | 'rotate-nw'
  | 'rotate-ne'
  | 'rotate-se'
  | 'rotate-sw'

export interface Handle {
  kind: HandleKind
  /** Screen position (center). */
  x: number
  y: number
  cursor: string
}

function mid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function cursorForDirection(dx: number, dy: number): string {
  const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 180
  if (angle < 22.5 || angle >= 157.5) return 'ew-resize'
  if (angle < 67.5) return 'nwse-resize'
  if (angle < 112.5) return 'ns-resize'
  return 'nesw-resize'
}

/** Interactive handles for a selection box (corners, edges, rotate zones). */
export function boxHandles(corners: Vec2[]): Handle[] {
  const [nw, ne, se, sw] = corners
  const center = mid(nw, se)
  const handles: Handle[] = []
  const cornerDefs: { kind: HandleKind; p: Vec2 }[] = [
    { kind: 'nw', p: nw },
    { kind: 'ne', p: ne },
    { kind: 'se', p: se },
    { kind: 'sw', p: sw },
  ]
  for (const { kind, p } of cornerDefs) {
    handles.push({ kind, x: p.x, y: p.y, cursor: cursorForDirection(p.x - center.x, p.y - center.y) })
    const out = { x: p.x + (p.x - center.x ? Math.sign(p.x - center.x) : 0) * ROTATE_ZONE, y: p.y + (p.y - center.y ? Math.sign(p.y - center.y) : 0) * ROTATE_ZONE }
    handles.push({ kind: `rotate-${kind}` as HandleKind, x: out.x, y: out.y, cursor: 'crosshair' })
  }
  const edgeDefs: { kind: HandleKind; p: Vec2; d: Vec2 }[] = [
    { kind: 'n', p: mid(nw, ne), d: { x: ne.y - nw.y, y: -(ne.x - nw.x) } },
    { kind: 'e', p: mid(ne, se), d: { x: se.y - ne.y, y: -(se.x - ne.x) } },
    { kind: 's', p: mid(se, sw), d: { x: sw.y - se.y, y: -(sw.x - se.x) } },
    { kind: 'w', p: mid(sw, nw), d: { x: nw.y - sw.y, y: -(nw.x - sw.x) } },
  ]
  for (const { kind, p, d } of edgeDefs) {
    handles.push({ kind, x: p.x, y: p.y, cursor: cursorForDirection(d.x, d.y) })
  }
  return handles
}

export function hitHandle(handles: Handle[], p: Vec2): Handle | null {
  // Corner/edge handles take priority over rotate zones.
  const pad = HANDLE_SIZE / 2 + 3
  for (const h of handles) {
    if (h.kind.startsWith('rotate')) continue
    if (Math.abs(p.x - h.x) <= pad && Math.abs(p.y - h.y) <= pad) return h
  }
  for (const h of handles) {
    if (!h.kind.startsWith('rotate')) continue
    if (Math.abs(p.x - h.x) <= ROTATE_ZONE && Math.abs(p.y - h.y) <= ROTATE_ZONE) return h
  }
  return null
}

function strokePolygon(ctx: CanvasRenderingContext2D, pts: Vec2[], color: string, width = 1): void {
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
  ctx.stroke()
}

export interface FrameLabel {
  id: NodeId
  text: string
  x: number
  y: number
  width: number
  height: number
  /** Components/instances get the purple treatment. */
  isComponent: boolean
}

/** Screen-space name labels for root-level frames/components/instances. */
export function frameLabels(scene: SceneGraph, camera: Camera, ctx?: CanvasRenderingContext2D): FrameLabel[] {
  const labels: FrameLabel[] = []
  for (const id of scene.rootIds()) {
    const node = scene.getNode(id)
    if (!node || !node.visible) continue
    if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'INSTANCE') continue
    const p = worldToScreen(camera, { x: node.x, y: node.y })
    const isComponent = node.type !== 'FRAME'
    const text = (isComponent ? '◈ ' : '') + node.name
    const width = ctx ? ctx.measureText(text).width : text.length * 6
    labels.push({ id, text, x: p.x, y: p.y - 8, width: Math.min(width, 240), height: 12, isComponent })
  }
  return labels
}

export function drawOverlays(ctx: CanvasRenderingContext2D, scene: SceneGraph, state: OverlayState): void {
  const { camera, dpr } = state
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // Frame labels
  ctx.font = '11px "Segoe UI", system-ui, sans-serif'
  ctx.textBaseline = 'alphabetic'
  for (const label of frameLabels(scene, camera, ctx)) {
    ctx.fillStyle = state.selection.includes(label.id)
      ? label.isComponent
        ? COMPONENT_COLOR
        : ACCENT
      : label.isComponent
        ? 'rgba(167, 139, 250, 0.85)'
        : '#9a9a9a'
    ctx.fillText(label.text, label.x, label.y - 2, 240)
  }

  // Hover outline
  if (state.hover && !state.selection.includes(state.hover)) {
    const corners = nodeScreenCorners(scene, state.hover, camera)
    if (corners) strokePolygon(ctx, corners, ACCENT_DIM, 2)
  }

  // Per-node outlines for multi-selection
  if (state.selection.length > 1) {
    for (const id of state.selection) {
      const corners = nodeScreenCorners(scene, id, camera)
      if (corners) strokePolygon(ctx, corners, 'rgba(79,158,255,0.55)', 1)
    }
  }

  // Selection box + handles
  const box = selectionScreenBox(scene, state.selection, camera)
  if (box && state.editingTextId === null && !state.vectorEditId) {
    strokePolygon(ctx, box, ACCENT, 1.5)
    for (const h of boxHandles(box)) {
      if (h.kind.startsWith('rotate')) continue
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1
      ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
      ctx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
    }
    // Dimensions chip
    const [nw, , se] = box
    const cx = (nw.x + se.x) / 2
    const bottom = Math.max(box[0].y, box[1].y, box[2].y, box[3].y)
    let label = ''
    if (state.selection.length === 1) {
      const n = scene.getNode(state.selection[0])
      if (n) label = `${round2(n.width)} × ${round2(n.height)}`
    } else {
      const wpx = Math.abs(se.x - nw.x) / camera.zoom
      const hpx = Math.abs(se.y - nw.y) / camera.zoom
      label = `${round2(wpx)} × ${round2(hpx)}`
    }
    if (label) {
      ctx.font = '10px "Segoe UI", system-ui, sans-serif'
      const tw = ctx.measureText(label).width
      ctx.fillStyle = ACCENT
      const bx = cx - tw / 2 - 4
      const by = bottom + 6
      ctx.beginPath()
      ctx.roundRect(bx, by, tw + 8, 16, 3)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(label, cx - tw / 2, by + 11.5)
    }
  }

  // Marquee
  if (state.marquee) {
    const a = worldToScreen(camera, { x: state.marquee.minX, y: state.marquee.minY })
    const b = worldToScreen(camera, { x: state.marquee.maxX, y: state.marquee.maxY })
    ctx.fillStyle = 'rgba(79,158,255,0.12)'
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
  }

  // Snap guides
  for (const g of state.guides) {
    ctx.strokeStyle = '#ff4d6a'
    ctx.lineWidth = 1
    ctx.beginPath()
    if (g.axis === 'x') {
      const s = worldToScreen(camera, { x: g.pos, y: g.from })
      const e = worldToScreen(camera, { x: g.pos, y: g.to })
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(e.x, e.y)
    } else {
      const s = worldToScreen(camera, { x: g.from, y: g.pos })
      const e = worldToScreen(camera, { x: g.to, y: g.pos })
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(e.x, e.y)
    }
    ctx.stroke()
  }

  // Pen draft preview
  if (state.penDraft && state.penDraft.anchors.length > 0) {
    const pts = state.penDraft.anchors.map((p) => worldToScreen(camera, p))
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    if (state.penDraft.cursor) {
      const c = worldToScreen(camera, state.penDraft.cursor)
      ctx.lineTo(c.x, c.y)
    }
    ctx.stroke()
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      ctx.fillStyle = i === 0 && state.penDraft.closable ? ACCENT : '#ffffff'
      ctx.strokeStyle = ACCENT
      ctx.beginPath()
      ctx.arc(p.x, p.y, i === 0 ? 4.5 : 3.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  drawPageGuides(ctx, state)
  drawVectorEdit(ctx, scene, state)
  drawRulers(ctx, state)
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

// ---------------------------------------------------------------------------
// User guides + rulers
// ---------------------------------------------------------------------------

function drawPageGuides(ctx: CanvasRenderingContext2D, state: OverlayState): void {
  const guides = state.pageGuides ?? []
  if (guides.length === 0) return
  ctx.strokeStyle = GUIDE_COLOR
  ctx.lineWidth = 1
  for (const g of guides) {
    ctx.beginPath()
    if (g.axis === 'x') {
      const sx = Math.round((g.pos - state.camera.x) * state.camera.zoom) + 0.5
      ctx.moveTo(sx, 0)
      ctx.lineTo(sx, state.height)
    } else {
      const sy = Math.round((g.pos - state.camera.y) * state.camera.zoom) + 0.5
      ctx.moveTo(0, sy)
      ctx.lineTo(state.width, sy)
    }
    ctx.stroke()
  }
}

/** Pick a world-space tick step whose screen size is 55-140px. */
function rulerStep(zoom: number): number {
  const target = 70 / zoom
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  for (const m of [1, 2, 5, 10]) {
    if (pow * m >= target) return pow * m
  }
  return pow * 10
}

function drawRulers(ctx: CanvasRenderingContext2D, state: OverlayState): void {
  if (!state.showRulers) return
  const { camera, width, height } = state
  ctx.save()
  ctx.fillStyle = '#161616'
  ctx.fillRect(0, 0, width, RULER_SIZE)
  ctx.fillRect(0, 0, RULER_SIZE, height)
  ctx.strokeStyle = '#333'
  ctx.beginPath()
  ctx.moveTo(0, RULER_SIZE + 0.5)
  ctx.lineTo(width, RULER_SIZE + 0.5)
  ctx.moveTo(RULER_SIZE + 0.5, 0)
  ctx.lineTo(RULER_SIZE + 0.5, height)
  ctx.stroke()

  const step = rulerStep(camera.zoom)
  ctx.fillStyle = '#8a8a8a'
  ctx.strokeStyle = '#3f3f3f'
  ctx.font = '9px "Segoe UI", system-ui, sans-serif'
  ctx.textBaseline = 'alphabetic'

  // Horizontal ruler (X axis).
  const startX = Math.floor(camera.x / step) * step
  const endX = camera.x + width / camera.zoom
  ctx.beginPath()
  for (let x = startX; x <= endX; x += step) {
    const sx = Math.round((x - camera.x) * camera.zoom) + 0.5
    if (sx < RULER_SIZE) continue
    ctx.moveTo(sx, RULER_SIZE - 6)
    ctx.lineTo(sx, RULER_SIZE)
    ctx.fillText(String(Math.round(x)), sx + 3, RULER_SIZE - 8)
  }
  ctx.stroke()

  // Vertical ruler (Y axis) — rotated labels.
  const startY = Math.floor(camera.y / step) * step
  const endY = camera.y + height / camera.zoom
  ctx.beginPath()
  for (let y = startY; y <= endY; y += step) {
    const sy = Math.round((y - camera.y) * camera.zoom) + 0.5
    if (sy < RULER_SIZE) continue
    ctx.moveTo(RULER_SIZE - 6, sy)
    ctx.lineTo(RULER_SIZE, sy)
    ctx.save()
    ctx.translate(RULER_SIZE - 8, sy + 3)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText(String(Math.round(y)), 0, 0)
    ctx.restore()
  }
  ctx.stroke()

  // Corner square.
  ctx.fillStyle = '#161616'
  ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE)
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Vector edit mode
// ---------------------------------------------------------------------------

/** Screen positions of every vertex of a vector node. */
export function vectorVertexScreenPositions(
  scene: SceneGraph,
  node: VectorNode,
  camera: Camera,
): Map<number, Vec2> {
  const m = scene.worldMatrix(node.id)
  const out = new Map<number, Vec2>()
  for (const v of node.network.vertices) {
    out.set(v.id, worldToScreen(camera, applyMat(m, { x: v.x, y: v.y })))
  }
  return out
}

function drawVectorEdit(ctx: CanvasRenderingContext2D, scene: SceneGraph, state: OverlayState): void {
  const id = state.vectorEditId
  if (!id) return
  const node = scene.getNode(id)
  if (!node || node.type !== 'VECTOR') return
  const m = scene.worldMatrix(id)
  const selected = new Set(state.vectorSelection ?? [])
  const toScreen = (p: Vec2) => worldToScreen(state.camera, applyMat(m, p))
  const vmap = new Map(node.network.vertices.map((v) => [v.id, v]))

  // Edges (with control point stems for selected endpoints).
  ctx.lineWidth = 1.5
  ctx.strokeStyle = ACCENT
  for (const edge of node.network.edges) {
    const a = vmap.get(edge.v0)
    const b = vmap.get(edge.v1)
    if (!a || !b) continue
    const sa = toScreen({ x: a.x, y: a.y })
    const sb = toScreen({ x: b.x, y: b.y })
    ctx.beginPath()
    ctx.moveTo(sa.x, sa.y)
    if (edge.cp0 || edge.cp1) {
      const c0 = toScreen(edge.cp0 ?? { x: a.x, y: a.y })
      const c1 = toScreen(edge.cp1 ?? { x: b.x, y: b.y })
      ctx.bezierCurveTo(c0.x, c0.y, c1.x, c1.y, sb.x, sb.y)
    } else {
      ctx.lineTo(sb.x, sb.y)
    }
    ctx.stroke()

    // Control handles for edges touching a selected vertex.
    const stems: { anchor: Vec2; cp: Vec2 }[] = []
    if (edge.cp0 && selected.has(edge.v0)) stems.push({ anchor: sa, cp: toScreen(edge.cp0) })
    if (edge.cp1 && selected.has(edge.v1)) stems.push({ anchor: sb, cp: toScreen(edge.cp1) })
    for (const stem of stems) {
      ctx.strokeStyle = 'rgba(79,158,255,0.7)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(stem.anchor.x, stem.anchor.y)
      ctx.lineTo(stem.cp.x, stem.cp.y)
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = ACCENT
      ctx.beginPath()
      ctx.arc(stem.cp.x, stem.cp.y, 3.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = ACCENT
    }
  }

  // Vertices.
  for (const v of node.network.vertices) {
    const s = toScreen({ x: v.x, y: v.y })
    ctx.fillStyle = selected.has(v.id) ? ACCENT : '#ffffff'
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1
    ctx.fillRect(s.x - 3.5, s.y - 3.5, 7, 7)
    ctx.strokeRect(s.x - 3.5, s.y - 3.5, 7, 7)
  }
}
