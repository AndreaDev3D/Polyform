// Journal replay contract fixture (V0.4-Porting-Plan, API contract #2).
//
// The entries below stand in for a recorded v0.1–v0.3 journal touching every
// PatchOp kind (add/remove/update/move/page-add/page-remove/page-rename/
// styles-set), built with FIXED ids so the run is fully deterministic. The
// final document is frozen as a committed file snapshot: any engine
// implementation — TS today, Rust commands.rs when it lands — must replay
// these ops to the byte-identical document, undo back to the byte-identical
// initial state, and redo to the final state again.
//
// If this snapshot changes, either the op semantics changed (a breaking
// journal-compat event that needs a migration story) or node defaults
// changed (schema evolution — bump SCHEMA_VERSION and update docs/schema.fbs).
// Neither should ever happen as a side effect.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import {
  applyOps,
  emptyDocument,
  invertOp,
  makeUpdateOp,
  removeSubtreeOps,
  undoOps,
  type PatchOp,
} from './commands'
import { createNode, createPage } from './types'
import type { PolyformDocument, SceneNode } from './types'

function fixedNode(type: SceneNode['type'], name: string, id: string): SceneNode {
  const node = createNode(type, name)
  ;(node as { id: string }).id = id
  return node
}

/** Deterministic initial document: single page 'p1'. */
function initialDocument(): PolyformDocument {
  const doc = emptyDocument()
  doc.pages = [{ ...doc.pages[0], id: 'p1', name: 'Page 1', rootIds: [] }]
  doc.activePageId = 'p1'
  doc.nodes = {}
  return doc
}

/**
 * Build the journal against a live scene so update-op `before` values are
 * exactly what a real recording session would capture.
 */
function buildJournal(scene: SceneGraph): PatchOp[][] {
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

  // 6. register a shared color style
  const before = structuredClone(scene.doc.styles)
  const after = structuredClone(scene.doc.styles)
  after.colors.push({
    id: 'st1',
    name: 'Brand/Primary',
    paint: { type: 'SOLID', color: { r: 0.4, g: 0.2, b: 0.9, a: 1 }, visible: true, opacity: 1 },
  })
  commit([{ kind: 'styles-set', before, after }])

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

describe('journal replay contract', () => {
  it('replays to the frozen snapshot; undo and redo are exact inverses', async () => {
    const initial = initialDocument()
    const scene = new SceneGraph(structuredClone(initial))
    const entries = buildJournal(scene)

    // The build already applied every entry — freeze the final document.
    const final = structuredClone(scene.doc)
    await expect(JSON.stringify(final, null, 2)).toMatchFileSnapshot(
      '__fixtures__/journal-replay-final.json',
    )

    // Undo everything in reverse -> exactly the initial document.
    for (let i = entries.length - 1; i >= 0; i--) undoOps(scene, entries[i])
    expect(scene.doc).toEqual(initial)

    // Redo everything -> exactly the final document again.
    for (const ops of entries) applyOps(scene, ops)
    expect(scene.doc).toEqual(final)

    // Round-trip through JSON (the journal encoding) must not change ops.
    const scene2 = new SceneGraph(structuredClone(initial))
    for (const ops of entries) {
      applyOps(scene2, JSON.parse(JSON.stringify(ops)) as PatchOp[])
    }
    expect(scene2.doc).toEqual(final)

    // Double inversion is identity on every op.
    for (const ops of entries) {
      for (const op of ops) {
        expect(invertOp(invertOp(op))).toEqual(op)
      }
    }
  })
})
