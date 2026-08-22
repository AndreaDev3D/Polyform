// Components & instances (roadmap 3.1). Instances are MATERIALIZED: their
// children are real scene nodes copied from the component (each tagged with
// `sourceId`), so rendering, hit-testing, layout and undo work unchanged.
// This sync pass — a derived pass like auto-layout — regenerates instance
// subtrees when the component (or the instance's overrides/size) changes.

import type { ComponentNode, InstanceNode, NodeId, SceneNode } from './types'
import { cloneNode, isContainer, newId } from './types'
import type { SceneGraph } from './scene'
import { constrainFrameChildren } from './constraints'

/** Props that may never be overridden or copied over on materialized nodes. */
const STRUCTURAL_KEYS = new Set([
  'id',
  'type',
  'children',
  'sourceId',
  'componentId',
  'overrides',
  'syncedHash',
  'origin',
])

/** Visual props an instance root inherits from its component. */
export const ROOT_INHERITED_KEYS: (keyof ComponentNode)[] = [
  'fills',
  'strokes',
  'strokeWeight',
  'strokeAlign',
  'strokeDash',
  'effects',
  'cornerRadius',
  'strokeSides',
  'clipsContent',
  'layout',
  'material',
]

export function sanitizeOverride(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props)) {
    if (!STRUCTURAL_KEYS.has(k)) out[k] = v
  }
  return out
}

export function listComponents(scene: SceneGraph): ComponentNode[] {
  return Object.values(scene.doc.nodes).filter((n): n is ComponentNode => n.type === 'COMPONENT')
}

/** Cheap stable hash (djb2 over canonical JSON). */
function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/**
 * Canonical JSON: object keys sorted, undefined-valued keys skipped. The
 * sync hash must be REPRESENTATION-independent so the TS and Rust engines
 * compute identical staleness (key insertion order is an implementation
 * detail that differs across the boundary).
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(',')}]`
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function instanceSyncHash(scene: SceneGraph, inst: InstanceNode, comp: ComponentNode): string {
  const parts: unknown[] = [comp.id, inst.width, inst.height, inst.overrides ?? {}]
  const walk = (id: NodeId) => {
    const n = scene.getNode(id)
    if (!n) return
    parts.push(n)
    if (isContainer(n)) for (const cid of n.children) walk(cid)
  }
  parts.push(comp)
  for (const cid of comp.children) walk(cid)
  return hashString(stableStringify(parts))
}

/**
 * Cycle guard: an instance must not (transitively) expand its own container
 * component. True when `componentId` appears in the instance's ancestry.
 */
function wouldCycle(scene: SceneGraph, instId: NodeId, componentId: NodeId): boolean {
  for (const aid of [instId, ...scene.ancestors(instId)]) {
    const a = scene.getNode(aid)
    if (!a) continue
    if (a.type === 'COMPONENT' && a.id === componentId) return true
    if (a.type === 'INSTANCE' && a.id !== instId && a.componentId === componentId) return true
  }
  return false
}

/**
 * Materialized-node id source. Injectable (V0.4-Porting-Plan: "newId stays
 * host-side") so differential tests — and later the worker embedding — can
 * mint deterministic ids on both engines.
 */
let mintId: () => NodeId = newId
export function setMaterializeIdFactory(factory: (() => NodeId) | null): void {
  mintId = factory ?? newId
}

function materializeInstance(scene: SceneGraph, inst: InstanceNode, comp: ComponentNode): void {
  // Map source ids -> existing materialized ids so selection stays stable.
  const existingBySource = new Map<NodeId, NodeId>()
  for (const did of scene.descendants(inst.id)) {
    const n = scene.getNode(did)
    if (n?.sourceId) existingBySource.set(n.sourceId, did)
  }
  // Tear down the current materialization (children before parents).
  const oldDescendants = scene.descendants(inst.id)
  for (let i = oldDescendants.length - 1; i >= 0; i--) {
    scene.removeNode(oldDescendants[i])
  }

  const overrides = inst.overrides ?? {}

  const build = (srcId: NodeId, parentId: NodeId, index: number): void => {
    const src = scene.getNode(srcId)
    if (!src) return
    const copy = cloneNode(src)
    copy.id = existingBySource.get(srcId) ?? mintId()
    copy.sourceId = srcId
    if (isContainer(copy)) copy.children = []
    if (copy.type === 'COMPONENT') {
      // A component nested inside another component materializes as a frame.
      ;(copy as SceneNode as { type: string }).type = 'FRAME'
    }
    if (copy.type === 'INSTANCE') {
      copy.overrides = copy.overrides ?? {}
      copy.syncedHash = undefined // force its own sync
    }
    const ov = overrides[srcId]
    if (ov) Object.assign(copy, structuredClone(sanitizeOverride(ov)))
    scene.addNode(copy, parentId, index)
    // Nested instances materialize themselves on their own sync turn.
    if (isContainer(src) && src.type !== 'INSTANCE') {
      src.children.forEach((cid, i) => build(cid, copy.id, i))
    }
  }
  comp.children.forEach((cid, i) => build(cid, inst.id, i))

  // Instance root inherits the component's visual props, then root overrides.
  const rootProps: Record<string, unknown> = {}
  for (const key of ROOT_INHERITED_KEYS) {
    rootProps[key] = structuredClone(comp[key])
  }
  Object.assign(inst, rootProps)
  const rootOv = overrides[comp.id]
  if (rootOv) Object.assign(inst, structuredClone(sanitizeOverride(rootOv)))

  // Fit component-space children to the instance's size via constraints.
  if (
    inst.layout.mode === 'NONE' &&
    (Math.abs(inst.width - comp.width) > 0.01 || Math.abs(inst.height - comp.height) > 0.01)
  ) {
    constrainFrameChildren(
      scene,
      inst,
      (childId) => {
        const child = scene.getNode(childId)
        const src = child?.sourceId ? scene.getNode(child.sourceId) : null
        if (!src) return null
        return { x: src.x, y: src.y, width: src.width, height: src.height }
      },
      comp.width,
      comp.height,
    )
  }
}

/** Regenerate stale instances. Returns true when anything changed. */
export function syncInstances(scene: SceneGraph): boolean {
  let changed = false
  for (const node of Object.values(scene.doc.nodes)) {
    if (node.type !== 'INSTANCE') continue
    if (!scene.hasNode(node.id)) continue // removed during this pass
    const comp = node.componentId ? scene.getNode(node.componentId) : null
    if (!comp || comp.type !== 'COMPONENT') continue // detached-in-place
    if (wouldCycle(scene, node.id, comp.id)) continue
    const hash = instanceSyncHash(scene, node, comp)
    if (node.syncedHash === hash) continue
    materializeInstance(scene, node, comp)
    node.syncedHash = instanceSyncHash(scene, node, comp)
    changed = true
  }
  return changed
}

/**
 * Remove nodes unreachable from any page (materialized children whose
 * instance was removed by undo, etc.). Derived cleanup, not journaled.
 */
export function collectGarbage(scene: SceneGraph): boolean {
  const reachable = new Set<NodeId>()
  const walk = (id: NodeId) => {
    if (reachable.has(id)) return
    reachable.add(id)
    const n = scene.getNode(id)
    if (n && isContainer(n)) for (const cid of n.children) walk(cid)
  }
  for (const page of scene.doc.pages) {
    for (const rid of page.rootIds) walk(rid)
  }
  let removed = false
  for (const id of Object.keys(scene.doc.nodes)) {
    if (!reachable.has(id)) {
      delete scene.doc.nodes[id]
      removed = true
    }
  }
  return removed
}
