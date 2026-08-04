// Screen-space editor overlays: hover/selection outlines, resize/rotate
// handles, marquee, snap guides, frame name labels, pen-tool preview.
// Handle geometry is exported so pointer interaction shares one source.

import type { EllipseNode, Guide, NodeId, SceneNode, Vec2, VectorNode } from '../types'
import type { SceneGraph } from '../scene'
import type { AABB } from '../geometry'
import { aabbIsEmpty, applyMat } from '../geometry'
import { nearestInstanceAncestor } from '../hit-test'
import type { Camera } from './canvas2d'

export const HANDLE_SIZE = 8
/** Vector anchor radius, in screen px. Its hit radius lives in the controller. */
export const VERTEX_R = 4
export const ROTATE_ZONE = 14
/** Stem length from the top edge out to the rotate knob, in screen px. */
export const ROTATE_STEM = 18
const ROTATE_KNOB_R = 4.5
/** Tight, so it never steals a click meant for the top edge or the shape. */
const ROTATE_KNOB_PAD = 9
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
  /** Arc handle being dragged right now (drives the readout chip). */
  arcDrag?: ArcHandleKind | null
  /** Corner-radius handle being dragged right now. */
  cornerDrag?: CornerKind | null
  /** A rotate drag is in progress, so the knob shows its angle. */
  rotating?: boolean
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
  /** The one rotate handle you can see: a knob on a stem above the top edge. */
  | 'rotate'
  | 'rotate-nw'
  | 'rotate-ne'
  | 'rotate-se'
  | 'rotate-sw'

/**
 * A real rotation cursor. CSS has no keyword for one, so this is a circular
 * arrow as an inline SVG, drawn the way system cursors are: white ink over a
 * solid black rim, so it survives the canvas, a light shape and a dark one
 * alike. Three details are all load-bearing at 24px, and each was a failed
 * draft first — a translucent halo disappeared on white; a head sitting on the
 * arc merged into it, so the arc stops 25° short and the head takes the tip;
 * and round joins turned a 5px triangle into a pentagon, so the head miters
 * while the arc stays round.
 *
 * The hotspot is the centre of the ring: the arrow surrounds the point you are
 * acting on, which is what every other rotate cursor does. `alias` is the
 * fallback, and is what this used to be on its own.
 */
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">' +
    '<path d="M14.75 6.11A6.5 6.5 0 1 1 5.5 12" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M2.6 12.1 5.5 7.2 8.4 12.1Z" fill="#000" stroke="#000" stroke-width="2.4" stroke-linejoin="miter"/>' +
    '<path d="M14.75 6.11A6.5 6.5 0 1 1 5.5 12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M2.6 12.1 5.5 7.2 8.4 12.1Z" fill="#fff"/>' +
    '</svg>',
)}") 12 12, alias`

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

/** Unit vector, falling back to straight up for a collapsed box. */
function unit(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y)
  return len < 1e-6 ? { x: 0, y: -1 } : { x: v.x / len, y: v.y / len }
}

function cursorForDirection(dx: number, dy: number): string {
  const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 180
  if (angle < 22.5 || angle >= 157.5) return 'ew-resize'
  if (angle < 67.5) return 'nwse-resize'
  if (angle < 112.5) return 'ns-resize'
  return 'nesw-resize'
}

/**
 * Whether a rotate gesture on this selection would do anything — the same
 * filter the gesture itself applies. Instance internals commit nowhere, so
 * offering a handle there would be a promise the app does not keep. (Locked
 * nodes are deliberately not excluded: rotating one does work today.)
 */
export function canRotate(scene: SceneGraph, ids: NodeId[]): boolean {
  return ids.some((id) => scene.hasNode(id) && nearestInstanceAncestor(scene, id) === null)
}

/**
 * Interactive handles for a selection box: resize corners and edges, the
 * visible rotate knob, and the four invisible corner rotate zones.
 */
export function boxHandles(corners: Vec2[], rotatable = true): Handle[] {
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
    if (!rotatable) continue
    const out = { x: p.x + (p.x - center.x ? Math.sign(p.x - center.x) : 0) * ROTATE_ZONE, y: p.y + (p.y - center.y ? Math.sign(p.y - center.y) : 0) * ROTATE_ZONE }
    handles.push({ kind: `rotate-${kind}` as HandleKind, x: out.x, y: out.y, cursor: ROTATE_CURSOR })
  }
  // The visible rotate handle: a knob on a stem, out past the top edge along
  // the box's own up direction, so it stays "above the shape" once the shape is
  // turned. The four corner zones above still rotate — they are the reflex a
  // Figma user arrives with — but they are invisible, and an invisible handle
  // is not an affordance. This one is the one you can find.
  if (rotatable) {
    const topMid = mid(nw, ne)
    const up = unit({ x: topMid.x - center.x, y: topMid.y - center.y })
    handles.push({
      kind: 'rotate',
      x: topMid.x + up.x * ROTATE_STEM,
      y: topMid.y + up.y * ROTATE_STEM,
      cursor: ROTATE_CURSOR,
    })
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
  // Resize handles first: they sit on the outline, and a click on the outline
  // means resize. Then the visible knob, then the invisible corner zones —
  // drawn last, hit last, so what you can see always wins.
  const pad = HANDLE_SIZE / 2 + 3
  for (const h of handles) {
    if (h.kind.startsWith('rotate')) continue
    if (Math.abs(p.x - h.x) <= pad && Math.abs(p.y - h.y) <= pad) return h
  }
  for (const h of handles) {
    // Round handle, round hit area.
    if (h.kind === 'rotate' && Math.hypot(p.x - h.x, p.y - h.y) <= ROTATE_KNOB_PAD) return h
  }
  for (const h of handles) {
    if (!h.kind.startsWith('rotate-')) continue
    if (Math.abs(p.x - h.x) <= ROTATE_ZONE && Math.abs(p.y - h.y) <= ROTATE_ZONE) return h
  }
  return null
}

// ---------------------------------------------------------------------------
// Ellipse arc handles
//
// Three round handles on a selected ellipse: the two ends of the sweep, on
// the outline, and the inner radius, on the hole. They are the direct-
// manipulation twin of the inspector's Arc row and read/write the same three
// fields, so the angle convention here has to match arcPath() exactly:
// turns clockwise from 12 o'clock, normalized by the radii.
// ---------------------------------------------------------------------------

export type ArcHandleKind = 'arc-start' | 'arc-sweep' | 'arc-ratio'

export interface ArcHandle {
  kind: ArcHandleKind
  /** Screen position (center). */
  x: number
  y: number
}

const ARC_HANDLE_R = 4
const ARC_HANDLE_PAD = 7
/** Ring handles sit this many screen px inside the outline. Without the
 *  inset, a start angle of 0/90/180/270° would park the handle exactly under
 *  a box edge handle, and one of the two would be unreachable. */
const ARC_RING_INSET = 10

/** The one ellipse whose arc is editable on canvas right now, if any. */
export function arcEditTarget(scene: SceneGraph, ids: NodeId[]): EllipseNode | null {
  if (ids.length !== 1) return null
  const node = scene.getNode(ids[0])
  if (!node || node.type !== 'ELLIPSE' || node.locked) return null
  // Instance internals are not editable in place — nothing would commit.
  if (nearestInstanceAncestor(scene, node.id) !== null) return null
  return node
}

/**
 * Turns (clockwise from 12 o'clock) of a node-local point about the ellipse
 * centre — the inverse of the mapping arcPath() walks. Dividing by the radii
 * first means the handle tracks the pointer along the ellipse rather than
 * along a circle, which matters as soon as the shape is not square.
 */
export function arcTurnsFromLocal(node: EllipseNode, p: Vec2): number {
  const rx = Math.max(1e-6, node.width / 2)
  const ry = Math.max(1e-6, node.height / 2)
  return Math.atan2((p.y - ry) / ry, (p.x - rx) / rx) / (Math.PI * 2) + 0.25
}

/** Parametric radius of a node-local point: 0 is the centre, 1 the outline. */
export function arcRadiusFromLocal(node: EllipseNode, p: Vec2): number {
  const rx = Math.max(1e-6, node.width / 2)
  const ry = Math.max(1e-6, node.height / 2)
  return Math.hypot((p.x - rx) / rx, (p.y - ry) / ry)
}

export function arcHandles(scene: SceneGraph, node: EllipseNode, camera: Camera): ArcHandle[] {
  const rx = node.width / 2
  const ry = node.height / 2
  const start = node.arcStart ?? 0
  const sweep = Math.max(-1, Math.min(1, node.arcSweep ?? 1))
  const ratio = Math.max(0, Math.min(0.999, node.arcRatio ?? 0))
  const m = scene.worldMatrix(node.id)
  const toScreen = (p: Vec2) => worldToScreen(camera, applyMat(m, p))
  const at = (turns: number, k: number): Vec2 => {
    const a = (turns - 0.25) * Math.PI * 2
    return toScreen({ x: rx + rx * k * Math.cos(a), y: ry + ry * k * Math.sin(a) })
  }
  const centre = toScreen({ x: rx, y: ry })
  // Inset in screen space so it stays the same few pixels at any zoom,
  // rotation or aspect ratio (and never crosses the centre on a tiny shape).
  const inset = (p: Vec2): Vec2 => {
    const d = Math.hypot(p.x - centre.x, p.y - centre.y)
    if (d < 1e-6) return p
    const t = Math.min(ARC_RING_INSET, d * 0.4) / d
    return { x: p.x + (centre.x - p.x) * t, y: p.y + (centre.y - p.y) * t }
  }

  const handles: ArcHandle[] = []
  // A whole turn puts both ends in the same place: one handle, not two on top
  // of each other. Dragging it is what opens the arc in the first place.
  if (Math.abs(Math.abs(sweep) - 1) > 1e-6) {
    const s = inset(at(start, 1))
    handles.push({ kind: 'arc-start', x: s.x, y: s.y })
  }
  const e = inset(at(start + sweep, 1))
  handles.push({ kind: 'arc-sweep', x: e.x, y: e.y })
  const r = at(start + sweep / 2, ratio)
  handles.push({ kind: 'arc-ratio', x: r.x, y: r.y })
  return handles
}

export function hitArcHandle(handles: ArcHandle[], p: Vec2): ArcHandle | null {
  for (const h of handles) {
    if (Math.hypot(p.x - h.x, p.y - h.y) <= ARC_HANDLE_PAD) return h
  }
  return null
}

// ---------------------------------------------------------------------------
// Corner radius handles
//
// One handle per corner, sitting at the centre of that corner's arc — which is
// where the rounding actually pivots, so dragging it along the diagonal reads
// as "make this corner rounder". Each corner is independent; the inspector's
// four fields are the same numbers.
// ---------------------------------------------------------------------------

export type CornerKind = 'radius-tl' | 'radius-tr' | 'radius-br' | 'radius-bl'

export interface CornerHandle {
  kind: CornerKind
  x: number
  y: number
}

const CORNER_HANDLE_R = 3.5
const CORNER_HANDLE_PAD = 7
/** At radius 0 the handle would sit under the resize handle, so keep it this
 *  many screen px inside the corner regardless. */
const CORNER_MIN_INSET = 13
/** Below this on-screen size the handles are more clutter than control. */
const CORNER_MIN_BOX = 44

/** A node whose corners can be rounded, when exactly one is selected. */
export function cornerEditTarget(scene: SceneGraph, ids: NodeId[]): SceneNode | null {
  if (ids.length !== 1) return null
  const node = scene.getNode(ids[0])
  if (!node || node.locked) return null
  if (!('cornerRadius' in node)) return null
  // INSTANCE has corners but its internals are not editable in place.
  if (node.type === 'INSTANCE') return null
  if (nearestInstanceAncestor(scene, node.id) !== null) return null
  return node
}

export function cornerHandles(
  scene: SceneGraph,
  node: SceneNode,
  camera: Camera,
): CornerHandle[] {
  if (!('cornerRadius' in node)) return []
  const w = node.width
  const h = node.height
  // Hide on a shape too small to aim at; the inspector still works.
  if (Math.min(w, h) * camera.zoom < CORNER_MIN_BOX) return []
  const m = scene.worldMatrix(node.id)
  const toScreen = (p: Vec2) => worldToScreen(camera, applyMat(m, p))
  const inset = CORNER_MIN_INSET / camera.zoom
  const maxR = Math.min(w, h) / 2
  const r = node.cornerRadius
  const at = (kind: CornerKind, radius: number, cx: number, cy: number, sx: number, sy: number): CornerHandle => {
    const d = Math.min(Math.max(radius, inset), maxR)
    const p = toScreen({ x: cx + sx * d, y: cy + sy * d })
    return { kind, x: p.x, y: p.y }
  }
  return [
    at('radius-tl', r.tl, 0, 0, 1, 1),
    at('radius-tr', r.tr, w, 0, -1, 1),
    at('radius-br', r.br, w, h, -1, -1),
    at('radius-bl', r.bl, 0, h, 1, -1),
  ]
}

export function hitCornerHandle(handles: CornerHandle[], p: Vec2): CornerHandle | null {
  for (const h of handles) {
    if (Math.hypot(p.x - h.x, p.y - h.y) <= CORNER_HANDLE_PAD) return h
  }
  return null
}

/** The corner's own point and inward diagonal, in the node's local space. */
export function cornerAnchor(node: SceneNode, kind: CornerKind): { corner: Vec2; sx: number; sy: number } {
  const w = 'width' in node ? node.width : 0
  const h = 'height' in node ? node.height : 0
  switch (kind) {
    case 'radius-tl':
      return { corner: { x: 0, y: 0 }, sx: 1, sy: 1 }
    case 'radius-tr':
      return { corner: { x: w, y: 0 }, sx: -1, sy: 1 }
    case 'radius-br':
      return { corner: { x: w, y: h }, sx: -1, sy: -1 }
    case 'radius-bl':
      return { corner: { x: 0, y: h }, sx: 1, sy: -1 }
  }
}

/** Radius implied by a node-local pointer position, projected on the diagonal. */
export function cornerRadiusFromLocal(node: SceneNode, kind: CornerKind, p: Vec2): number {
  const { corner, sx, sy } = cornerAnchor(node, kind)
  const w = 'width' in node ? node.width : 0
  const h = 'height' in node ? node.height : 0
  // Project onto the 45° diagonal: (dx + dy) / 2 is the distance along it, so a
  // drag that is not exactly diagonal still feels linear.
  const dx = (p.x - corner.x) * sx
  const dy = (p.y - corner.y) * sy
  return Math.max(0, Math.min((dx + dy) / 2, Math.min(w, h) / 2))
}

export const CORNER_KEYS: Record<CornerKind, 'tl' | 'tr' | 'br' | 'bl'> = {
  'radius-tl': 'tl',
  'radius-tr': 'tr',
  'radius-br': 'br',
  'radius-bl': 'bl',
}

function drawCornerHandles(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  node: SceneNode,
  state: OverlayState,
): void {
  if (!('cornerRadius' in node)) return
  const dragging = state.cornerDrag ?? null
  const handles = cornerHandles(scene, node, state.camera)
  for (const h of handles) {
    ctx.beginPath()
    ctx.arc(h.x, h.y, h.kind === dragging ? CORNER_HANDLE_R + 1.5 : CORNER_HANDLE_R, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1.5
    ctx.fill()
    ctx.stroke()
  }
  if (!dragging) return
  const h = handles.find((x) => x.kind === dragging)
  if (h) drawChip(ctx, h.x, h.y - 24, `${Math.round(node.cornerRadius[CORNER_KEYS[dragging]])}`)
}

/**
 * The rotate knob: a stem out past the top edge, ending in a filled round
 * handle. Round and filled so it cannot be read as one more white resize
 * square — a different shape for a different verb. While the drag is live it
 * carries the angle, the same number the inspector's Rotation field shows.
 */
function drawRotateKnob(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  box: Vec2[],
  handles: Handle[],
  state: OverlayState,
): void {
  const knob = handles.find((h) => h.kind === 'rotate')
  if (!knob) return
  const topMid = mid(box[0], box[1])
  const up = unit({ x: knob.x - topMid.x, y: knob.y - topMid.y })
  // Start clear of the 'n' resize square rather than through it.
  const from = { x: topMid.x + up.x * (HANDLE_SIZE / 2 + 1), y: topMid.y + up.y * (HANDLE_SIZE / 2 + 1) }
  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(knob.x, knob.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(knob.x, knob.y, state.rotating ? ROTATE_KNOB_R + 1 : ROTATE_KNOB_R, 0, Math.PI * 2)
  ctx.fillStyle = ACCENT
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()
  if (!state.rotating) return
  // One node has an angle; a multi-selection has one per node, so it shows none
  // rather than whichever happened to be first.
  const node = state.selection.length === 1 ? scene.getNode(state.selection[0]) : null
  // Further out along the stem, not straight up the screen: on a turned shape
  // "up the screen" is over the shape itself, and a readout you have to move
  // the shape to read is no readout.
  if (node) drawChip(ctx, knob.x + up.x * 18, knob.y + up.y * 18 - 8, `${round2(node.rotation)}°`)
}

function arcChipText(node: EllipseNode, kind: ArcHandleKind): string {
  if (kind === 'arc-start') return `${Math.round((node.arcStart ?? 0) * 360)}°`
  if (kind === 'arc-sweep') return `${Math.round((node.arcSweep ?? 1) * 100)}%`
  return `Ratio ${Math.round((node.arcRatio ?? 0) * 100)}%`
}

function drawArcHandles(
  ctx: CanvasRenderingContext2D,
  scene: SceneGraph,
  node: EllipseNode,
  state: OverlayState,
): void {
  const dragging = state.arcDrag ?? null
  const handles = arcHandles(scene, node, state.camera)
  for (const h of handles) {
    ctx.beginPath()
    ctx.arc(h.x, h.y, h.kind === dragging ? ARC_HANDLE_R + 1 : ARC_HANDLE_R, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1.5
    ctx.fill()
    ctx.stroke()
  }
  if (!dragging) return
  const h = handles.find((x) => x.kind === dragging)
  if (h) drawChip(ctx, h.x, h.y - 24, arcChipText(node, dragging))
}

// ---------------------------------------------------------------------------

/** The blue readout pill: dimensions under a selection, values under a drag. */
function drawChip(ctx: CanvasRenderingContext2D, cx: number, top: number, text: string): void {
  ctx.font = '10px "Segoe UI", system-ui, sans-serif'
  const tw = ctx.measureText(text).width
  ctx.fillStyle = ACCENT
  ctx.beginPath()
  ctx.roundRect(cx - tw / 2 - 4, top, tw + 8, 16, 3)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.fillText(text, cx - tw / 2, top + 11.5)
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
    const handles = boxHandles(box, canRotate(scene, state.selection))
    for (const h of handles) {
      if (h.kind.startsWith('rotate')) continue
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1
      ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
      ctx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
    }
    drawRotateKnob(ctx, scene, box, handles, state)
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
    if (label) drawChip(ctx, cx, bottom + 6, label)

    // Ellipse arc: the two sweep ends and the inner radius, draggable.
    const arcNode = arcEditTarget(scene, state.selection)
    if (arcNode) drawArcHandles(ctx, scene, arcNode, state)

    // Corner radius: one handle per corner, each independent.
    const cornerNode = cornerEditTarget(scene, state.selection)
    if (cornerNode) drawCornerHandles(ctx, scene, cornerNode, state)
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

  // Vertices. Round, like every other vector editor: a square handle on a path
  // reads as "resize this box", which is what the transform box handles mean.
  for (const v of node.network.vertices) {
    const s = toScreen({ x: v.x, y: v.y })
    const on = selected.has(v.id)
    ctx.fillStyle = on ? ACCENT : '#ffffff'
    ctx.strokeStyle = on ? '#ffffff' : ACCENT
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(s.x, s.y, VERTEX_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}
