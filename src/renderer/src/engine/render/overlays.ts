// Screen-space editor overlays: hover/selection outlines, resize/rotate
// handles, marquee, snap guides, frame name labels, pen-tool preview.
// Handle geometry is exported so pointer interaction shares one source.

import type { NodeId, Vec2 } from '../types'
import type { SceneGraph } from '../scene'
import type { AABB } from '../geometry'
import { aabbIsEmpty, applyMat } from '../geometry'
import type { Camera } from './canvas2d'

export const HANDLE_SIZE = 8
export const ROTATE_ZONE = 14
const ACCENT = '#4f9eff'
const ACCENT_DIM = 'rgba(79, 158, 255, 0.9)'

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
}

/** Screen-space name labels for root-level frames. */
export function frameLabels(scene: SceneGraph, camera: Camera, ctx?: CanvasRenderingContext2D): FrameLabel[] {
  const labels: FrameLabel[] = []
  for (const id of scene.doc.rootIds) {
    const node = scene.getNode(id)
    if (!node || node.type !== 'FRAME' || !node.visible) continue
    const p = worldToScreen(camera, { x: node.x, y: node.y })
    const text = node.name
    const width = ctx ? ctx.measureText(text).width : text.length * 6
    labels.push({ id, text, x: p.x, y: p.y - 8, width: Math.min(width, 240), height: 12 })
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
    ctx.fillStyle = state.selection.includes(label.id) ? ACCENT : '#9a9a9a'
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
  if (box && state.editingTextId === null) {
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
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
