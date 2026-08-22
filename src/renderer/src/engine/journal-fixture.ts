// Shared journal fixture: a deterministic op sequence touching every PatchOp
// kind, used by journal-replay.test.ts (TS contract) and scene-parity.test.ts
// (TS <-> WASM differential). Not a .test file — no tests here.

import { SceneGraph } from './scene'
import { applyOps, emptyDocument, makeUpdateOp, removeSubtreeOps, type PatchOp } from './commands'
import { createNode, createPage } from './types'
import type { PolyformDocument, SceneNode } from './types'

export function fixedNode(type: SceneNode['type'], name: string, id: string): SceneNode {
  const node = createNode(type, name)
  ;(node as { id: string }).id = id
  return node
}

/** Deterministic initial document: single page 'p1'. */
export function initialDocument(): PolyformDocument {
  const doc = emptyDocument()
  doc.pages = [{ ...doc.pages[0], id: 'p1', name: 'Page 1', rootIds: [] }]
  doc.activePageId = 'p1'
  doc.nodes = {}
  return doc
}

/**
 * Build the journal against a live scene so update-op `before` values are
 * exactly what a real recording session would capture. Applies every entry
 * to `scene` as it goes and returns the entries.
 */
export function buildJournal(scene: SceneGraph): PatchOp[][] {
  const entries: PatchOp[][] = []
  const commit = (ops: PatchOp[]) => {
    applyOps(scene, ops)
    entries.push(ops)
  }

  // 1. draw a frame with two children
  const f1 = fixedNode('FRAME', 'Frame 1', 'f1')
  f1.x = 40
  f1.y = 32
  f1.width = 400
  f1.height = 300
  const r1 = fixedNode('RECTANGLE', 'Rect 1', 'r1')
  r1.x = 10
  r1.y = 10
  r1.width = 120
  r1.height = 80
  const e1 = fixedNode('ELLIPSE', 'Ellipse 1', 'e1')
  e1.x = 150
  e1.y = 40
  e1.width = 90
  e1.height = 90
  commit([
    { kind: 'add', parentId: 'p1', index: 0, node: f1 },
    { kind: 'add', parentId: 'f1', index: 0, node: r1 },
    { kind: 'add', parentId: 'f1', index: 1, node: e1 },
  ])

  // 2. restyle the rectangle (nested-object update)
  commit([
    makeUpdateOp(scene.getNode('r1')!, {
      x: 24,
      width: 200,
      cornerRadius: { tl: 12, tr: 12, br: 0, bl: 0 },
      opacity: 0.85,
    }),
  ])

  // 3. move the ellipse out of the frame onto the page root
  commit([
    {
      kind: 'move',
      id: 'e1',
      from: { parentId: 'f1', index: 1 },
      to: { parentId: 'p1', index: 1 },
    },
  ])

  // 4. add a second page and rename it
  const p2 = { ...createPage('Page 2'), id: 'p2' }
  commit([{ kind: 'page-add', index: 1, page: p2 }])
  commit([{ kind: 'page-rename', pageId: 'p2', before: 'Page 2', after: 'Icons' }])

  // 5. add a star to the new page
  const s1 = fixedNode('STAR', 'Star 1', 's1')
  s1.x = 12
  s1.y = 12
  s1.width = 64
  s1.height = 64
  commit([{ kind: 'add', parentId: 'p2', index: 0, node: s1 }])

  // 6. register a shared color style and a shared material style — the same
  // styles-set op carries both collections, so one entry covers the wholesale
  // before/after copy for each.
  const before = structuredClone(scene.doc.styles)
  const after = structuredClone(scene.doc.styles)
  after.colors.push({
    id: 'st1',
    name: 'Brand/Primary',
    paint: { type: 'SOLID', color: { r: 0.4, g: 0.2, b: 0.9, a: 1 }, visible: true, opacity: 1 },
  })
  after.materials.push({
    id: 'mt1',
    name: 'Brushed Foil',
    shaderId: 'foil',
    uniforms: { angle: 35, bands: 6, roughness: 0.25, inset: false, tint: { r: 1, g: 0.85, b: 0.4, a: 1 } },
  })
  commit([{ kind: 'styles-set', before, after }])

  // 6b. give the ellipse a material (update-op shape for the node field)
  commit([
    {
      kind: 'update',
      id: 'e1',
      before: { material: undefined },
      after: { material: { shaderId: 'foil', uniforms: { angle: 35 } } },
    },
  ])

  // 7. delete the rectangle (subtree removal op shape)
  commit(removeSubtreeOps(scene, 'r1'))

  // 8. reorder: move the frame after the ellipse on page 1
  commit([
    {
      kind: 'move',
      id: 'f1',
      from: { parentId: 'p1', index: 0 },
      to: { parentId: 'p1', index: 1 },
    },
  ])

  // 9. drop page 2 (children first, then the page)
  commit([...removeSubtreeOps(scene, 's1'), { kind: 'page-remove', index: 1, page: p2 }])

  return entries
}
