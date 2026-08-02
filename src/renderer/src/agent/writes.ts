// Agent writes (v0.6 item 7.3, ADR-021/022).
//
// One batch = one journal entry, exactly like a human gesture (ADR-008):
// an agent-built composition undoes with a single Ctrl+Z, not thirty. The
// batch goes through the same OpRecorder as every editor command, so undo,
// redo, journal persistence and the change feed all see it for free — and
// if ANY step fails, the recorder rolls back and nothing landed.
//
// The label is the attribution: every agent commit is prefixed "Agent:",
// which the history browser renders with a distinct mark. An agent cannot
// commit unlabeled work, and cannot touch instance internals (the editor's
// own override flow is the only writer that understands those).

import { OpRecorder } from '../state/actions'
import { documentStore } from '../state/document'
import { isInsideInstance } from '../engine/hit-test'
import { hexToRgba, rgbaToHex } from '../engine/color'
import {
  createNode,
  uniformRadius,
  type GradientPaint,
  type NodeId,
  type Paint,
  type SceneNode,
} from '../engine/types'

/** Ceiling per call — a runaway agent must not build 10k nodes in one op. */
const MAX_EDITS = 100

const CREATABLE = ['RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'TEXT', 'FRAME'] as const
type CreatableType = (typeof CREATABLE)[number]

export interface EditOp {
  op: 'create' | 'update' | 'move' | 'delete'
  /** create */
  type?: string
  ref?: string
  /** update/move/delete; may be "$ref" to a node created earlier in the batch */
  id?: string
  /** create/move; may be "$ref" */
  parentId?: string | null
  /** create/move: z-position among siblings (0 = back). Omit = top. */
  index?: number
  /** create/update: writable properties (validated per key) */
  props?: Record<string, unknown>
}

interface GradientSpec {
  gradient: 'LINEAR' | 'RADIAL'
  stops: { at: number; color: string }[]
  start?: { x: number; y: number }
  end?: { x: number; y: number }
}

function parseColor(value: unknown, where: string): Paint {
  if (typeof value === 'string') {
    const hex = value.trim()
    // #RRGGBB or #RRGGBBAA
    const alpha = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1
    const rgba = hexToRgba(hex.slice(0, 7), alpha)
    if (!rgba) throw new Error(`${where}: not a hex colour: ${JSON.stringify(value)}`)
    return { type: 'SOLID', visible: true, opacity: 1, color: rgba }
  }
  const g = value as GradientSpec
  if (g && (g.gradient === 'LINEAR' || g.gradient === 'RADIAL') && Array.isArray(g.stops)) {
    if (g.stops.length < 2 || g.stops.length > 8) {
      throw new Error(`${where}: gradients need 2–8 stops`)
    }
    const stops = g.stops.map((s) => {
      const c = hexToRgba(String(s.color).slice(0, 7), String(s.color).length === 9 ? parseInt(String(s.color).slice(7, 9), 16) / 255 : 1)
      if (!c || !Number.isFinite(s.at)) throw new Error(`${where}: bad gradient stop`)
      return { position: Math.max(0, Math.min(1, s.at)), color: c }
    })
    const paint: GradientPaint = {
      type: g.gradient === 'LINEAR' ? 'GRADIENT_LINEAR' : 'GRADIENT_RADIAL',
      visible: true,
      opacity: 1,
      stops,
      start: g.start && Number.isFinite(g.start.x) ? { x: g.start.x, y: g.start.y } : { x: 0.5, y: 0 },
      end: g.end && Number.isFinite(g.end.x) ? { x: g.end.x, y: g.end.y } : { x: 0.5, y: 1 },
    }
    return paint
  }
  throw new Error(`${where}: fill/stroke must be "#RRGGBB[AA]" or {gradient, stops[]}`)
}

function num(v: unknown, where: string): number {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${where}: not a finite number`)
  return n
}

/**
 * Translate the wire props into a validated node patch. Whitelist, never
 * passthrough: id/type/children and the component linkage fields must be
 * unreachable no matter what arrives.
 */
function sanitize(props: Record<string, unknown>, where: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    switch (key) {
      case 'name':
        out.name = String(value).slice(0, 120)
        break
      case 'x':
      case 'y':
      case 'rotation':
      case 'strokeWeight':
      case 'fontSize':
      case 'lineHeight':
      case 'letterSpacing':
        out[key] = num(value, `${where}.${key}`)
        break
      case 'width':
      case 'height':
        out[key] = Math.max(0.01, num(value, `${where}.${key}`))
        break
      case 'opacity': {
        out.opacity = Math.max(0, Math.min(1, num(value, `${where}.opacity`)))
        break
      }
      case 'visible':
      case 'locked':
      case 'italic':
      case 'clipsContent':
        out[key] = Boolean(value)
        break
      case 'blendMode':
        out.blendMode = String(value)
        break
      case 'cornerRadius':
        out.cornerRadius = uniformRadius(Math.max(0, num(value, `${where}.cornerRadius`)))
        break
      case 'fill':
        out.fills = value === null ? [] : [parseColor(value, `${where}.fill`)]
        break
      case 'stroke':
        out.strokes = value === null ? [] : [parseColor(value, `${where}.stroke`)]
        break
      case 'strokeAlign':
        out.strokeAlign = String(value)
        break
      case 'strokeDash':
        out.strokeDash = Array.isArray(value) ? value.map((d) => num(d, `${where}.strokeDash`)) : []
        break
      case 'characters':
        out.characters = String(value).slice(0, 5000)
        break
      case 'fontFamily':
        out.fontFamily = String(value).slice(0, 80)
        break
      case 'fontWeight':
        out.fontWeight = Math.max(100, Math.min(1000, num(value, `${where}.fontWeight`)))
        break
      case 'textAlignH':
      case 'textAlignV':
        out[key] = String(value)
        break
      case 'pointCount':
        out.pointCount = Math.max(3, Math.min(60, Math.trunc(num(value, `${where}.pointCount`))))
        break
      case 'innerRatio':
        out.innerRatio = Math.max(0.05, Math.min(1, num(value, `${where}.innerRatio`)))
        break
      default:
        throw new Error(`${where}: "${key}" is not a writable property`)
    }
  }
  return out
}

/** Where agents may create/move nodes: the page root or a frame-like. */
function checkParent(scene: typeof documentStore.scene, parentId: NodeId | null, where: string): void {
  if (parentId === null) return
  const parent = scene.getNode(parentId)
  if (!parent) throw new Error(`${where}: no node with id ${JSON.stringify(parentId)}`)
  if (parent.type !== 'FRAME' && parent.type !== 'COMPONENT') {
    throw new Error(
      `${where}: nodes can be placed at the page root or inside a FRAME/COMPONENT, not ${parent.type}`,
    )
  }
  if (isInsideInstance(scene, parentId)) {
    throw new Error(`${where}: cannot edit inside an instance — edit its main component instead`)
  }
}

export interface EditResult {
  committed: string
  created: Record<string, { id: NodeId; name: string; type: string }>
  edits: number
  /** Journal position after the commit — feed it to poll_changes. */
  cursor: number
}

/** Execute a batch atomically; commit as ONE agent-attributed entry. */
export function applyEdits(rawEdits: unknown, rawLabel: unknown): EditResult {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) throw new Error('edits must be a non-empty array')
  if (rawEdits.length > MAX_EDITS) {
    throw new Error(`too many edits in one call (${rawEdits.length} > ${MAX_EDITS}) — split the batch`)
  }
  const label = String(rawLabel ?? '').trim().slice(0, 60)
  if (!label) throw new Error('label is required — it names the undo entry the user sees')

  const scene = documentStore.scene
  const rec = new OpRecorder()
  const refs = new Map<string, NodeId>()
  const created: EditResult['created'] = {}

  const resolve = (id: string, where: string): NodeId => {
    if (id.startsWith('$')) {
      const hit = refs.get(id.slice(1))
      if (!hit) throw new Error(`${where}: unknown ref ${JSON.stringify(id)} — refs come from earlier creates in the SAME call`)
      return hit
    }
    return id
  }

  try {
    rawEdits.forEach((raw, i) => {
      const edit = raw as EditOp
      const where = `edits[${i}]`
      switch (edit.op) {
        case 'create': {
          const type = String(edit.type ?? '')
          if (!(CREATABLE as readonly string[]).includes(type)) {
            throw new Error(`${where}: type must be one of ${CREATABLE.join(', ')}`)
          }
          const parentId = edit.parentId == null ? null : resolve(String(edit.parentId), where)
          checkParent(scene, parentId, where)
          const patch = sanitize(edit.props ?? {}, where)
          const node = createNode(type as CreatableType, String(patch.name ?? type.toLowerCase()))
          delete patch.name
          Object.assign(node, patch, { name: node.name })
          const siblings = scene.childListOf(parentId).length
          const index = edit.index == null ? siblings : Math.max(0, Math.min(siblings, Math.trunc(edit.index)))
          rec.add(node as SceneNode, parentId, index)
          if (edit.ref) {
            if (refs.has(edit.ref)) throw new Error(`${where}: duplicate ref ${JSON.stringify(edit.ref)}`)
            refs.set(edit.ref, node.id)
          }
          created[edit.ref ?? node.id] = { id: node.id, name: node.name, type }
          break
        }
        case 'update': {
          const id = resolve(String(edit.id ?? ''), where)
          const node = scene.getNode(id)
          if (!node) throw new Error(`${where}: no node with id ${JSON.stringify(id)}`)
          if (isInsideInstance(scene, id)) {
            throw new Error(`${where}: cannot edit inside an instance — edit its main component instead`)
          }
          rec.update(id, sanitize(edit.props ?? {}, where))
          break
        }
        case 'move': {
          const id = resolve(String(edit.id ?? ''), where)
          if (!scene.getNode(id)) throw new Error(`${where}: no node with id ${JSON.stringify(id)}`)
          if (isInsideInstance(scene, id)) throw new Error(`${where}: cannot move instance internals`)
          const parentId = edit.parentId == null ? null : resolve(String(edit.parentId), where)
          checkParent(scene, parentId, where)
          const siblings = scene.childListOf(parentId).length
          const index = edit.index == null ? siblings : Math.max(0, Math.min(siblings, Math.trunc(edit.index)))
          rec.move(id, parentId, index)
          break
        }
        case 'delete': {
          const id = resolve(String(edit.id ?? ''), where)
          if (!scene.getNode(id)) throw new Error(`${where}: no node with id ${JSON.stringify(id)}`)
          if (isInsideInstance(scene, id)) {
            throw new Error(`${where}: cannot delete instance internals — detach or edit the component`)
          }
          rec.removeSubtree(id)
          break
        }
        default:
          throw new Error(`${where}: op must be create | update | move | delete`)
      }
    })
  } catch (err) {
    // All or nothing: a half-landed batch is worse than a failed one.
    rec.rollback()
    throw err
  }

  rec.commit(`Agent: ${label}`)
  return {
    committed: `Agent: ${label}`,
    created,
    edits: rawEdits.length,
    cursor: documentStore.history.entriesApplied().length,
  }
}

// Re-export for the bridge's colour rendering of created nodes.
export { rgbaToHex }
